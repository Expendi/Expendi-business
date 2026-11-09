import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import { cardPurchases } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Lithic } from "../lithic/lithic-client.js";
import { applyCardTransaction, companyScope } from "./transactions.js";

/**
 * Every minute, checks unfinished Card purchases against Lithic: a missed
 * webhook, a hold that outlived its authorization, or a settled purchase
 * whose Card expense couldn't be recorded. It only reads Lithic. One failure
 * holds up nothing else; the row is simply tried again later.
 */

interface PurchaseToCheck extends Record<string, unknown> {
  readonly organization_id: string;
  readonly transaction_token: string;
}

export interface ReconcileCardPurchasesSummary {
  readonly checked: number;
  readonly failed: number;
}

export function reconcileCardPurchases(
  maxRows = 50,
): Effect.Effect<
  ReconcileCardPurchasesSummary,
  DatabaseError,
  DatabaseService | Lithic | Paycrest | AuditLog
> {
  return Effect.gen(function* () {
    const lithic = yield* Lithic;
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PurchaseToCheck>(
          sql`SELECT organization_id, transaction_token FROM card_purchases_to_reconcile(${maxRows})`,
        ),
      ),
    );
    let failed = 0;
    for (const row of rows) {
      const exit = yield* Effect.exit(
        lithic
          .getTransaction(row.transaction_token)
          .pipe(Effect.flatMap(applyCardTransaction)),
      );
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[reconcile-lithic] ${row.transaction_token} failed`,
          Cause.pretty(exit.cause),
        );
      }
      // Stalest first: rows that can't be finished yet must not starve the rest.
      yield* withScope(companyScope(row.organization_id), (tx) =>
        query(() =>
          tx
            .update(cardPurchases)
            .set({ updatedAt: new Date() })
            .where(
              eq(cardPurchases.lithicTransactionToken, row.transaction_token),
            ),
        ),
      );
    }
    return { checked: rows.length, failed };
  });
}
