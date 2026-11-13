import { inArray, or, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { OverviewHeading } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { MonthBounds } from "./month.js";
import type { TreasuryMonth } from "./treasury.js";
import { receiptFiles } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { readTreasuryMonth } from "./treasury.js";

/**
 * What a month's export lists (spec §6.11), read inside one company's
 * scope. "Money out in the month" means:
 *
 * - claims paid in the month (imported ones by their date)
 * - petty cash: float spending dated in the month, plus claims with a float
 *   (an overspend's extra), which are claims above. A float's issue or top-up
 *   only moves company money to the holder, so it is listed apart and never
 *   counted as spending.
 * - bills and salaries paid in the month, through Expendi or outside it. A
 *   bill paid outside is also a company spending row (`expenses.bill_id`);
 *   it is listed once, as the bill.
 * - other company spending and Card expenses dated in the month
 */

export type MoneyOutKind =
  "claim" | "float" | "bill" | "salary" | "company" | "card";

export interface MoneyOutRow {
  readonly id: string;
  readonly date: string;
  readonly kind: MoneyOutKind;
  readonly heading: OverviewHeading;
  /** The payee or employee; empty for company spending. */
  readonly person: string;
  readonly merchant: string;
  readonly category: string;
  readonly amountKes: bigint;
  readonly status: string;
  readonly source: string;
  readonly approvedBy: string;
  readonly selfApproved: boolean;
  readonly mpesaCode: string;
  readonly etimsInvoiceNumber: string;
  readonly etimsStatus: string;
  readonly payoutReference: string;
  /** The expense or bill whose receipt files go with this row. */
  readonly receiptOwnerId: string | null;
}

export interface OutstandingBill {
  readonly id: string;
  readonly dueOn: string;
  readonly payee: string;
  readonly category: string;
  readonly heading: OverviewHeading;
  readonly amountKes: bigint | null;
  readonly amountUsdc: bigint | null;
  readonly reference: string;
}

/** A photo or PDF in storage, or a pasted M-Pesa SMS kept inline. */
export type ExportReceipt = {
  readonly id: string;
  readonly ownerId: string;
  readonly contentType: string;
} & (
  | { readonly storageKey: string; readonly smsText: null }
  | { readonly storageKey: null; readonly smsText: string }
);

export interface ExportData {
  readonly moneyOut: readonly MoneyOutRow[];
  readonly floatTransfers: readonly MoneyOutRow[];
  readonly outstanding: readonly OutstandingBill[];
  readonly receipts: readonly ExportReceipt[];
  /** Null for a company without Treasury by the month's end. */
  readonly treasury: TreasuryMonth | null;
}

interface MoneyOutRecord extends Record<string, unknown> {
  readonly id: string;
  readonly date: string;
  readonly kind: MoneyOutKind;
  readonly heading: OverviewHeading;
  readonly person: string;
  readonly merchant: string;
  readonly category: string;
  readonly amount_kes: string | null;
  readonly status: string;
  readonly source: string;
  readonly approved_by: string;
  readonly self_approved: boolean;
  readonly mpesa_code: string;
  readonly etims_invoice_number: string;
  readonly etims_status: string;
  readonly payout_reference: string;
  readonly receipt_owner_id: string | null;
}

interface OutstandingRecord extends Record<string, unknown> {
  readonly id: string;
  readonly due_on: string;
  readonly payee: string;
  readonly category: string;
  readonly heading: OverviewHeading;
  readonly amount_kes: string | null;
  readonly amount_usdc: string | null;
  readonly reference: string;
}

const nameOf = (alias: string) =>
  sql.raw(`coalesce(nullif(btrim(${alias}.full_name), ''), ${alias}.email)`);

/**
 * Paycrest's order ID and the M-Pesa or bank reference, or the transaction
 * hash for a USDC transfer: the company's own send, else the payee chain's
 * transaction that a quote delivered it with (`provider_reference`, which an
 * `onchain` payout only ever fills with a transaction hash).
 */
const payoutReference = sql.raw(
  `CASE WHEN p.provider = 'onchain' THEN coalesce(p.tx_hash, p.provider_reference, '') ELSE concat_ws(' / ', p.provider_order_id, p.provider_reference) END`,
);

function readExpenses(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
) {
  return query(() =>
    tx.execute<MoneyOutRecord>(sql`
      SELECT e.id::text AS id, e.spent_on::text AS date, e.kind::text AS kind,
        e.overview_heading::text AS heading,
        CASE WHEN e.kind = 'company' THEN '' ELSE ${nameOf("u")} END AS person,
        e.merchant, c.name AS category, e.amount_kes::text AS amount_kes,
        e.status::text AS status, e.source::text AS source,
        coalesce(${nameOf("a")}, '') AS approved_by, e.self_approved,
        coalesce(e.mpesa_code, extra.mpesa_code, '') AS mpesa_code,
        coalesce(e.etims_invoice_number, extra.etims_invoice_number, '') AS etims_invoice_number,
        coalesce(extra.etims_status, e.etims_status)::text AS etims_status,
        coalesce(
          (SELECT string_agg(${payoutReference}, '; ' ORDER BY p.paid_at, p.id)
            FROM payouts p
            WHERE p.subject_type = 'claim' AND p.subject_id = e.id AND p.status = 'paid'),
          ''
        ) AS payout_reference,
        coalesce(e.overspend_claim_id, e.id)::text AS receipt_owner_id
      FROM expenses e
      JOIN memberships m ON m.id = e.membership_id
      JOIN users u ON u.id = m.user_id
      JOIN categories c ON c.id = e.category_id
      LEFT JOIN users a ON a.id = e.approved_by
      LEFT JOIN expenses extra ON extra.id = e.overspend_claim_id
      WHERE e.organization_id = ${organizationId}
        AND e.bill_id IS NULL
        AND (
          (e.kind = 'claim' AND e.status = 'paid'
            AND e.paid_at >= ${month.startAt} AND e.paid_at < ${month.endAt})
          OR (e.kind = 'claim' AND e.status = 'paid_outside'
            AND e.spent_on >= ${month.start}::date AND e.spent_on < ${month.end}::date)
          OR (e.kind IN ('float', 'company', 'card') AND e.status = 'recorded'
            AND e.spent_on >= ${month.start}::date AND e.spent_on < ${month.end}::date)
        )
    `),
  );
}

/**
 * A USD bill is valued at what its payouts cost in KES once paid, or at the
 * company spending row once marked paid outside (spec §6.19). A bill paid by
 * card is valued at its spending row, and nobody approved it. A split salary
 * is one row for the person, with every part's reference.
 */
function readPaidBills(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
) {
  return query(() =>
    tx.execute<MoneyOutRecord>(sql`
      SELECT b.id::text AS id, b.paid_on::text AS date,
        CASE WHEN b.payroll_run_id IS NULL THEN 'bill' ELSE 'salary' END AS kind,
        b.overview_heading::text AS heading, pe.name AS person,
        CASE WHEN b.payroll_run_id IS NULL THEN pe.name ELSE '' END AS merchant,
        c.name AS category,
        (CASE
          WHEN b.status = 'paid_by_card' THEN s.amount_kes
          WHEN b.currency = 'kes' THEN b.amount_kes
          WHEN b.status = 'paid_outside' THEN s.amount_kes
          ELSE paid.amount_kes
        END)::text AS amount_kes,
        b.status::text AS status, coalesce(s.source::text, 'app') AS source,
        coalesce(
          CASE WHEN b.status = 'paid_outside' THEN ${nameOf("mk")} ELSE paid.approved_by END,
          ''
        ) AS approved_by,
        false AS self_approved,
        coalesce(s.mpesa_code, '') AS mpesa_code,
        coalesce(s.etims_invoice_number, '') AS etims_invoice_number,
        coalesce(s.etims_status::text, '') AS etims_status,
        coalesce(paid.reference, '') AS payout_reference,
        b.id::text AS receipt_owner_id
      FROM bills b
      JOIN payees pe ON pe.id = b.payee_id
      JOIN categories c ON c.id = b.category_id
      LEFT JOIN expenses s ON s.bill_id = b.id
      LEFT JOIN users mk ON mk.id = b.marked_paid_by
      LEFT JOIN LATERAL (
        SELECT sum(p.amount_kes) AS amount_kes,
          string_agg(${payoutReference}, '; ' ORDER BY p.subject_part, p.paid_at) AS reference,
          (array_agg(${nameOf("pa")} ORDER BY p.approved_at DESC))[1] AS approved_by
        FROM payouts p
        LEFT JOIN users pa ON pa.id = p.approved_by
        WHERE p.subject_type = 'bill' AND p.subject_id = b.id AND p.status = 'paid'
      ) paid ON true
      WHERE b.organization_id = ${organizationId}
        AND b.status IN ('paid', 'paid_outside', 'paid_by_card')
        AND b.paid_on >= ${month.start}::date AND b.paid_on < ${month.end}::date
    `),
  );
}

function readFloatTransfers(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
) {
  return query(() =>
    tx.execute<MoneyOutRecord>(sql`
      SELECT fm.id::text AS id,
        (fm.paid_at AT TIME ZONE 'Africa/Nairobi')::date::text AS date,
        'float' AS kind, 'petty_cash' AS heading, ${nameOf("u")} AS person,
        '' AS merchant, '' AS category, fm.amount_kes::text AS amount_kes,
        fm.type::text AS status, 'app' AS source,
        coalesce(${nameOf("a")}, '') AS approved_by, false AS self_approved,
        '' AS mpesa_code, '' AS etims_invoice_number, '' AS etims_status,
        ${payoutReference} AS payout_reference, NULL AS receipt_owner_id
      FROM float_movements fm
      JOIN floats f ON f.id = fm.float_id
      JOIN memberships m ON m.id = f.membership_id
      JOIN users u ON u.id = m.user_id
      JOIN payouts p ON p.id = fm.payout_id
      LEFT JOIN users a ON a.id = p.approved_by
      WHERE fm.organization_id = ${organizationId}
        AND fm.type IN ('issue', 'top_up') AND fm.status = 'paid'
        AND fm.paid_at >= ${month.startAt} AND fm.paid_at < ${month.endAt}
      ORDER BY fm.paid_at, fm.id
    `),
  );
}

/**
 * Bills still owed when the month ended, worked out from their dates so any
 * past month reads as it stood then: due by its last day, already entered,
 * and neither paid nor cancelled before it ended.
 */
function readOutstanding(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
) {
  return query(() =>
    tx.execute<OutstandingRecord>(sql`
      SELECT b.id::text AS id, b.due_on::text AS due_on, pe.name AS payee,
        c.name AS category, b.overview_heading::text AS heading,
        b.amount_kes::text AS amount_kes, b.amount_usdc::text AS amount_usdc,
        coalesce(b.reference, '') AS reference
      FROM bills b
      JOIN payees pe ON pe.id = b.payee_id
      JOIN categories c ON c.id = b.category_id
      WHERE b.organization_id = ${organizationId}
        AND b.due_on < ${month.end}::date
        AND b.created_at < ${month.endAt}
        AND (b.paid_on IS NULL OR b.paid_on >= ${month.end}::date)
        AND (b.cancelled_at IS NULL OR b.cancelled_at >= ${month.endAt})
      ORDER BY b.due_on, pe.name, b.id
    `),
  );
}

function readReceipts(
  tx: Transaction,
  ownerIds: readonly string[],
): Effect.Effect<ExportReceipt[], DatabaseError> {
  if (ownerIds.length === 0) return Effect.succeed([]);
  const owners = [...new Set(ownerIds)];
  return query(() =>
    tx
      .select({
        id: receiptFiles.id,
        expenseId: receiptFiles.expenseId,
        billId: receiptFiles.billId,
        storageKey: receiptFiles.storageKey,
        smsText: receiptFiles.smsText,
        contentType: receiptFiles.contentType,
      })
      .from(receiptFiles)
      .where(
        or(
          inArray(receiptFiles.expenseId, owners),
          inArray(receiptFiles.billId, owners),
        ),
      )
      .orderBy(receiptFiles.createdAt, receiptFiles.id),
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap(
        ({
          id,
          expenseId,
          billId,
          storageKey,
          smsText,
          contentType,
        }): ExportReceipt[] => {
          const ownerId = expenseId ?? billId;
          if (!ownerId) return [];
          const common = { id, ownerId, contentType };
          if (storageKey !== null) {
            return [{ ...common, storageKey, smsText: null }];
          }
          return smsText === null ? [] : [{ ...common, storageKey, smsText }];
        },
      ),
    ),
  );
}

const KIND_ORDER: Readonly<Record<MoneyOutKind, number>> = {
  claim: 0,
  float: 1,
  company: 2,
  card: 3,
  bill: 4,
  salary: 5,
};

function toMoneyOut(record: MoneyOutRecord): MoneyOutRow {
  return {
    id: record.id,
    date: record.date,
    kind: record.kind,
    heading: record.heading,
    person: record.person,
    merchant: record.merchant,
    category: record.category,
    amountKes: BigInt(record.amount_kes ?? "0"),
    status: record.status,
    source: record.source,
    approvedBy: record.approved_by,
    selfApproved: record.self_approved,
    mpesaCode: record.mpesa_code,
    etimsInvoiceNumber: record.etims_invoice_number,
    etimsStatus: record.etims_status,
    payoutReference: record.payout_reference,
    receiptOwnerId: record.receipt_owner_id,
  };
}

const byDateThenKind = (a: MoneyOutRow, b: MoneyOutRow): number =>
  a.date.localeCompare(b.date) ||
  KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
  a.person.localeCompare(b.person) ||
  a.id.localeCompare(b.id);

/** Run inside the company's scope, as an admin or an accountant. */
export function readExportData(
  tx: Transaction,
  organizationId: string,
  month: MonthBounds,
): Effect.Effect<ExportData, DatabaseError> {
  return Effect.gen(function* () {
    const expenses = yield* readExpenses(tx, organizationId, month);
    const bills = yield* readPaidBills(tx, organizationId, month);
    const transfers = yield* readFloatTransfers(tx, organizationId, month);
    const outstanding = yield* readOutstanding(tx, organizationId, month);
    const moneyOut = [...expenses.rows, ...bills.rows]
      .map(toMoneyOut)
      .sort(byDateThenKind);
    const receipts = yield* readReceipts(
      tx,
      moneyOut.flatMap((row) =>
        row.receiptOwnerId ? [row.receiptOwnerId] : [],
      ),
    );
    return {
      moneyOut,
      floatTransfers: transfers.rows.map(toMoneyOut),
      outstanding: outstanding.rows.map((record) => ({
        id: record.id,
        dueOn: record.due_on,
        payee: record.payee,
        category: record.category,
        heading: record.heading,
        amountKes:
          record.amount_kes === null ? null : BigInt(record.amount_kes),
        amountUsdc:
          record.amount_usdc === null ? null : BigInt(record.amount_usdc),
        reference: record.reference,
      })),
      receipts,
      treasury: yield* readTreasuryMonth(tx, organizationId, month),
    };
  });
}
