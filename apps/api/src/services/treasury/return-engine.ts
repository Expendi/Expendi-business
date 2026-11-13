import { Effect } from "effect";

import { formatUsdAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { OneClick } from "../intents/one-click.js";
import type { PrivyWallets } from "../wallet/privy-wallets.js";
import type { Snapshot, Step } from "./move-state.js";
import { openTreasuryReturnQuote } from "../intents/treasury-quote.js";
import { advanceTreasuryReturnQuote } from "../intents/treasury-return.js";
import { idle, moved, needsReview } from "./move-state.js";

/**
 * Sending USDC that sits in the Treasury wallet back to the company wallet,
 * in parts (docs/work/treasury/spec.md, section 4, "Move to wallet"). A move
 * to the wallet sends what its withdrawal delivered; a move to Treasury whose
 * vault deposit Privy rejected has staff send back the undeposited part. Both
 * hand the engine the `total` it may send and what to do once all of it is
 * credited, and nothing else: the engine never reads the Treasury wallet's
 * balance to decide an amount, so USDC a stranger sent there is never sent
 * back or credited.
 *
 * Parts go one at a time, each within the wallet's cap. What is still owed is
 * the total less every part that is sent or on its way, so a refunded part
 * (back in the Treasury wallet) is owed again and a retry can never send more
 * than the total.
 */

/** A part 1Click refunds lands back in the Treasury wallet; wait this long before the next try. */
export const REFUND_WAIT_MS = 30 * 60_000;
/** Refunded parts a move may have before a person looks. */
const MAX_REFUNDED_PARTS = 5;
/** Quotes that expire unused, one after another, before a person looks. */
const MAX_EXPIRED_QUOTES = 3;
/** A quote 1Click can't be asked for is retried this long. */
const QUOTE_RETRY_MS = 5 * 60_000;
/** How long a delivery may take to be credited. */
const CREDIT_WAIT_MS = 30 * 60_000;

export type ReturnDeps =
  DatabaseService | OneClick | BaseRpc | PrivyWallets | AuditLog;

const usdc = formatUsdAmount;

/** What 1Click says it delivers, and so what the deposit watcher must credit. */
const expectedDelivery = (quote: IntentQuote): bigint =>
  quote.swappedAmountOut ?? quote.minAmountOut ?? quote.amountOut;

const COMMITTED_STATUSES: readonly IntentQuote["status"][] = [
  "quoted",
  "depositing",
  "succeeded",
  "needs_review",
];

/** What is sent or on its way: money no longer in the Treasury wallet. */
export const committedOf = (returns: readonly IntentQuote[]): bigint =>
  returns
    .filter((quote) => COMMITTED_STATUSES.includes(quote.status))
    .reduce((sum, quote) => sum + quote.amountIn, 0n);

const STILL_IN_TREASURY =
  "The USDC is still in the Treasury wallet; nothing was lost.";

function nextPart(snap: Snapshot, owed: bigint) {
  const { move, wallet, returns } = snap;
  return Effect.gen(function* () {
    const refunded = returns.filter((quote) => quote.status === "refunded");
    if (refunded.length >= MAX_REFUNDED_PARTS) {
      return yield* needsReview(
        snap,
        `1Click has refunded ${refunded.length} parts of this move. ${STILL_IN_TREASURY} Check why before sending again.`,
      );
    }
    const lastRefund = Math.max(
      0,
      ...refunded.map((quote) => quote.settledAt?.getTime() ?? 0),
    );
    if (refunded.length > 0 && Date.now() - lastRefund < REFUND_WAIT_MS) {
      return idle(move);
    }
    let expiredInARow = 0;
    for (const quote of [...returns].reverse()) {
      if (quote.status !== "expired") break;
      expiredInARow += 1;
    }
    if (expiredInARow >= MAX_EXPIRED_QUOTES) {
      return yield* needsReview(
        snap,
        `The quote for the next part expired unused ${expiredInARow} times. Nothing was sent for it. ${STILL_IN_TREASURY}`,
      );
    }

    // Even parts rather than full parts and a remainder, which could be too
    // small for 1Click to quote.
    const cap = wallet.perTransactionMaxUsdc;
    const partsLeft = (owed + cap - 1n) / cap;
    const part = (owed + partsLeft - 1n) / partsLeft;
    const lastProgress = Math.max(
      move.createdAt.getTime(),
      ...snap.actions.flatMap((action) =>
        action.settledAt ? [action.settledAt.getTime()] : [],
      ),
      ...returns.flatMap((quote) =>
        quote.settledAt ? [quote.settledAt.getTime()] : [],
      ),
    );
    const opened = yield* openTreasuryReturnQuote({
      organizationId: move.organizationId,
      moveId: move.id,
      quoteKey: `treasury-return:${move.id}:${returns.length}`,
      amountIn: part,
    }).pipe(Effect.either);
    if (opened._tag === "Right") return moved(move);
    if (opened.left._tag === "DatabaseError") {
      return yield* Effect.fail(opened.left);
    }
    if (
      opened.left.reason === "one_click_unavailable" &&
      Date.now() - lastProgress < QUOTE_RETRY_MS
    ) {
      return idle(move);
    }
    return yield* needsReview(
      snap,
      `The next part couldn't be quoted: ${opened.left.message} Nothing was sent for it. ${STILL_IN_TREASURY}`,
    );
  });
}

function advancePart(
  snap: Snapshot,
  quote: IntentQuote,
): Effect.Effect<Step, DatabaseError, ReturnDeps> {
  return Effect.gen(function* () {
    const advanced = yield* advanceTreasuryReturnQuote(quote);
    const changed =
      advanced.status !== quote.status ||
      advanced.depositTxHash !== quote.depositTxHash ||
      advanced.depositSubmittedAt?.getTime() !==
        quote.depositSubmittedAt?.getTime();
    return changed ? moved(snap.move) : idle(snap.move);
  });
}

/**
 * One step of sending `total` back to the company wallet: moves the part on
 * its way, or takes the next one, or, once everything is sent and credited,
 * runs `finish`. Safe to run twice: every send is one saved quote under one
 * Privy key.
 */
export function stepReturn(
  snap: Snapshot,
  total: bigint,
  finish: () => Effect.Effect<Step, DatabaseError, ReturnDeps>,
): Effect.Effect<Step, DatabaseError, ReturnDeps> {
  const { move, returns } = snap;
  return Effect.gen(function* () {
    const latest = returns.at(-1);
    if (latest !== undefined) {
      switch (latest.status) {
        case "quoted":
        case "depositing":
          return yield* advancePart(snap, latest);
        case "needs_review":
          return yield* needsReview(
            snap,
            latest.failure ??
              `The outcome of a part's transfer from the Treasury wallet is unclear. Check it before doing anything.`,
          );
        case "failed":
          return yield* needsReview(
            snap,
            `${latest.failure ?? "The part couldn't be sent."} ${STILL_IN_TREASURY}`,
          );
        case "succeeded":
        case "refunded":
        case "expired":
          break;
      }
    }

    const owed = total - committedOf(returns);
    if (owed > 0n) return yield* nextPart(snap, owed);

    const uncredited = returns.filter(
      (quote) =>
        quote.status === "succeeded" &&
        (snap.creditedByQuote.get(quote.id) ?? 0n) < expectedDelivery(quote),
    );
    if (uncredited.length === 0) return yield* finish();
    const waiting = uncredited.reduce(
      (sum, quote) => sum + quote.amountOut,
      0n,
    );
    const since = Math.max(
      ...uncredited.map((quote) =>
        (quote.settledAt ?? quote.updatedAt).getTime(),
      ),
    );
    return Date.now() - since > CREDIT_WAIT_MS
      ? yield* needsReview(
          snap,
          `1Click delivered ${usdc(waiting)} to the company wallet but its ledger hasn't been credited in 30 minutes. Check the company wallet's deposits before doing anything.`,
        )
      : idle(move);
  });
}
