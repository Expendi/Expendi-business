import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { CardAction, MembershipRole } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type {
  Cardholder,
  CardProgram as CardProgramRow,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, ServiceUnavailable } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { Lithic } from "../lithic/lithic-client.js";
import type { CardView } from "./views.js";
import {
  cardholders,
  cardPrograms,
  cards,
  categories,
  memberships,
  organizations,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { notify } from "../notification/notify.js";
import { accountHolderOnce, issuerFailure, requireIssuer } from "./issuer.js";
import { userActor } from "./manage.js";
import { companyControls, readCardView } from "./views.js";

type IssueCard = Extract<CardAction, { type: "issue_card" }>;

/** A holder needs a name; Lithic won't take one without both parts. */
const NO_NAME = { firstName: "Expendi", lastName: "Cardholder" } as const;

export function splitFullName(fullName: string | null): {
  readonly firstName: string;
  readonly lastName: string;
} {
  const [first, ...rest] = fullName?.trim().split(/\s+/).filter(Boolean) ?? [];
  if (!first) return NO_NAME;
  return { firstName: first, lastName: rest.join(" ") || first };
}

export const cardsNotOn = new Conflict({
  message: "Turn on cards for this company first.",
});

interface Holder {
  readonly membershipId: string;
  readonly role: MembershipRole;
  readonly email: string;
  readonly phone: string | null;
  readonly fullName: string | null;
}

const canHold = (member: {
  readonly role: MembershipRole;
  readonly status: string;
}): boolean => member.role !== "accountant" && member.status === "active";

function readEligibleHolder(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Effect.Effect<Holder, NotFound | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [member] = yield* query(() =>
      tx
        .select({
          role: memberships.role,
          status: memberships.status,
          privyUserId: users.privyUserId,
          email: users.email,
          phone: users.phone,
          fullName: users.fullName,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.id, membershipId),
          ),
        )
        .limit(1),
    );
    if (!member) {
      return yield* Effect.fail(
        new NotFound({ message: "That person isn't in this company." }),
      );
    }
    const who = member.fullName ?? member.email;
    if (member.status !== "active") {
      return yield* Effect.fail(
        new Conflict({
          message: `${who} isn't an active member of the company, so they can't hold a card.`,
        }),
      );
    }
    if (member.role === "accountant") {
      return yield* Effect.fail(
        new Conflict({ message: "Accountants can't hold a card." }),
      );
    }
    if (member.privyUserId === null) {
      return yield* Effect.fail(
        new Conflict({
          message: `${who} hasn't signed in yet, so they can't hold a card.`,
        }),
      );
    }
    return {
      membershipId,
      role: member.role,
      email: member.email,
      phone: member.phone,
      fullName: member.fullName,
    };
  });
}

export interface IssuePlan {
  readonly program: CardProgramRow;
  readonly holder: Holder;
}

/**
 * What any new card needs: cards turned on, no pause, and a default
 * category the company still uses. Returns the card program.
 */
export function checkNewCard(
  tx: Transaction,
  organizationId: string,
  defaultCategoryId: string,
): Effect.Effect<CardProgramRow, BadRequest | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [program] = yield* query(() =>
      tx
        .select()
        .from(cardPrograms)
        .where(eq(cardPrograms.organizationId, organizationId))
        .limit(1),
    );
    if (!program) return yield* Effect.fail(cardsNotOn);

    const { paused } = yield* companyControls(tx, organizationId);
    if (paused) {
      return yield* Effect.fail(
        new Conflict({
          message: "New cards are paused right now. Nothing was issued.",
        }),
      );
    }

    const [category] = yield* query(() =>
      tx
        .select({ archived: categories.archived })
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, organizationId),
            eq(categories.id, defaultCategoryId),
          ),
        )
        .limit(1),
    );
    if (!category || category.archived) {
      return yield* Effect.fail(
        new BadRequest({
          message: "Pick one of the company's categories.",
        }),
      );
    }
    return program;
  });
}

/** Refuses a card that can't be issued; run before the passkey and again after. */
export function checkIssue(
  tenant: Tenant,
  action: IssueCard,
): Effect.Effect<
  IssuePlan,
  BadRequest | NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Lithic
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    yield* requireIssuer;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const program = yield* checkNewCard(
          tx,
          organizationId,
          action.defaultCategoryId,
        );
        const holder = yield* readEligibleHolder(
          tx,
          organizationId,
          action.membershipId,
        );
        return { program, holder };
      }),
    );
  });
}

function readCardholder(tx: Transaction, membershipId: string) {
  return query(() =>
    tx
      .select()
      .from(cardholders)
      .where(eq(cardholders.membershipId, membershipId))
      .limit(1),
  ).pipe(Effect.map(([row]) => row ?? null));
}

/** The member's cardholder, created at Lithic the first time they get a card. */
function cardholderFor(
  tenant: Tenant,
  { program, holder }: IssuePlan,
): Effect.Effect<
  Cardholder,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | Lithic
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const existing = yield* withScope(tenant, (tx) =>
      readCardholder(tx, holder.membershipId),
    );
    if (existing) return existing;

    const externalId = `member:${holder.membershipId}`;
    const atIssuer = yield* accountHolderOnce(externalId, (lithic) =>
      lithic.createCardholder({
        externalId,
        businessAccountToken: program.lithicAccountToken,
        ...splitFullName(holder.fullName),
        email: holder.email,
        phone: holder.phone ?? program.phone,
        address: {
          addressLine1: program.addressLine1,
          city: program.city,
          postalCode: program.postalCode,
        },
      }),
    ).pipe(
      Effect.catchTag("LithicError", (error) =>
        Effect.fail(issuerFailure(error)),
      ),
    );

    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .insert(cardholders)
            .values({
              organizationId,
              membershipId: holder.membershipId,
              lithicAccountHolderToken: atIssuer.token,
              lithicAccountToken: atIssuer.accountToken,
            })
            .onConflictDoNothing({ target: cardholders.membershipId }),
        );
        const row = yield* readCardholder(tx, holder.membershipId);
        return row ?? (yield* Effect.dieMessage("cardholder vanished"));
      }),
    );
  });
}

/**
 * Creates the card at Lithic, then records it, with its audit entry and the
 * holder's notification, in one transaction. A removal takes the company row
 * lock while it marks the person's cards for closing, so this takes the same
 * lock: a card issued as they leave is still marked and the job closes it.
 */
export function issueCard(
  tenant: Tenant,
  action: IssueCard,
  approvalId: string,
): Effect.Effect<
  CardView,
  BadRequest | NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const plan = yield* checkIssue(tenant, action);
    const cardholder = yield* cardholderFor(tenant, plan);
    const lithic = yield* requireIssuer;
    const created = yield* lithic
      .createCard({
        accountToken: cardholder.lithicAccountToken,
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
        yield* query(() =>
          tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, organizationId))
            .for("update"),
        );
        const [member] = yield* query(() =>
          tx
            .select({ role: memberships.role, status: memberships.status })
            .from(memberships)
            .where(eq(memberships.id, action.membershipId))
            .limit(1),
        );
        const stillAMember = member !== undefined && canHold(member);

        const [card] = yield* query(() =>
          tx
            .insert(cards)
            .values({
              organizationId,
              cardholderId: cardholder.id,
              membershipId: action.membershipId,
              lithicCardToken: created.token,
              nickname: action.nickname,
              lastFour: created.lastFour,
              monthlyLimitUsdCents: action.monthlyLimitUsd,
              defaultCategoryId: action.defaultCategoryId,
              issuedBy: tenant.userId,
              closeRequestedAt: stillAMember ? null : new Date(),
            })
            .returning({ id: cards.id }),
        );
        if (!card)
          return yield* Effect.dieMessage("card insert returned no row");

        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "card.issued",
          entity: { type: "card", id: card.id },
          after: {
            membershipId: action.membershipId,
            nickname: action.nickname,
            lastFour: created.lastFour,
            monthlyLimitUsdCents: action.monthlyLimitUsd,
            defaultCategoryId: action.defaultCategoryId,
            selfIssued: action.membershipId === tenant.membershipId,
            approvalId,
          },
        });
        if (stillAMember) {
          yield* notify(tx, {
            kind: "card_issued",
            organizationId,
            cardId: card.id,
          });
        }
        return yield* readCardView(tx, tenant, card.id);
      }),
    );
  });
}
