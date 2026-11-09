import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { TurnOnCardsFields } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Lithic } from "../lithic/lithic-client.js";
import type { CardProgramView } from "./views.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { cardPrograms, paidFromAccounts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, DatabaseError } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { accountHolderOnce, issuerFailure, requireIssuer } from "./issuer.js";
import { programOn } from "./views.js";

/**
 * "Turn on cards" (spec §6.25): once per company, by an admin. Creates the
 * company's business at Lithic, then records the program with the
 * paid-from account every Card expense uses; the accountant maps that one
 * account to Zoho.
 */

const CARDS_ACCOUNT_NAME = "Expendi cards";
const PROGRAM_UNIQUE = "card_programs_organization_unique";

const alreadyOn = new Conflict({
  message: "Cards are already on for this company.",
});

function cardsAccountId(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<string, DatabaseError> {
  return Effect.gen(function* () {
    const [existing] = yield* query(() =>
      tx
        .select({ id: paidFromAccounts.id })
        .from(paidFromAccounts)
        .where(
          and(
            eq(paidFromAccounts.organizationId, organizationId),
            eq(paidFromAccounts.archived, false),
            sql`lower(${paidFromAccounts.name}) = lower(${CARDS_ACCOUNT_NAME})`,
          ),
        )
        .limit(1),
    );
    if (existing) return existing.id;
    const [created] = yield* query(() =>
      tx
        .insert(paidFromAccounts)
        .values({ organizationId, name: CARDS_ACCOUNT_NAME, kind: "card" })
        .returning({ id: paidFromAccounts.id }),
    );
    return created
      ? created.id
      : yield* Effect.dieMessage("paid-from account insert returned no row");
  });
}

export function turnOnCards(
  tenant: Tenant,
  fields: TurnOnCardsFields,
): Effect.Effect<
  Extract<CardProgramView, { status: "on" }>,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* requireIssuer;
    const [existing] = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ id: cardPrograms.id })
          .from(cardPrograms)
          .where(eq(cardPrograms.organizationId, organizationId))
          .limit(1),
      ),
    );
    if (existing) return yield* Effect.fail(alreadyOn);

    const business = yield* accountHolderOnce(
      `org:${organizationId}`,
      (lithic) =>
        lithic.createBusiness({
          externalId: `org:${organizationId}`,
          legalName: fields.legalName,
          kraPin: fields.kraPin,
          phone: fields.phone,
          address: {
            addressLine1: fields.addressLine1,
            city: fields.city,
            postalCode: fields.postalCode,
          },
          contact: {
            firstName: fields.contactFirstName,
            lastName: fields.contactLastName,
            email: fields.contactEmail,
            phone: fields.contactPhone,
          },
        }),
    ).pipe(
      Effect.catchTag("LithicError", (error) =>
        Effect.fail(issuerFailure(error)),
      ),
    );

    const audit = yield* AuditLog;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const paidFromAccountId = yield* cardsAccountId(tx, organizationId);
        const [program] = yield* query(() =>
          tx
            .insert(cardPrograms)
            .values({
              organizationId,
              legalName: fields.legalName,
              kraPin: fields.kraPin,
              addressLine1: fields.addressLine1,
              city: fields.city,
              postalCode: fields.postalCode,
              phone: fields.phone,
              contactFirstName: fields.contactFirstName,
              contactLastName: fields.contactLastName,
              contactEmail: fields.contactEmail,
              contactPhone: fields.contactPhone,
              lithicAccountHolderToken: business.token,
              lithicAccountToken: business.accountToken,
              paidFromAccountId,
              turnedOnBy: tenant.userId,
            })
            .returning(),
        );
        if (!program) {
          return yield* Effect.dieMessage(
            "card program insert returned no row",
          );
        }
        yield* audit.record(tx, {
          actor: { type: "user", id: tenant.userId },
          organizationId,
          action: "card_program.turned_on",
          entity: { type: "card_program", id: program.id },
          after: { legalName: program.legalName, paidFromAccountId },
        });
        return yield* programOn(tx, program);
      }),
    ).pipe(
      Effect.catchIf(
        (error) =>
          error instanceof DatabaseError &&
          violatedUniqueConstraint(error.cause) === PROGRAM_UNIQUE,
        () => Effect.fail(alreadyOn),
      ),
    );
  });
}
