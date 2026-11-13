import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { IntentQuotePurpose } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { intentQuotes } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * Where Expendi's own USDC for a company sits: in the company wallet on
 * NEAR, which is where a Base hop's or a payout's unused buffer returns to,
 * or in the company's confidential account, which pays them by a signed
 * message and receives the fee cover the relayer delivers.
 */
export type SurplusPool = "company_wallet" | "confidential_account";

/** The quotes whose cost Expendi covers: those that deliver an exact amount. */
const COVERED_PURPOSES = [
  "base_hop",
  "usdc_payout",
] as const satisfies readonly IntentQuotePurpose[];

/**
 * What Expendi's own USDC in a company wallet comes to on the quotes' rows
 * alone: the fee cover the gas relayer sent, less what each covered quote
 * turned out to cost. The quote named by `excludeQuoteId` is left out, for
 * the one being worked on. It is not proof the USDC is there: see
 * `expendiSurplus` in quote-deposit.ts.
 *
 * `confidential_account` is the float held in the company's confidential
 * account: the fee covers delivered into it, less what each hop and payout
 * paid out of it cost, less what each sweep into it cost. A quote still in
 * flight or under review counts its whole difference, so two of them can't
 * spend the same float. `company_wallet`, the default, never reads a quote
 * paid out of a confidential account.
 */
export function recordedExpendiSurplus(
  tx: Transaction,
  walletId: string,
  excludeQuoteId?: string,
  pool: SurplusPool = "company_wallet",
): Effect.Effect<bigint, DatabaseError> {
  const notExcluded =
    excludeQuoteId === undefined
      ? undefined
      : ne(intentQuotes.id, excludeQuoteId);
  const spent = sql`CASE
              WHEN ${intentQuotes.status} = 'succeeded' THEN
                least(greatest(coalesce(${intentQuotes.swappedAmountIn}, ${intentQuotes.amountIn}), ${intentQuotes.amountOut}), ${intentQuotes.amountIn}) - ${intentQuotes.amountOut}
              WHEN ${intentQuotes.status} = 'refunded' THEN
                ${intentQuotes.amountIn} - least(coalesce(${intentQuotes.refundedAmount}, ${intentQuotes.amountIn}), ${intentQuotes.amountIn})
              WHEN ${intentQuotes.status} = 'failed' AND ${intentQuotes.companyWalletSendId} IS NULL THEN 0
              ELSE ${intentQuotes.amountIn} - ${intentQuotes.amountOut}
            END`;

  return Effect.gen(function* () {
    if (pool === "confidential_account") {
      const [sums] = yield* query(() =>
        tx
          .select({
            surplus: sql<string>`coalesce(sum(
              CASE ${intentQuotes.purpose}::text
                WHEN 'fee_cover' THEN
                  CASE WHEN ${intentQuotes.status} = 'succeeded' THEN coalesce(${intentQuotes.swappedAmountOut}, ${intentQuotes.amountOut}) ELSE 0 END
                WHEN 'sweep' THEN
                  CASE WHEN ${intentQuotes.status} = 'succeeded' THEN -greatest(${intentQuotes.amountIn} - coalesce(${intentQuotes.swappedAmountOut}, ${intentQuotes.amountOut}), 0) ELSE 0 END
                ELSE -(${spent})
              END), 0)::text`,
          })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.walletId, walletId),
              notExcluded,
              sql`(
                ${intentQuotes.purpose}::text = 'fee_cover'
                OR (${intentQuotes.purpose}::text = 'sweep' AND ${intentQuotes.recipientType} = 'CONFIDENTIAL_INTENTS')
                OR (${intentQuotes.purpose}::text IN ('base_hop', 'usdc_payout') AND ${intentQuotes.depositType} = 'CONFIDENTIAL_INTENTS' AND ${intentQuotes.depositStartedAt} IS NOT NULL)
              )`,
            ),
          ),
      );
      return BigInt(sums?.surplus ?? "0");
    }

    const [sums] = yield* query(() =>
      tx
        .select({
          surplus: sql<string>`coalesce(sum(
            coalesce(${intentQuotes.feeCoverUsdc}, 0) - ${spent}), 0)::text`,
        })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.walletId, walletId),
            notExcluded,
            inArray(intentQuotes.purpose, [...COVERED_PURPOSES]),
            sql`${intentQuotes.depositType} <> 'CONFIDENTIAL_INTENTS'`,
            sql`${intentQuotes.depositStartedAt} IS NOT NULL`,
          ),
        ),
    );
    return BigInt(sums?.surplus ?? "0");
  });
}
