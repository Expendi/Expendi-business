import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseError } from "../../errors.js";
import type { SweepDeps } from "../intents/sweep.js";
import type { DeliveryDeps } from "./delivery.js";
import type { FundDeps } from "./fund.js";
import { intentQuotes, payouts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { advanceSweep } from "../intents/sweep.js";
import { baseHopOf } from "./base-hop.js";
import { continueDelivery, deliveryQuoteOf } from "./delivery.js";
import { continueBaseHop } from "./fund.js";

/**
 * The job behind every NEAR Intents quote Expendi pays itself: Base hops,
 * USDC payouts to Base and Solana, and sweeps. A request only starts these;
 * whatever it left unfinished, or a crash interrupted, is picked up here
 * from the saved rows, and each quote's outcome is applied to its payouts.
 */

const OUTBOUND_PURPOSES = ["base_hop", "usdc_payout", "sweep"] as const;

interface QuoteRef extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
  readonly purpose: string;
}

interface PayoutRef extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
}

export interface OutboundQuotesSummary {
  /** Unsettled quotes moved on. */
  readonly quotes: number;
  /** Payouts moved on through a quote the first pass didn't reach. */
  readonly caughtUp: number;
  readonly errors: number;
}

type OutboundDeps = FundDeps | DeliveryDeps | SweepDeps;

/**
 * 1. Every unsettled outbound quote takes its next step, and its outcome is
 *    applied to its payouts.
 * 2. Every cash-out still `approved` behind a hop, and every USDC payout
 *    behind a delivery quote (approved, funding or paying), is followed
 *    through its quote as well. That
 *    reaches what the first pass can't: a quote that settled in a run that
 *    stopped before its payouts were moved is no longer unsettled.
 *
 * Each quote and payout is handled on its own, so one failing never stops
 * the rest.
 */
export function advanceOutboundQuotes(
  maxRows = 50,
): Effect.Effect<OutboundQuotesSummary, DatabaseError, OutboundDeps> {
  return Effect.gen(function* () {
    let errors = 0;
    const isolated = <A>(
      what: string,
      work: Effect.Effect<A, DatabaseError, OutboundDeps>,
    ) =>
      Effect.exit(work).pipe(
        Effect.map((exit) => {
          if (Exit.isSuccess(exit)) return true;
          errors += 1;
          console.error(
            `[outbound-quotes] ${what} broke`,
            Cause.pretty(exit.cause),
          );
          return false;
        }),
      );

    const { rows: quoteRefs } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<QuoteRef>(
          sql`SELECT quote_id, organization_id, purpose FROM intent_quotes_to_refresh(${sql.raw(`ARRAY['${OUTBOUND_PURPOSES.join("','")}']`)}, ${maxRows})`,
        ),
      ),
    );
    const handled = new Set<string>();
    for (const ref of quoteRefs) {
      handled.add(ref.quote_id);
      yield* isolated(
        `quote ${ref.quote_id}`,
        Effect.gen(function* () {
          const [quote] = yield* withScope(
            { organizationId: ref.organization_id },
            (tx) =>
              query(() =>
                tx
                  .select()
                  .from(intentQuotes)
                  .where(eq(intentQuotes.id, ref.quote_id)),
              ),
          );
          if (!quote) return;
          switch (quote.purpose) {
            case "base_hop":
              yield* continueBaseHop(quote);
              return;
            case "usdc_payout":
              yield* continueDelivery(quote);
              return;
            case "sweep":
              yield* advanceSweep(quote);
              return;
            case "fund_in":
            case "fund_in_return":
              return;
          }
        }),
      );
    }

    let caughtUp = 0;
    const payoutOf = (ref: PayoutRef) =>
      withScope({ organizationId: ref.organization_id }, (tx) =>
        query(() =>
          tx.select().from(payouts).where(eq(payouts.id, ref.payout_id)),
        ),
      ).pipe(Effect.map(([payout]) => payout ?? null));

    const { rows: paycrestCashOuts } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM paycrest_payouts_to_reconcile(${maxRows * 4})`,
        ),
      ),
    );
    const { rows: pretiumCashOuts } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM pretium_cash_outs_awaiting_funding(${maxRows * 4})`,
        ),
      ),
    );
    for (const ref of [...paycrestCashOuts, ...pretiumCashOuts]) {
      yield* isolated(
        `cash-out ${ref.payout_id}`,
        Effect.gen(function* () {
          const payout = yield* payoutOf(ref);
          if (
            payout?.status !== "approved" ||
            payout.orderRequestedAt !== null ||
            payout.baseHopQuoteId === null ||
            handled.has(payout.baseHopQuoteId)
          ) {
            return;
          }
          handled.add(payout.baseHopQuoteId);
          const hop = yield* baseHopOf(payout);
          if (!hop) return;
          yield* continueBaseHop(hop);
          caughtUp += 1;
        }),
      );
    }

    // A delivery's payout is `approved` until its funding barrier, then
    // `funding` and `paying`: two lookups cover the three.
    const { rows: awaitingDelivery } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM usdc_payouts_awaiting_delivery(${maxRows * 4})`,
        ),
      ),
    );
    const { rows: sentUsdcPayouts } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM onchain_payouts_to_confirm(${maxRows * 4})`,
        ),
      ),
    );
    for (const ref of [...awaitingDelivery, ...sentUsdcPayouts]) {
      yield* isolated(
        `USDC payout ${ref.payout_id}`,
        Effect.gen(function* () {
          const payout = yield* payoutOf(ref);
          if (
            payout?.deliveryQuoteId == null ||
            handled.has(payout.deliveryQuoteId)
          ) {
            return;
          }
          handled.add(payout.deliveryQuoteId);
          const quote = yield* deliveryQuoteOf(payout);
          if (!quote) return;
          const settled = yield* continueDelivery(quote);
          if (settled && settled.status !== payout.status) caughtUp += 1;
        }),
      );
    }

    return { quotes: quoteRefs.length, caughtUp, errors };
  });
}
