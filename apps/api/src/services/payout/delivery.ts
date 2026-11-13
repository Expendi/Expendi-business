import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { QuoteDepositDeps } from "../intents/quote-deposit.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  advanceCompanyQuote,
  openCompanyQuote,
} from "../intents/quote-deposit.js";
import { isIntentPaid } from "../intents/quote-intent.js";
import { isPaused, lockPayout } from "./guards.js";
import { prepareRecipient } from "./near-recipient.js";
import { applyPayoutOutcome } from "./subjects.js";
import { failPayout, movePayout, reviewPayout } from "./transitions.js";

/**
 * USDC payouts to a payee on Base or Solana (docs/decisions/near-main-chain.md,
 * "Payees and withdrawal addresses"): the company wallet pays a NEAR Intents
 * quote whose recipient is the payee, and 1Click delivers exactly the
 * approved USDC on the payee chain. Expendi's gas relayer covers what the
 * quote costs beyond that, as it does for a Base hop.
 *
 * A company whose USDC is kept in a confidential account pays every payee
 * this way, one on NEAR included, but out of the account by a signed message
 * (`quote-intent.ts`) instead of a transfer on chain. Nothing is debited
 * when the message is accepted: a 200 from 1Click isn't proof it ran. The
 * ledger is written at the quote's outcome (`settleIntentDelivery`).
 *
 * The payout follows its quote (`delivery_quote_id`):
 *
 * - `approved`: the quote is saved, nothing has left the company wallet;
 * - `funding`: the funding barrier was taken and the company wallet's
 *   deposit to the quote is starting or under way;
 * - `paying`: the deposit ran. The ledger is debited here, as for a payee
 *   on NEAR once the company wallet's send has run;
 * - `paid`: 1Click reports the delivery, and its transaction on the payee
 *   chain is the payout's reference (for a payout paid out of a
 *   confidential account it is never `paying`: the debit and `paid` come
 *   together, from `funding`);
 * - `failed`: nothing was sent, or 1Click refunded the deposit to the
 *   company wallet, in which case the debit is credited back;
 * - `needs_review`: where the deposit is isn't certain.
 */

const ACTOR = { type: "system", id: "usdc-delivery" } as const;

export type DeliveryDeps = QuoteDepositDeps | AuditLog;

const payoutOfQuote = (quote: Pick<IntentQuote, "id" | "organizationId">) =>
  withScope({ organizationId: quote.organizationId }, (tx) =>
    query(() =>
      tx.select().from(payouts).where(eq(payouts.deliveryQuoteId, quote.id)),
    ),
  ).pipe(Effect.map(([payout]) => payout ?? null));

/**
 * The funding barrier, asked immediately before the company wallet's
 * deposit starts: under the payout's row lock it re-checks the pauses and
 * the allowlist and records that funding started. A barrier already taken
 * for this quote lets the same deposit continue.
 */
function takeFundingBarrier(quote: IntentQuote) {
  const { organizationId } = quote;
  const abandon = (reason: string) => ({ kind: "abandon", reason }) as const;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [linked] = yield* query(() =>
        tx
          .select({ id: payouts.id })
          .from(payouts)
          .where(eq(payouts.deliveryQuoteId, quote.id)),
      );
      const payout = linked ? yield* lockPayout(tx, linked.id) : null;
      if (payout?.recipient.method !== "usdc") {
        return abandon("No USDC payout is waiting for this quote.");
      }
      if (payout.status === "funding") return { kind: "go" } as const;
      if (payout.status !== "approved" || payout.fundingStartedAt) {
        return abandon("The payout is no longer approved. Nothing was sent.");
      }
      if (yield* isPaused(tx, organizationId)) {
        return abandon("Payouts were paused. Nothing was sent.");
      }
      if (!(yield* isAllowlisted(tx, organizationId, payout.recipient))) {
        return abandon(
          "The address was removed from the allowlist. Nothing was sent.",
        );
      }
      const address = payout.recipient.address;
      const [funding] = yield* query(() =>
        tx
          .update(payouts)
          .set({
            status: "funding",
            fundingStartedAt: new Date(),
            depositAddress: address,
            amountToTransferUsdc: payout.quotedUsdc,
          })
          .where(eq(payouts.id, payout.id))
          .returning(),
      );
      if (!funding) {
        return yield* Effect.dieMessage(`payout ${payout.id} vanished`);
      }
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: "payout.funding_started",
        entity: { type: "payout", id: payout.id },
        after: {
          to: address,
          amount: payout.quotedUsdc,
          deliveryQuoteId: quote.id,
          quoteAmountIn: quote.amountIn,
        },
      });
      return { kind: "go" } as const;
    }),
  );
}

/**
 * The company wallet's deposit ran: the payout is `paying` and debited for
 * exactly the approved USDC. What the quote cost on top is Expendi's.
 */
function recordDeposited(
  payout: Payout,
  quote: IntentQuote,
  depositTxHash: string,
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [paying] = yield* query(() =>
        tx
          .update(payouts)
          .set({ status: "paying", txHash: depositTxHash })
          .where(and(eq(payouts.id, id), eq(payouts.status, "funding")))
          .returning(),
      );
      if (!paying) {
        const [current] = yield* query(() =>
          tx.select().from(payouts).where(eq(payouts.id, id)),
        );
        return current ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      const [send] = quote.companyWalletSendId
        ? yield* query(() =>
            tx
              .select({ blockHeight: companyWalletSends.blockHeight })
              .from(companyWalletSends)
              .where(
                eq(companyWalletSends.id, quote.companyWalletSendId ?? ""),
              ),
          )
        : [];
      const amount = paying.amountToTransferUsdc ?? paying.quotedUsdc;
      yield* query(() =>
        tx.insert(walletTransactions).values({
          organizationId,
          walletId: paying.walletId,
          type: paying.subjectType === "withdrawal" ? "withdrawal" : "payout",
          chain: "near",
          usdcAmount: -amount,
          txHash: depositTxHash,
          blockNumber: send?.blockHeight ?? null,
          counterpartyAddress: paying.depositAddress,
          payoutId: id,
        }),
      );
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: "payout.funded",
        entity: { type: "payout", id },
        before: { status: "funding" },
        after: {
          status: paying.status,
          txHash: depositTxHash,
          amount,
          deliveryQuoteId: quote.id,
        },
      });
      yield* applyPayoutOutcome(tx, paying);
      return paying;
    }),
  );
}

/**
 * 1Click refunded a deposit that was already debited. The refund arrives at
 * the company wallet in one of the quote's own transactions, which the
 * deposit watcher treats as internal and never credits, so the credit is
 * written here, once, together with the payout's failure.
 */
function recordRefunded(
  payout: Payout,
  quote: IntentQuote,
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = payout;
  const reason =
    "NEAR Intents refunded the payment: the USDC is back in the company wallet.";
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const locked = yield* lockPayout(tx, id);
      if (locked?.status !== "paying") {
        return locked ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      const [failed] = yield* query(() =>
        tx
          .update(payouts)
          .set({
            status: "failed",
            failureReason: reason,
            providerCheckedAt: new Date(),
          })
          .where(eq(payouts.id, id))
          .returning(),
      );
      if (!failed) return yield* Effect.dieMessage(`payout ${id} vanished`);
      const amount = failed.amountToTransferUsdc ?? failed.quotedUsdc;
      yield* query(() =>
        tx.insert(walletTransactions).values({
          organizationId,
          walletId: failed.walletId,
          type: "refund",
          chain: "near",
          usdcAmount: amount,
          counterpartyAddress: failed.depositAddress,
          payoutId: id,
        }),
      );
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: "payout.failed",
        entity: { type: "payout", id },
        before: { status: "paying" },
        after: {
          status: failed.status,
          reason,
          refundedToLedger: amount,
          deliveryQuoteId: quote.id,
        },
      });
      yield* applyPayoutOutcome(tx, failed);
      return failed;
    }),
  );
}

/**
 * 1Click delivered a payout paid out of a confidential account: in one
 * transaction the payout is `paid` and debited for exactly the approved
 * USDC. What the quote cost on top came out of Expendi's float. No chain
 * transaction of the company's is involved, so the ledger row carries no
 * hash; the payee chain's transaction is the payout's reference.
 */
function recordDelivered(
  payout: Payout,
  quote: IntentQuote,
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const locked = yield* lockPayout(tx, id);
      if (locked?.status !== "funding") {
        return locked ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      const reference = quote.destinationChainTxHashes[0] ?? null;
      const [paid] = yield* query(() =>
        tx
          .update(payouts)
          .set({
            status: "paid",
            paidAt: new Date(),
            providerReference: reference,
            providerCheckedAt: new Date(),
          })
          .where(eq(payouts.id, id))
          .returning(),
      );
      if (!paid) return yield* Effect.dieMessage(`payout ${id} vanished`);
      const amount = paid.amountToTransferUsdc ?? paid.quotedUsdc;
      yield* query(() =>
        tx.insert(walletTransactions).values({
          organizationId,
          walletId: paid.walletId,
          type: paid.subjectType === "withdrawal" ? "withdrawal" : "payout",
          chain: "near",
          usdcAmount: -amount,
          counterpartyAddress: paid.depositAddress,
          payoutId: id,
        }),
      );
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: "payout.paid",
        entity: { type: "payout", id },
        before: { status: "funding" },
        after: {
          status: paid.status,
          providerReference: reference,
          amount,
          deliveryQuoteId: quote.id,
        },
      });
      yield* applyPayoutOutcome(tx, paid);
      return paid;
    }),
  );
}

/**
 * Applies where a quote paid out of a confidential account stands to its
 * payout. The payout is `funding` from the moment the deposit may start, and
 * nothing is debited until 1Click reports the outcome:
 *
 * - `succeeded`: debited and `paid`, together (`recordDelivered`);
 * - `refunded`: `failed`. The refund went back into the account, so the
 *   ledger never moved and there is nothing to credit;
 * - `expired`, `failed`: `failed`, nothing moved;
 * - `needs_review`: `needs_review`, still reserving the payout's USDC. A late
 *   `SUCCESS` or `REFUNDED` settles the quote but not the payout: staff hand
 *   it back to `funding`, and this applies the outcome.
 */
function settleIntentDelivery(
  payout: Payout,
  quote: IntentQuote,
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    if (payout.status !== "approved" && payout.status !== "funding") {
      return payout;
    }
    const failure = quote.failure ?? "The payment couldn't be sent.";
    const nothingSent = /nothing (?:was sent|moved)\.$/i.test(failure)
      ? failure
      : `${failure} Nothing was sent.`;
    switch (quote.status) {
      case "succeeded":
        return payout.status === "funding"
          ? yield* recordDelivered(payout, quote)
          : payout;
      case "refunded":
        return yield* failPayout(
          payout,
          "NEAR Intents refunded the payment: the USDC is back in the company's account. Nothing was sent.",
          ACTOR,
        );
      case "expired":
      case "failed":
        return yield* failPayout(payout, nothingSent, ACTOR);
      case "needs_review":
        return payout.status === "funding"
          ? yield* reviewPayout(
              payout,
              `The payment's outcome is unclear (quote ${quote.id}): ${quote.failure ?? "check NEAR Intents."} Never send again before it is resolved.`,
              ACTOR,
            )
          : payout;
      default:
        return payout;
    }
  });
}

/**
 * Applies where a delivery quote stands to its payout. Only reads the
 * quote and updates records; safe to repeat.
 */
export function settleDelivery(
  quote: IntentQuote,
): Effect.Effect<Payout | null, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    let payout = yield* payoutOfQuote(quote);
    if (payout === null) return null;
    if (isIntentPaid(quote)) return yield* settleIntentDelivery(payout, quote);
    const nothingSent = `${quote.failure ?? "The payment couldn't be sent."}${quote.failure?.endsWith("Nothing was sent.") ? "" : " Nothing was sent."}`;
    const unclear = `The payment's outcome is unclear (quote ${quote.id}): ${quote.failure ?? "check NEAR Intents."} Never send again before it is resolved.`;

    if (payout.status === "approved" || payout.status === "funding") {
      if (quote.depositTxHash !== null && payout.status === "funding") {
        payout = yield* recordDeposited(payout, quote, quote.depositTxHash);
      } else if (quote.status === "expired" || quote.status === "failed") {
        return yield* failPayout(payout, nothingSent, ACTOR);
      } else if (
        quote.status === "needs_review" &&
        payout.status === "funding"
      ) {
        return yield* reviewPayout(payout, unclear, ACTOR);
      }
    }
    if (payout.status !== "paying") return payout;

    switch (quote.status) {
      case "succeeded": {
        const reference = quote.destinationChainTxHashes[0] ?? null;
        return yield* movePayout({
          payout,
          from: "paying",
          changes: {
            status: "paid",
            paidAt: new Date(),
            providerReference: reference,
            providerCheckedAt: new Date(),
          },
          action: "payout.paid",
          after: { providerReference: reference, deliveryQuoteId: quote.id },
          actor: ACTOR,
        });
      }
      case "refunded":
        return yield* recordRefunded(payout, quote);
      case "needs_review":
        return yield* reviewPayout(payout, unclear, ACTOR);
      default:
        return payout;
    }
  });
}

/** Moves a delivery quote as far as it can go now, and its payout with it. */
export function continueDelivery(
  quote: IntentQuote,
): Effect.Effect<Payout | null, DatabaseError, DeliveryDeps> {
  return advanceCompanyQuote({
    quote,
    beforeDeposit: takeFundingBarrier,
  }).pipe(Effect.flatMap(settleDelivery));
}

/**
 * Pays an approved USDC payout to its payee through a delivery quote (one
 * per payout, keyed by the payout), then moves it as far as it goes within
 * this call; the job follows the rest. A payee on Base or Solana, and every
 * payee of a company whose USDC is kept in a confidential account, are paid
 * this way. A quote that can't be taken fails the payout with nothing sent.
 * The payout comes back as it now stands.
 *
 * A payee on NEAR must be able to hold USDC before the quote is taken, as
 * for a direct transfer: a payout to a named account the USDC contract
 * doesn't know fails here, before anything is signed.
 */
export function deliverUsdcPayout(
  payout: Payout,
): Effect.Effect<Payout, DatabaseError, DeliveryDeps> {
  const { organizationId } = payout;
  return Effect.gen(function* () {
    const recipient = payout.recipient;
    if (payout.status !== "approved" || recipient.method !== "usdc") {
      return yield* Effect.dieMessage(
        `payout ${payout.id} isn't an approved USDC payout`,
      );
    }
    if (recipient.chain === "near") {
      const prepared = yield* prepareRecipient(recipient.address).pipe(
        Effect.either,
      );
      if (prepared._tag === "Left") {
        console.warn(
          `[payout] couldn't prepare ${recipient.address} to receive payout ${payout.id}`,
          prepared.left.message,
        );
        return yield* failPayout(
          payout,
          `${recipient.address} couldn't be registered to receive USDC on NEAR. Nothing was sent.`,
          ACTOR,
        );
      }
      if (prepared.right !== null) {
        return yield* failPayout(payout, prepared.right, ACTOR);
      }
    }
    const opened = yield* openCompanyQuote({
      organizationId,
      quoteKey: `delivery:${payout.id}`,
      purpose: "usdc_payout",
      destinationChain: recipient.chain,
      recipient: recipient.address,
      amountOut: payout.quotedUsdc,
      link: (tx, quote) =>
        query(() =>
          tx
            .update(payouts)
            .set({ deliveryQuoteId: quote.id })
            .where(
              and(
                eq(payouts.id, payout.id),
                eq(payouts.status, "approved"),
                isNull(payouts.deliveryQuoteId),
              ),
            ),
        ).pipe(Effect.asVoid),
    }).pipe(Effect.either);
    if (opened._tag === "Left") {
      if (opened.left._tag === "DatabaseError") {
        return yield* Effect.fail(opened.left);
      }
      return yield* failPayout(
        payout,
        `The payment couldn't be quoted: ${opened.left.message} Nothing was sent.`,
        ACTOR,
      );
    }
    const settled = yield* continueDelivery(opened.right);
    return settled ?? payout;
  });
}

/** The quote delivering a payout, or null if it has none. */
export function deliveryQuoteOf(
  payout: Pick<Payout, "organizationId" | "deliveryQuoteId">,
): Effect.Effect<IntentQuote | null, DatabaseError, DatabaseService> {
  const quoteId = payout.deliveryQuoteId;
  if (quoteId === null) return Effect.succeed(null);
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    query(() =>
      tx.select().from(intentQuotes).where(eq(intentQuotes.id, quoteId)),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));
}
