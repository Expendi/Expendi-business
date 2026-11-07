import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DbScope, Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { query, withScope } from "../../db/scope.js";
import { csvFile, kesCell } from "./format.js";
import { monthBounds } from "./month.js";
import { ETIMS_LABELS } from "./render.js";

export interface EtimsRecord extends Record<string, unknown> {
  readonly date: string;
  readonly merchant: string;
  readonly amount_kes: string;
  readonly etims_status: string;
  readonly invoice: string;
  readonly supplier_pin: string;
}

/**
 * The eTIMS report's rows (spec §6.14): every expense dated in the month,
 * paid or not, with its eTIMS details. A rejected claim isn't a company
 * purchase, so it's left out. An overspend is one purchase: its float
 * spending row carries the whole amount and the extra claim's invoice, and
 * the extra claim isn't listed again. Run inside the company's scope, as
 * an admin or an accountant.
 */
export function readEtimsRows(
  tx: Transaction,
  organizationId: string,
  month: string,
): Effect.Effect<EtimsRecord[], DatabaseError> {
  const { start, end } = monthBounds(month);
  return query(() =>
    tx.execute<EtimsRecord>(sql`
      SELECT e.spent_on::text AS date, e.merchant,
        (e.amount_kes + coalesce(extra.amount_kes, 0))::text AS amount_kes,
        CASE WHEN e.source = 'import' THEN ''
          ELSE coalesce(extra.etims_status, e.etims_status)::text END AS etims_status,
        coalesce(e.etims_invoice_number, extra.etims_invoice_number, '') AS invoice,
        coalesce(e.etims_supplier_pin, extra.etims_supplier_pin, '') AS supplier_pin
      FROM expenses e
      LEFT JOIN expenses extra ON extra.id = e.overspend_claim_id
      WHERE e.organization_id = ${organizationId}
        AND e.spent_on >= ${start}::date AND e.spent_on < ${end}::date
        AND e.status <> 'rejected'
        AND NOT EXISTS (
          SELECT 1 FROM expenses paired WHERE paired.overspend_claim_id = e.id
        )
      ORDER BY e.spent_on, e.id
    `),
  ).pipe(Effect.map(({ rows }) => rows));
}

/**
 * The eTIMS report as a CSV, from a read-only transaction, so downloading
 * it can never change anything.
 */
export function renderEtimsReport(
  scope: DbScope & { readonly organizationId: string },
  month: string,
): Effect.Effect<Uint8Array, DatabaseError, DatabaseService> {
  return withScope(scope, (tx) =>
    query(() => tx.execute(sql`SET TRANSACTION READ ONLY`)).pipe(
      Effect.zipRight(readEtimsRows(tx, scope.organizationId, month)),
    ),
  ).pipe(
    Effect.map((rows) =>
      csvFile([
        [
          "Date",
          "Merchant",
          "Amount (KES)",
          "eTIMS status",
          "Invoice number",
          "Supplier PIN",
        ],
        ...rows.map((row) => [
          row.date,
          row.merchant,
          kesCell(BigInt(row.amount_kes)),
          ETIMS_LABELS[row.etims_status] ?? row.etims_status,
          row.invoice,
          row.supplier_pin,
        ]),
      ]),
    ),
  );
}
