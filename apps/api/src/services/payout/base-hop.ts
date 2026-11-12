import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { OneClick } from "../intents/one-click.js";
import type { QuoteDepositDeps } from "../intents/quote-deposit.js";
import { intentQuotes, payouts, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  advanceCompanyQuote,
  openCompanyQuote,
  STABLECOIN_SLIPPAGE_BPS,
} from "../intents/quote-deposit.js";
import { isPaused } from "./guards.js";
import { failPayout, reviewPayout } from "./transitions.js";

/**
 * The Base hop of a cash-out (docs/decisions/near-main-chain.md, "Base
 * hop"): the company's money sits on NEAR and Paycrest takes USDC on Base,
 * so the USDC a cash-out may need is first moved from the company wallet to
 * the company's transit wallet through a NEAR Intents quote.
 *
 * A cash-out waits for its hop in `approved`, with `base_hop_quote_id` set
 * and no order requested: nothing has been ordered or sent for it, and its
 * USDC stays reserved. Its hop's quote says how far the money is. Payouts
 * approved together share hops, so a payroll run hops once for its total.
 *
 * A hop moves a company's money between its own two wallets, so it is never
 * a ledger entry: the cash-out is debited when it is funded from the
 * transit wallet, as before.
 */

const ACTOR = { type: "system", id: "base-hop" } as const;

/**
 * Room left under the per-transaction cap for what a hop costs beyond what
 * it delivers: the cap applies to the quote's amount in, which is the
 * amount out plus 1Click's cost and its slippage buffer.
 */
const HOP_COST_ALLOWANCE_USDC = 1_000_000n;

/** The most one hop may deliver under a wallet's per-transaction cap. */
export function hopBudget(perTransactionMaxUsdc: bigint): bigint {
  return (
    perTransactionMaxUsdc -
    (perTransactionMaxUsdc * BigInt(STABLECOIN_SLIPPAGE_BPS)) / 10_000n -
    HOP_COST_ALLOWANCE_USDC
  );
}

interface Sized {
  readonly id: string;
  readonly amount: bigint;
}

/**
 * Splits amounts into as few groups as first-fit-decreasing finds, each
 * summing to at most `budget`. An amount over the budget gets a group of
 * its own. Everything that fits one group stays in one.
 */
export function packIntoHops(
  items: readonly Sized[],
  budget: bigint,
): Sized[][] {
  const groups: { total: bigint; items: Sized[] }[] = [];
  const largestFirst = [...items].sort((a, b) =>
    a.amount === b.amount
      ? a.id.localeCompare(b.id)
      : a.amount > b.amount
        ? -1
        : 1,
  );
  for (const item of largestFirst) {
    const fits = groups.find((group) => group.total + item.amount <= budget);
    if (fits) {
      fits.total += item.amount;
      fits.items.push(item);
    } else {
      groups.push({ total: item.amount, items: [item] });
    }
  }
  return groups.map((group) => group.items);
}

const waitingForHop = and(
  inArray(payouts.provider, ["paycrest", "pretium"]),
  eq(payouts.status, "approved"),
  isNull(payouts.orderRequestedAt),
);

/**
 * Gives every approved cash-out among `payoutIds` that has no hop yet a
 * Base hop quote, for a company whose money is on NEAR. Payouts approved
 * together share one quote for the sum of their approved maximums; only a
 * sum over the per-transaction cap is split, into as few hops as fit.
 *
 * A hop delivers the approved maximum rather than the order's exact amount,
 * which Paycrest only states once the order exists, after the hop. The
 * small remainder stays in the transit wallet and is swept back.
 *
 * The quote and its payouts' links are saved together. A hop that can't be
 * quoted fails its payouts with nothing moved. Nothing is sent here.
 */
export function planBaseHops(input: {
  readonly organizationId: string;
  readonly payoutIds: readonly string[];
}): Effect.Effect<void, DatabaseError, DatabaseService | AuditLog | OneClick> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    if (input.payoutIds.length === 0) return;
    const { wallet, unplanned } = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [company] = yield* query(() =>
          tx
            .select()
            .from(wallets)
            .where(eq(wallets.organizationId, organizationId))
            .limit(1),
        );
        const waiting = yield* query(() =>
          tx
            .select()
            .from(payouts)
            .where(
              and(
                eq(payouts.organizationId, organizationId),
                inArray(payouts.id, [...input.payoutIds]),
                waitingForHop,
                isNull(payouts.baseHopQuoteId),
              ),
            )
            .orderBy(asc(payouts.createdAt), asc(payouts.id)),
        );
        return { wallet: company ?? null, unplanned: waiting };
      }),
    );
    if (wallet?.chain !== "near" || unplanned.length === 0) return;
    const transitAddress = wallet.transitAddress;
    if (wallet.status !== "active" || transitAddress === null) {
      for (const payout of unplanned) {
        yield* failPayout(payout, "The company wallet isn't active.", ACTOR);
      }
      return;
    }

    const byApproval = new Map<string, Payout[]>();
    for (const payout of unplanned) {
      const key = payout.approvalId ?? payout.id;
      byApproval.set(key, [...(byApproval.get(key) ?? []), payout]);
    }

    for (const batch of byApproval.values()) {
      const hops = packIntoHops(
        batch.map((payout) => ({ id: payout.id, amount: payout.maxDebitUsdc })),
        hopBudget(wallet.perTransactionMaxUsdc),
      );
      for (const hop of hops) {
        const ids = hop.map((item) => item.id).sort();
        const opened = yield* openCompanyQuote({
          organizationId,
          quoteKey: `base-hop:${ids[0] ?? ""}`,
          purpose: "base_hop",
          destinationChain: "base",
          recipient: transitAddress,
          amountOut: hop.reduce((sum, item) => sum + item.amount, 0n),
          link: (tx, quote) =>
            query(() =>
              tx
                .update(payouts)
                .set({ baseHopQuoteId: quote.id })
                .where(
                  and(
                    inArray(payouts.id, ids),
                    waitingForHop,
                    isNull(payouts.baseHopQuoteId),
                  ),
                ),
            ).pipe(Effect.asVoid),
        }).pipe(Effect.either);
        if (opened._tag === "Right") continue;
        if (opened.left._tag === "DatabaseError") {
          return yield* Effect.fail(opened.left);
        }
        const reason = `The Base hop couldn't start: ${opened.left.message} Nothing was sent.`;
        for (const payout of batch.filter((one) => ids.includes(one.id))) {
          yield* failPayout(payout, reason, ACTOR);
        }
      }
    }
  });
}

const payoutsWaitingOn = (quote: Pick<IntentQuote, "id" | "organizationId">) =>
  withScope({ organizationId: quote.organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(payouts)
        .where(and(eq(payouts.baseHopQuoteId, quote.id), waitingForHop))
        .orderBy(asc(payouts.createdAt), asc(payouts.id)),
    ),
  );

/**
 * Moves a Base hop's quote as far as it can go now. Its deposit starts only
 * while payouts aren't paused and a cash-out still waits for it: an
 * approval that lapsed or was failed meanwhile no longer moves money.
 */
export function advanceBaseHop(
  quote: IntentQuote,
): Effect.Effect<IntentQuote, DatabaseError, QuoteDepositDeps> {
  return advanceCompanyQuote({
    quote,
    beforeDeposit: (current) =>
      Effect.gen(function* () {
        const paused = yield* withScope(
          { organizationId: current.organizationId },
          (tx) => isPaused(tx, current.organizationId),
        );
        if (paused) {
          return {
            kind: "abandon",
            reason: "Payouts were paused before the Base hop. Nothing moved.",
          } as const;
        }
        const waiting = yield* payoutsWaitingOn(current);
        return waiting.length > 0
          ? ({ kind: "go" } as const)
          : ({
              kind: "abandon",
              reason:
                "No approved cash-out was waiting for this Base hop any more. Nothing moved.",
            } as const);
      }),
  });
}

/**
 * Applies a Base hop's outcome to the cash-outs still waiting for it.
 *
 * - `succeeded`: the USDC is in the transit wallet, and `fund` runs the
 *   Paycrest order and funding for each payout, one after another, each on
 *   its own so one failing never stops the rest;
 * - `refunded`: the USDC is back in the company wallet, the payouts are
 *   `failed` and can be retried, which takes a new quote under a new key;
 * - `expired` or `failed`: the hop's deposit never left the company
 *   wallet, the payouts are `failed`;
 * - `needs_review`: where the hop's USDC is isn't certain, so its payouts
 *   go to a person too, still reserving their USDC.
 *
 * A hop still under way changes nothing. Returns how many payouts moved.
 */
export function settleHopPayouts<R>(input: {
  readonly quote: IntentQuote;
  readonly fund: (payout: Payout) => Effect.Effect<Payout, DatabaseError, R>;
}): Effect.Effect<number, DatabaseError, R | DatabaseService | AuditLog> {
  const { quote } = input;
  return Effect.gen(function* () {
    if (quote.status === "quoted" || quote.status === "depositing") return 0;
    const waiting = yield* payoutsWaitingOn(quote);
    let moved = 0;
    for (const payout of waiting) {
      switch (quote.status) {
        case "succeeded": {
          const exit = yield* Effect.exit(input.fund(payout));
          if (Exit.isFailure(exit)) {
            console.error(
              `[base-hop] funding payout ${payout.id} after its hop broke`,
              Cause.pretty(exit.cause),
            );
          }
          break;
        }
        case "refunded":
          yield* failPayout(
            payout,
            "NEAR Intents refunded the Base hop: the USDC is back in the company wallet. Nothing was sent.",
            ACTOR,
          );
          break;
        case "expired":
        case "failed":
          yield* failPayout(
            payout,
            `The Base hop didn't happen: ${quote.failure ?? "its deposit was never sent."} Nothing was sent.`,
            ACTOR,
          );
          break;
        case "needs_review":
          yield* reviewPayout(
            payout,
            `The Base hop's outcome is unclear (quote ${quote.id}): ${quote.failure ?? "check NEAR Intents."} Nothing was sent to the cash-out provider. Resolve the hop before doing anything.`,
            ACTOR,
          );
          break;
      }
      moved += 1;
    }
    return moved;
  });
}

/** The quote of a payout's Base hop, or null if it has none. */
export function baseHopOf(
  payout: Pick<Payout, "organizationId" | "baseHopQuoteId">,
): Effect.Effect<IntentQuote | null, DatabaseError, DatabaseService> {
  const quoteId = payout.baseHopQuoteId;
  if (quoteId === null) return Effect.succeed(null);
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    query(() =>
      tx.select().from(intentQuotes).where(eq(intentQuotes.id, quoteId)),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));
}
