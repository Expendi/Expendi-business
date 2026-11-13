import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { CardAction } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Card } from "../../db/schema/index.js";
import type { DbScope, Transaction } from "../../db/scope.js";
import type {
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Lithic, LithicCardPatch } from "../lithic/lithic-client.js";
import type { CardView } from "./views.js";
import { cards, payees, recurringItems } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";
import { resolveAlert } from "../alerts/ops-alerts.js";
import { AuditLog } from "../audit/audit-log.js";
import { hasNotEndedForCardsSql } from "../recurring/card-paid-state.js";
import { exclusively, issuerFailure, requireIssuer } from "./issuer.js";
import { cardNotFound, getCard, visibleCards } from "./views.js";

/**
 * Changing a card (spec §6.25). The issuer goes first, outside any
 * transaction, then our record; the card's session lock keeps the two in step
 * when two people act at once. Raising a limit and unfreezing go through a
 * passkey (`confirmations.ts`); freezing, closing and lowering a limit don't,
 * because each only takes spending power away.
 */

/** The attempts after which a stuck close raises an ops alert. */
export const CLOSE_ALERT_ATTEMPTS = 5;

type ManageDeps = DatabaseService | AuditLog | Lithic;
type ManageError =
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError;

export const cardLock = (cardId: string): string => `card:${cardId}`;

const cardClosed = new Conflict({ message: "This card is closed." });
const cardClosing = new Conflict({ message: "This card is being closed." });

export const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

/** The card with its issuer token: for the API's own use, never a response. */
export function readCardRow(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<Card, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select()
        .from(cards)
        .where(and(visibleCards(tenant), eq(cards.id, cardId)))
        .limit(1),
    ),
  ).pipe(
    Effect.flatMap(([card]) =>
      card ? Effect.succeed(card) : Effect.fail(cardNotFound),
    ),
  );
}

export function refuseIfClosed(card: Card): Effect.Effect<void, Conflict> {
  if (card.state === "closed") return Effect.fail(cardClosed);
  return card.closeRequestedAt ? Effect.fail(cardClosing) : Effect.void;
}

interface CardChange {
  readonly issuer: LithicCardPatch;
  readonly row: Partial<typeof cards.$inferInsert>;
  readonly action: string;
  readonly before: unknown;
  readonly after: unknown;
}

function applyChange(
  tenant: Tenant,
  card: Card,
  change: CardChange,
): Effect.Effect<void, ManageError, ManageDeps> {
  return Effect.gen(function* () {
    const lithic = yield* requireIssuer;
    const audit = yield* AuditLog;
    yield* lithic
      .updateCard(card.lithicCardToken, change.issuer)
      .pipe(
        Effect.catchTag("LithicError", (error) =>
          Effect.fail(issuerFailure(error)),
        ),
      );
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .update(cards)
            .set(change.row)
            .where(
              and(
                eq(cards.id, card.id),
                eq(cards.organizationId, tenant.organizationId),
              ),
            ),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: change.action,
          entity: { type: "card", id: card.id },
          before: change.before,
          after: change.after,
        });
      }),
    );
  });
}

/** Admins, or the person holding the card; employees can't see anyone else's. */
export function freezeCard(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<CardView, ManageError, ManageDeps> {
  return exclusively(
    cardLock(cardId),
    Effect.gen(function* () {
      const card = yield* readCardRow(tenant, cardId);
      yield* refuseIfClosed(card);
      if (card.state === "open") {
        yield* applyChange(tenant, card, {
          issuer: { state: "PAUSED" },
          row: { state: "frozen" },
          action: "card.frozen",
          before: { state: card.state },
          after: { state: "frozen" },
        });
      }
      return yield* getCard(tenant, cardId);
    }),
  );
}

/** Closes the card at the issuer and records it, by `actor`, in `scope`. */
export function closeAtIssuer(
  scope: DbScope & { readonly organizationId: string },
  card: Card,
  actor: AuditActor,
): Effect.Effect<void, ManageError, ManageDeps> {
  return Effect.gen(function* () {
    const lithic = yield* requireIssuer;
    const audit = yield* AuditLog;
    yield* lithic
      .updateCard(card.lithicCardToken, { state: "CLOSED" })
      .pipe(
        Effect.catchTag("LithicError", (error) =>
          Effect.fail(issuerFailure(error)),
        ),
      );
    yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        yield* query(() =>
          tx
            .update(cards)
            .set({ state: "closed", closedAt: new Date() })
            .where(
              and(
                eq(cards.id, card.id),
                eq(cards.organizationId, scope.organizationId),
              ),
            ),
        );
        yield* audit.record(tx, {
          actor,
          organizationId: scope.organizationId,
          action: "card.closed",
          entity: { type: "card", id: card.id },
          before: { state: card.state },
          after: { state: "closed", closeAttempts: card.closeAttempts },
        });
      }),
    );
    if (card.closeAttempts >= CLOSE_ALERT_ATTEMPTS) {
      yield* resolveAlert("card_close_failed", card.id);
    }
  });
}

/** "A", "A and B", "A, B and C". */
function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/**
 * What frees the card of each payment still on it: one that can still be
 * changed moves to another card or way of paying; one whose schedule ended
 * can't be changed, so only settling its last bill lets it go.
 */
function stillPaysMessage(
  payments: readonly { payeeName: string; nextDueOn: string | null }[],
): string {
  const running = payments.filter((payment) => payment.nextDueOn !== null);
  const lastBillsOwed = payments.filter(
    (payment) => payment.nextDueOn === null,
  );
  return [
    ...(running.length === 0
      ? []
      : [
          `This card still pays ${listed(running.map((payment) => payment.payeeName))}. Move its recurring payments to another card or another way of paying first.`,
        ]),
    ...lastBillsOwed.map(
      (payment) =>
        `${payment.payeeName}'s last bill is still owed: pay it, mark it paid or cancel it first.`,
    ),
  ].join(" ");
}

/**
 * A company-held card can't close while a recurring payment that hasn't
 * ended, paused or not, still uses it: its merchant would start being
 * declined with nobody told why (spec §6.25).
 */
function refuseCloseWhilePaying(
  tx: Transaction,
  tenant: Tenant,
  card: Card,
): Effect.Effect<void, Conflict | DatabaseError> {
  return query(() =>
    tx
      .select({
        payeeName: payees.name,
        nextDueOn: recurringItems.nextDueOn,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, tenant.organizationId),
          eq(recurringItems.cardId, card.id),
          hasNotEndedForCardsSql(),
        ),
      )
      .orderBy(asc(recurringItems.createdAt), asc(recurringItems.id)),
  ).pipe(
    Effect.flatMap((payments) =>
      payments.length === 0
        ? Effect.void
        : Effect.fail(new Conflict({ message: stillPaysMessage(payments) })),
    ),
  );
}

/**
 * Asks for a company-held card's close, in one transaction holding its row
 * for update: no recurring payment can take the card between the check and
 * the request (`lockPayingCard` waits on the row, then sees the request).
 * Lithic is called afterwards; if it fails, the card stays asked to close
 * and the close-cards job finishes it, as for a leaver's.
 */
function requestCompanyCardClose(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<
  Card,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [card] = yield* query(() =>
        tx
          .select()
          .from(cards)
          .where(and(visibleCards(tenant), eq(cards.id, cardId)))
          .for("update"),
      );
      if (!card) return yield* Effect.fail(cardNotFound);
      if (card.state === "closed" || card.closeRequestedAt !== null) {
        return card;
      }
      yield* refuseCloseWhilePaying(tx, tenant, card);
      const [requested] = yield* query(() =>
        tx
          .update(cards)
          .set({ closeRequestedAt: new Date() })
          .where(eq(cards.id, card.id))
          .returning(),
      );
      if (!requested)
        return yield* Effect.dieMessage("close request wrote no row");
      yield* audit.record(tx, {
        actor: userActor(tenant),
        organizationId: tenant.organizationId,
        action: "card.close_requested",
        entity: { type: "card", id: card.id },
      });
      return requested;
    }),
  );
}

/** Admins only; closing again answers with the card as it is. */
export function closeCard(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<CardView, ManageError, ManageDeps> {
  return exclusively(
    cardLock(cardId),
    Effect.gen(function* () {
      const read = yield* readCardRow(tenant, cardId);
      const card = read.companyHeld
        ? yield* requestCompanyCardClose(tenant, cardId)
        : read;
      if (card.state !== "closed") {
        yield* closeAtIssuer(tenant, card, userActor(tenant));
      }
      return yield* getCard(tenant, cardId);
    }),
  );
}

/** Needs no passkey, so it can only go down. */
export function lowerCardLimit(
  tenant: Tenant,
  cardId: string,
  monthlyLimitUsdCents: bigint,
): Effect.Effect<CardView, ManageError, ManageDeps> {
  return exclusively(
    cardLock(cardId),
    Effect.gen(function* () {
      const card = yield* readCardRow(tenant, cardId);
      yield* refuseIfClosed(card);
      if (monthlyLimitUsdCents >= card.monthlyLimitUsdCents) {
        return yield* Effect.fail(
          new BadRequest({
            message:
              "This can only lower the limit. Raising it needs your passkey.",
          }),
        );
      }
      yield* applyChange(tenant, card, {
        issuer: { monthlyLimitUsdCents },
        row: { monthlyLimitUsdCents },
        action: "card.limit_lowered",
        before: { monthlyLimitUsdCents: card.monthlyLimitUsdCents },
        after: { monthlyLimitUsdCents },
      });
      return yield* getCard(tenant, cardId);
    }),
  );
}

type RaiseLimit = Extract<CardAction, { type: "raise_limit" }>;

const notAbove = new BadRequest({
  message: "That isn't above this card's limit.",
});

/** Refuses a raise that can't happen; run before the passkey and again after. */
export function checkRaise(
  tenant: Tenant,
  action: RaiseLimit,
): Effect.Effect<
  Card,
  Conflict | BadRequest | NotFound | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const card = yield* readCardRow(tenant, action.cardId);
    yield* refuseIfClosed(card);
    if (action.monthlyLimitUsd <= card.monthlyLimitUsdCents) {
      return yield* Effect.fail(notAbove);
    }
    return card;
  });
}

export function raiseCardLimit(
  tenant: Tenant,
  action: RaiseLimit,
  approvalId: string,
): Effect.Effect<CardView, ManageError, ManageDeps> {
  return exclusively(
    cardLock(action.cardId),
    Effect.gen(function* () {
      const card = yield* checkRaise(tenant, action);
      yield* applyChange(tenant, card, {
        issuer: { monthlyLimitUsdCents: action.monthlyLimitUsd },
        row: { monthlyLimitUsdCents: action.monthlyLimitUsd },
        action: "card.limit_raised",
        before: { monthlyLimitUsdCents: card.monthlyLimitUsdCents },
        after: { monthlyLimitUsdCents: action.monthlyLimitUsd, approvalId },
      });
      return yield* getCard(tenant, action.cardId);
    }),
  );
}

type UnfreezeCard = Extract<CardAction, { type: "unfreeze_card" }>;

export function checkUnfreeze(
  tenant: Tenant,
  action: UnfreezeCard,
): Effect.Effect<Card, Conflict | NotFound | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const card = yield* readCardRow(tenant, action.cardId);
    yield* refuseIfClosed(card);
    if (card.state !== "frozen") {
      return yield* Effect.fail(
        new Conflict({ message: "This card isn't frozen." }),
      );
    }
    return card;
  });
}

export function unfreezeCard(
  tenant: Tenant,
  action: UnfreezeCard,
  approvalId: string,
): Effect.Effect<CardView, ManageError, ManageDeps> {
  return exclusively(
    cardLock(action.cardId),
    Effect.gen(function* () {
      const card = yield* checkUnfreeze(tenant, action);
      yield* applyChange(tenant, card, {
        issuer: { state: "OPEN" },
        row: { state: "open" },
        action: "card.unfrozen",
        before: { state: card.state },
        after: { state: "open", approvalId },
      });
      return yield* getCard(tenant, action.cardId);
    }),
  );
}
