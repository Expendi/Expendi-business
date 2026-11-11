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
import { isPaused, lockPayout } from "./guards.js";
import { applyPayoutOutcome } from "./subjects.js";
import { failPayout, movePayout, reviewPayout } from "./transitions.js";

/**
 * USDC payouts to a payee on Base or Solana (docs/decisions/near-main-chain.md,
 * "Payees and withdrawal addresses"): the company wallet pays a NEAR Intents
 * quote whose recipient is the payee, and 1Click delivers exactly the
 * approved USDC on the payee chain. Expendi's gas relayer covers what the
 * quote costs beyond that, as it does for a Base hop.
 *
 * The payout follows its quote (`delivery_quote_id`):
 *
 * - `approved`: the quote is saved, nothing has left the company wallet;
 * - `funding`: the funding barrier was taken and the company wallet's
 *   deposit to the quote is starting or under way;
 * - `paying`: the deposit ran. The ledger is debited here, as for a payee
 *   on NEAR once the company wallet's send has run;
 * - `paid`: 1Click reports the delivery, and its transaction on the payee
 *   chain is the payout's reference;
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
 * Applies where a delivery quote stands to its payout. Only reads the
 * quote and updates records; safe to repeat.
 */
export function settleDelivery(
  quote: IntentQuote,
): Effect.Effect<Payout | null, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    let payout = yield* payoutOfQuote(quote);
    if (payout === null) return null;
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
 * Pays an approved USDC payout to its payee on Base or Solana. Takes the
 * delivery quote (one per payout, keyed by the payout), then moves it as
 * far as it goes within this call; the job follows the rest. A quote that
 * can't be taken fails the payout with nothing sent. The payout comes back
 * as it now stands.
 */
export function deliverUsdcPayout(
  payout: Payout,
): Effect.Effect<Payout, DatabaseError, DeliveryDeps> {
  const { organizationId } = payout;
  return Effect.gen(function* () {
    const recipient = payout.recipient;
    if (
      payout.status !== "approved" ||
      recipient.method !== "usdc" ||
      recipient.chain === "near"
    ) {
      return yield* Effect.dieMessage(
        `payout ${payout.id} isn't an approved USDC payout to another chain`,
      );
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
