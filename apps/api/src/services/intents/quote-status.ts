import { and, asc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { IntentQuotePurpose } from "../../db/schema/intent-quotes.js";
import type { DatabaseError } from "../../errors.js";
import type { OneClickError } from "./one-click.js";
import { intentQuotes } from "../../db/schema/index.js";
import {
  INTENT_QUOTE_PURPOSES,
  UNSETTLED_INTENT_QUOTE_STATUSES,
} from "../../db/schema/intent-quotes.js";
import { query, withScope } from "../../db/scope.js";
import { OneClick } from "./one-click.js";

const textArray = (values: readonly string[]) =>
  values.length === 0
    ? sql`'{}'::text[]`
    : sql`ARRAY[${sql.join(
        values.map((value) => sql`${value}`),
        sql`, `,
      )}]::text[]`;

/** What 1Click reported, or what the row already holds when it reported nothing. */
const reportedAmount = (
  amount: bigint | null,
  column:
    | typeof intentQuotes.depositedAmount
    | typeof intentQuotes.swappedAmountIn
    | typeof intentQuotes.swappedAmountOut
    | typeof intentQuotes.refundedAmount,
) =>
  sql`coalesce(${amount === null ? null : amount.toString()}::numeric, ${column})`;

/**
 * Asks 1Click what became of a quote and saves its answer on the quote's
 * row: the 1Click fields only, never the quote's own `status`, which belongs
 * to whoever runs that kind of quote. A transaction hash 1Click listed once
 * stays listed, so a transfer explained by it stays explained. Returns the
 * row as saved; a quote that isn't the company's dies, since callers pass
 * one they just read.
 */
export function refreshQuoteStatus(
  quote: Pick<IntentQuote, "id" | "organizationId" | "depositAddress">,
): Effect.Effect<
  IntentQuote,
  OneClickError | DatabaseError,
  OneClick | DatabaseService
> {
  return Effect.gen(function* () {
    const oneClick = yield* OneClick;
    const reported = yield* oneClick.status(quote.depositAddress);
    const merged = (
      column:
        | typeof intentQuotes.nearTxHashes
        | typeof intentQuotes.originChainTxHashes
        | typeof intentQuotes.destinationChainTxHashes,
      hashes: readonly string[],
    ) =>
      sql`ARRAY(SELECT DISTINCT hash FROM unnest(${column} || ${textArray(hashes)}) AS hash ORDER BY hash)`;
    const [saved] = yield* withScope(
      { organizationId: quote.organizationId },
      (tx) =>
        query(() =>
          tx
            .update(intentQuotes)
            .set({
              oneClickStatus: reported.status,
              oneClickCheckedAt: sql`now()`,
              nearTxHashes: merged(
                intentQuotes.nearTxHashes,
                reported.nearTxHashes,
              ),
              originChainTxHashes: merged(
                intentQuotes.originChainTxHashes,
                reported.originChainTxHashes,
              ),
              destinationChainTxHashes: merged(
                intentQuotes.destinationChainTxHashes,
                reported.destinationChainTxHashes,
              ),
              depositedAmount: reportedAmount(
                reported.depositedAmount,
                intentQuotes.depositedAmount,
              ),
              swappedAmountIn: reportedAmount(
                reported.amountIn,
                intentQuotes.swappedAmountIn,
              ),
              swappedAmountOut: reportedAmount(
                reported.amountOut,
                intentQuotes.swappedAmountOut,
              ),
              refundedAmount: reportedAmount(
                reported.refundedAmount,
                intentQuotes.refundedAmount,
              ),
              refundReason: sql`coalesce(${reported.refundReason}::text, ${intentQuotes.refundReason})`,
            })
            .where(
              and(
                eq(intentQuotes.id, quote.id),
                eq(intentQuotes.organizationId, quote.organizationId),
              ),
            )
            .returning(),
        ),
    );
    return saved ?? (yield* Effect.dieMessage("intent quote row vanished"));
  });
}

/**
 * How long after a quote settles its 1Click record may still gain
 * transactions: an `EXACT_OUTPUT` quote returns its unused buffer in a
 * transfer of its own, after the delivery that settled it.
 */
export const RECENTLY_SETTLED_MINUTES = 15;

/**
 * The company's quotes whose 1Click record may list a transaction the row
 * doesn't have yet: every unsettled one, and those settled a short while
 * ago. Oldest first.
 */
export function quotesToRecheck(
  organizationId: string,
  purposes: readonly IntentQuotePurpose[] = INTENT_QUOTE_PURPOSES,
): Effect.Effect<IntentQuote[], DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.purpose, [...purposes]),
            or(
              inArray(intentQuotes.status, [
                ...UNSETTLED_INTENT_QUOTE_STATUSES,
              ]),
              gt(
                intentQuotes.settledAt,
                sql`now() - make_interval(mins => ${RECENTLY_SETTLED_MINUTES})`,
              ),
            ),
          ),
        )
        .orderBy(asc(intentQuotes.createdAt), asc(intentQuotes.id)),
    ),
  );
}
