import { randomUUID } from "node:crypto";
import { and, asc, count, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { Effect, Either } from "effect";

import type { CardSimulationResult } from "@expendi-business/shared";
import {
  DATED_BILL_STATUSES,
  formatUsdCents,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { LithicError } from "../lithic/lithic-client.js";
import type { PretendMerchant } from "./pretend-merchant.js";
import {
  bills,
  cards,
  cardSimulations,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { exclusively } from "../cards/issuer.js";
import { hasEndedForCardsSql } from "../recurring/card-paid-state.js";
import { LithicSimulator } from "./lithic-simulator.js";
import { newMerchant, usualMerchant } from "./pretend-merchant.js";

/**
 * Sandbox stand-in for a merchant (spec §6.25): makes the Card purchase a
 * merchant would for a recurring payment paid by a company-held card, and
 * records that it did. Nothing else: the purchase check and the transaction
 * webhook decide and record the purchase, pay the bill or ask admins about
 * the merchant, exactly as for a real one.
 *
 * Every call to Lithic happens outside a database transaction.
 */

export type SimulationRunner =
  | { readonly kind: "job" }
  | { readonly kind: "staff"; readonly staffUserId: string };

export interface SimulateCardPurchaseInput {
  readonly organizationId: string;
  readonly recurringItemId: string;
  /** The bill the job is charging for; staff charge for the open bill, if any. */
  readonly billId?: string;
  /** US cents; left out, the open bill's amount, else the estimate. */
  readonly amountUsdCents?: bigint;
  readonly newMerchant?: boolean;
  readonly runBy: SimulationRunner;
  readonly now?: Date;
}

export interface SimulatedCardPurchase extends CardSimulationResult {
  readonly simulationId: string;
  readonly billId: string | null;
  readonly amountUsdCents: bigint;
  readonly merchantKey: string;
}

export type SimulateError =
  | NotFound
  | Conflict
  | BadRequest
  | TooManyRequests
  | ServiceUnavailable
  | DatabaseError;

/**
 * Staff purchases a company may have in a rolling hour, each a hold on its
 * Card balance; the job keeps to its own cap per run instead.
 */
export const MAX_STAFF_SIMULATIONS_PER_HOUR = 20;

const HOUR_MS = 60 * 60 * 1000;

const UNCONFIRMED_TOKEN_PREFIX = "unconfirmed:";

/**
 * Stands in for Lithic's token when Lithic may have made the purchase
 * without saying so. No Card purchase ever carries one, so such an attempt
 * holds the job back for its retry window and never counts as a purchase.
 */
function unconfirmedToken(): string {
  return `${UNCONFIRMED_TOKEN_PREFIX}${randomUUID()}`;
}

export function isUnconfirmedToken(token: string): boolean {
  return token.startsWith(UNCONFIRMED_TOKEN_PREFIX);
}

const notAvailable = new ServiceUnavailable({
  message: "Simulated Card purchases are turned off on this API.",
});

const sandboxDown = new ServiceUnavailable({
  message: "Lithic's sandbox didn't answer. Try again in a minute.",
});

const outcomeUnknown = new ServiceUnavailable({
  message:
    "Lithic's sandbox didn't answer, so the purchase may or may not have been made. Check the card's purchases before trying again.",
});

const tooManyThisHour = new TooManyRequests({
  message:
    "Too many simulated purchases for this company in the last hour. Try again later.",
});

const overMonthlyLimit = (limitUsdCents: bigint) =>
  new BadRequest({
    message: `That's more than this card's monthly limit of ${formatUsdCents(limitUsdCents)}.`,
    details: { field: "amountUsd" },
  });

const notClearedAfterApproval = new ServiceUnavailable({
  message:
    "Lithic approved the purchase but didn't settle it, so it stays on hold. Settle it with scripts/lithic-simulate.ts.",
});

const noSuchPayment = new NotFound({ message: "No such recurring payment." });

const notCardPaid = new Conflict({
  message: "This recurring payment isn't paid by a company-held card.",
});

const ended = new Conflict({ message: "This recurring payment has ended." });

const cardClosed = new Conflict({
  message: "Its company-held card is closed.",
});

const billNoLongerOwed = new Conflict({
  message: "This bill is no longer owed.",
});

const noAmount = new BadRequest({
  message: "Enter an amount: this payment has no estimate.",
  details: { field: "amountUsd" },
});

/**
 * Reads as an accountant, the role that sees all of a company's bills and
 * changes nothing, in a READ ONLY transaction: deciding what to charge
 * never writes.
 */
export function withCompanyReadScope<A, E, R>(
  organizationId: string,
  work: (tx: Transaction) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E | DatabaseError, R | DatabaseService> {
  return withScope({ organizationId, role: "accountant" }, (tx) =>
    query(() => tx.execute(sql`SET TRANSACTION READ ONLY`)).pipe(
      Effect.zipRight(work(tx)),
    ),
  );
}

/**
 * A card charges whole cents; a USD amount kept in USDC base units rounds
 * up, so the purchase covers it.
 */
export function usdCentsOf(amountUsdc: bigint | null): bigint | null {
  if (amountUsdc === null) return null;
  return (amountUsdc + USDC_UNITS_PER_US_CENT - 1n) / USDC_UNITS_PER_US_CENT;
}

interface Target {
  readonly payeeName: string;
  readonly payVia: string;
  readonly endedForCards: boolean;
  readonly estimateUsdc: bigint | null;
  readonly card: {
    readonly lithicCardToken: string;
    readonly state: string;
    readonly companyHeld: boolean;
    readonly monthlyLimitUsdCents: bigint;
  } | null;
  readonly bill: {
    readonly id: string;
    readonly amountUsdc: bigint | null;
  } | null;
}

function readTarget(
  tx: Transaction,
  input: SimulateCardPurchaseInput,
): Effect.Effect<Target | null, DatabaseError> {
  const { organizationId, recurringItemId, billId } = input;
  return Effect.gen(function* () {
    const [item] = yield* query(() =>
      tx
        .select({
          payeeName: payees.name,
          payVia: recurringItems.payVia,
          endedForCards: hasEndedForCardsSql().mapWith(Boolean),
          estimateUsdc: recurringItems.amountUsdc,
          lithicCardToken: cards.lithicCardToken,
          cardState: cards.state,
          companyHeld: cards.companyHeld,
          monthlyLimitUsdCents: cards.monthlyLimitUsdCents,
        })
        .from(recurringItems)
        .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
        .leftJoin(cards, eq(cards.id, recurringItems.cardId))
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.id, recurringItemId),
          ),
        ),
    );
    if (!item) return null;
    const [bill] = yield* query(() =>
      tx
        .select({ id: bills.id, amountUsdc: bills.amountUsdc })
        .from(bills)
        .where(
          and(
            eq(bills.organizationId, organizationId),
            eq(bills.recurringItemId, recurringItemId),
            inArray(bills.status, [...DATED_BILL_STATUSES]),
            billId === undefined ? undefined : eq(bills.id, billId),
          ),
        )
        .orderBy(asc(bills.dueOn), asc(bills.id))
        .limit(1),
    );
    return {
      payeeName: item.payeeName,
      payVia: item.payVia,
      endedForCards: item.endedForCards,
      estimateUsdc: item.estimateUsdc,
      card:
        item.lithicCardToken === null ||
        item.cardState === null ||
        item.companyHeld === null ||
        item.monthlyLimitUsdCents === null
          ? null
          : {
              lithicCardToken: item.lithicCardToken,
              state: item.cardState,
              companyHeld: item.companyHeld,
              monthlyLimitUsdCents: item.monthlyLimitUsdCents,
            },
      bill: bill ?? null,
    };
  });
}

/**
 * Refuses only what no merchant could charge, and a staff amount over the
 * card's monthly limit. A paused payment or a frozen card is charged
 * anyway: the purchase check declining it is the point.
 */
function check(
  target: Target | null,
  input: SimulateCardPurchaseInput,
): Effect.Effect<
  {
    readonly cardToken: string;
    readonly amountUsdCents: bigint;
    readonly billId: string | null;
    readonly payeeName: string;
  },
  NotFound | Conflict | BadRequest
> {
  if (target === null) return Effect.fail(noSuchPayment);
  const { card } = target;
  if (target.payVia !== "card" || !card?.companyHeld) {
    return Effect.fail(notCardPaid);
  }
  if (target.endedForCards) return Effect.fail(ended);
  if (card.state === "closed") return Effect.fail(cardClosed);
  if (input.billId !== undefined && target.bill === null) {
    return Effect.fail(billNoLongerOwed);
  }
  const amountUsdCents =
    input.amountUsdCents ??
    usdCentsOf(target.bill?.amountUsdc ?? null) ??
    usdCentsOf(target.estimateUsdc);
  if (amountUsdCents === null) return Effect.fail(noAmount);
  // Staff only: the job charges what the bill says, as a merchant would,
  // and a bill over the limit is the purchase check's to decline.
  if (
    input.runBy.kind === "staff" &&
    amountUsdCents > card.monthlyLimitUsdCents
  ) {
    return Effect.fail(overMonthlyLimit(card.monthlyLimitUsdCents));
  }
  return Effect.succeed({
    cardToken: card.lithicCardToken,
    amountUsdCents,
    billId: target.bill?.id ?? null,
    payeeName: target.payeeName,
  });
}

function staffSimulationsSince(
  tx: Transaction,
  organizationId: string,
  since: Date,
): Effect.Effect<number, DatabaseError> {
  return query(() =>
    tx
      .select({ made: count() })
      .from(cardSimulations)
      .where(
        and(
          eq(cardSimulations.organizationId, organizationId),
          isNotNull(cardSimulations.runByStaff),
          gt(cardSimulations.createdAt, since),
        ),
      ),
  ).pipe(Effect.map(([row]) => row?.made ?? 0));
}

const logSandboxError = (error: LithicError) =>
  console.error(`[card-simulations] ${error.message}`);

function sandboxFailure(error: LithicError): ServiceUnavailable {
  logSandboxError(error);
  return error.code === "NOT_CONFIGURED" ? notAvailable : sandboxDown;
}

/**
 * A staff run checks the company's hourly cap, calls Lithic, then records
 * itself, with no transaction spanning the three, so a company's staff runs
 * go one at a time: two at once can't both pass the cap.
 */
export function simulateCardPurchase(
  input: SimulateCardPurchaseInput,
): Effect.Effect<
  SimulatedCardPurchase,
  SimulateError,
  DatabaseService | LithicSimulator | AuditLog
> {
  return input.runBy.kind === "staff"
    ? exclusively(`card-simulations:${input.organizationId}`, simulate(input))
    : simulate(input);
}

function simulate(
  input: SimulateCardPurchaseInput,
): Effect.Effect<
  SimulatedCardPurchase,
  SimulateError,
  DatabaseService | LithicSimulator | AuditLog
> {
  const { organizationId, recurringItemId, runBy } = input;
  return Effect.gen(function* () {
    const simulator = yield* LithicSimulator;
    if (!simulator.configured) return yield* Effect.fail(notAvailable);
    const at = input.now ?? new Date();
    const { target, staffRunsLastHour } = yield* withCompanyReadScope(
      organizationId,
      (tx) =>
        Effect.all({
          target: readTarget(tx, input),
          staffRunsLastHour:
            runBy.kind === "staff"
              ? staffSimulationsSince(
                  tx,
                  organizationId,
                  new Date(at.getTime() - HOUR_MS),
                )
              : Effect.succeed(0),
        }),
    );
    const checked = yield* check(target, input);
    const { cardToken, amountUsdCents, payeeName } = checked;
    // A new merchant's purchase isn't the bill's: admins may answer it
    // one-off, and the job must still charge the bill from its merchant.
    const billId = input.newMerchant ? null : checked.billId;
    if (staffRunsLastHour >= MAX_STAFF_SIMULATIONS_PER_HOUR) {
      return yield* Effect.fail(tooManyThisHour);
    }
    const merchant: PretendMerchant = input.newMerchant
      ? newMerchant(payeeName)
      : usualMerchant(recurringItemId, payeeName);

    const audit = yield* AuditLog;
    const record = (transactionToken: string, unanswered: LithicError | null) =>
      withScope({ organizationId }, (tx) =>
        Effect.gen(function* () {
          const [row] = yield* query(() =>
            tx
              .insert(cardSimulations)
              .values({
                organizationId,
                recurringItemId,
                billId,
                lithicTransactionToken: transactionToken,
                amountUsdCents,
                merchantKey: merchant.acceptorId,
                runByStaff: runBy.kind === "staff" ? runBy.staffUserId : null,
                createdAt: at,
              })
              .returning({ id: cardSimulations.id }),
          );
          if (!row)
            return yield* Effect.dieMessage("simulation insert wrote no row");
          if (runBy.kind === "staff") {
            // Not under the company: its admins read their company's audit
            // entries, and the pretend merchant stays Expendi's own business.
            yield* audit.record(tx, {
              actor: { type: "staff", id: runBy.staffUserId },
              organizationId: null,
              action:
                unanswered === null
                  ? "card_simulation.made"
                  : "card_simulation.outcome_unknown",
              entity: { type: "card_simulation", id: row.id },
              after: {
                organizationId,
                recurringItemId,
                billId,
                amountUsdCents,
                merchant: merchant.descriptor,
                merchantKey: merchant.acceptorId,
                newMerchant: input.newMerchant ?? false,
                ...(unanswered === null
                  ? { transactionToken }
                  : { outcome: "unknown", lithicError: unanswered.code }),
              },
            });
          }
          return row.id;
        }),
      );

    const authorized = yield* Effect.either(
      simulator.authorize({
        cardToken,
        amountUsdCents,
        descriptor: merchant.descriptor,
        merchantAcceptorId: merchant.acceptorId,
      }),
    );
    if (Either.isLeft(authorized)) {
      if (!authorized.left.ambiguous) {
        return yield* Effect.fail(sandboxFailure(authorized.left));
      }
      // Lithic may have made it: recorded all the same, so the job doesn't
      // leave a second hold on the Card balance before its retry window.
      logSandboxError(authorized.left);
      yield* record(unconfirmedToken(), authorized.left);
      return yield* Effect.fail(outcomeUnknown);
    }
    const { transactionToken } = authorized.right;
    // Recorded before anything else can fail: Lithic made the purchase, and
    // the record is what stops the job making another for this bill.
    const simulationId = yield* record(transactionToken, null);
    const made = {
      simulationId,
      billId,
      amountUsdCents,
      merchantKey: merchant.acceptorId,
      transactionToken,
      merchant: merchant.descriptor,
    };

    const approved = yield* Effect.either(
      simulator.wasApproved({ token: transactionToken }),
    );
    if (Either.isLeft(approved)) {
      logSandboxError(approved.left);
      return { ...made, result: "unknown" as const };
    }
    // A declined purchase leaves nothing to settle, as with a merchant.
    if (approved.right) {
      const clearing = yield* Effect.either(
        simulator.clear({ token: transactionToken }),
      );
      if (Either.isLeft(clearing)) {
        logSandboxError(clearing.left);
        return yield* Effect.fail(notClearedAfterApproval);
      }
    }
    return { ...made, result: approved.right ? "approved" : "declined" };
  });
}
