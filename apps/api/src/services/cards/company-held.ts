import { Effect } from "effect";

import type { CardAction } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CardProgram as CardProgramRow } from "../../db/schema/index.js";
import type {
  BadRequest,
  Conflict,
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Lithic } from "../lithic/lithic-client.js";
import type { CardView } from "./views.js";
import { cards } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { checkNewCard } from "./issue.js";
import { issuerFailure, requireIssuer } from "./issuer.js";
import { userActor } from "./manage.js";
import { readCardView } from "./views.js";

/**
 * Company-held cards (spec §6.20, §6.25): issued on the company's own
 * account at Lithic, with no cardholder, so nobody leaving closes one. They
 * pay recurring payments, and any admin manages them; closing one is
 * guarded in `manage.ts`.
 */

type IssueCompanyCard = Extract<CardAction, { type: "issue_company_card" }>;

/** Refuses a card that can't be issued; run before the passkey and again after. */
export function checkIssueCompanyCard(
  tenant: Tenant,
  action: IssueCompanyCard,
): Effect.Effect<
  CardProgramRow,
  BadRequest | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Lithic
> {
  return Effect.gen(function* () {
    yield* requireIssuer;
    return yield* withScope(tenant, (tx) =>
      checkNewCard(tx, tenant.organizationId, action.defaultCategoryId),
    );
  });
}

/**
 * Creates the card at Lithic on the company's own account, then records it
 * with its audit entry. Nobody is told about a new card: nobody holds it.
 */
export function issueCompanyCard(
  tenant: Tenant,
  action: IssueCompanyCard,
  approvalId: string,
): Effect.Effect<
  CardView,
  BadRequest | NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const program = yield* checkIssueCompanyCard(tenant, action);
    const lithic = yield* requireIssuer;
    const created = yield* lithic
      .createCard({
        accountToken: program.lithicAccountToken,
        memo: action.nickname,
        monthlyLimitUsdCents: action.monthlyLimitUsd,
      })
      .pipe(
        Effect.catchTag("LithicError", (error) =>
          Effect.fail(issuerFailure(error)),
        ),
      );
    const audit = yield* AuditLog;

    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const [card] = yield* query(() =>
          tx
            .insert(cards)
            .values({
              organizationId,
              companyHeld: true,
              cardholderId: null,
              membershipId: null,
              lithicCardToken: created.token,
              nickname: action.nickname,
              lastFour: created.lastFour,
              monthlyLimitUsdCents: action.monthlyLimitUsd,
              defaultCategoryId: action.defaultCategoryId,
              issuedBy: tenant.userId,
            })
            .returning({ id: cards.id }),
        );
        if (!card) {
          return yield* Effect.dieMessage("card insert returned no row");
        }
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "card.issued",
          entity: { type: "card", id: card.id },
          after: {
            companyHeld: true,
            nickname: action.nickname,
            lastFour: created.lastFour,
            monthlyLimitUsdCents: action.monthlyLimitUsd,
            defaultCategoryId: action.defaultCategoryId,
            approvalId,
          },
        });
        return yield* readCardView(tx, tenant, card.id);
      }),
    );
  });
}
