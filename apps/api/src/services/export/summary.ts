import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { ReportMonthSummary } from "@expendi-business/shared";
import {
  REPORT_PREVIEW_ETIMS_ROWS,
  REPORT_PREVIEW_RECEIPTS,
  REPORT_PREVIEW_ROWS,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DbScope } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { ExportData, MoneyOutRow } from "./data.js";
import type { EtimsRecord } from "./etims.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { readExportData } from "./data.js";
import { readEtimsRows } from "./etims.js";
import { monthBounds } from "./month.js";
import { nameReceipts } from "./render.js";

/**
 * What a month's export files and eTIMS report hold (spec §6.11, §6.14),
 * read exactly as the files are made, for the reports page's figures and
 * its "What's inside" previews. Nothing is rendered or stored.
 */

const EXPENSE_KINDS: ReadonlySet<MoneyOutRow["kind"]> = new Set([
  "claim",
  "float",
  "company",
]);

const ETIMS_STATUSES = ["attached", "none", "not_required", ""] as const;
type EtimsStatus = (typeof ETIMS_STATUSES)[number];

const etimsStatusOf = (value: string): EtimsStatus =>
  ETIMS_STATUSES.find((status) => status === value) ?? "";

const sum = (amounts: readonly bigint[]): bigint =>
  amounts.reduce((total, amount) => total + amount, 0n);

function summarise(
  month: string,
  data: ExportData,
  etims: readonly EtimsRecord[],
  today: string,
): ReportMonthSummary {
  const { lastDay } = monthBounds(month);
  const overdueBefore = today < lastDay ? today : lastDay;
  const { files, byOwner } = nameReceipts(data.moneyOut, data.receipts);
  const withoutReceipt = data.moneyOut.filter(
    (row) =>
      EXPENSE_KINDS.has(row.kind) &&
      row.source !== "import" &&
      (row.receiptOwnerId === null ||
        (byOwner.get(row.receiptOwnerId) ?? []).length === 0),
  );
  const countEtims = (status: EtimsStatus) =>
    etims.filter((row) => etimsStatusOf(row.etims_status) === status).length;
  const kesBills = data.outstanding.flatMap((bill) =>
    bill.amountKes === null ? [] : [bill.amountKes],
  );
  const usdBills = data.outstanding.flatMap((bill) =>
    bill.amountUsdc === null ? [] : [bill.amountUsdc],
  );
  return {
    month,
    moneyOut: {
      rows: data.moneyOut.length,
      importedRows: data.moneyOut.filter((row) => row.source === "import")
        .length,
      totalKes: sum(data.moneyOut.map((row) => row.amountKes)).toString(),
      preview: data.moneyOut.slice(0, REPORT_PREVIEW_ROWS).map((row) => ({
        date: row.date,
        kind: row.kind,
        name: row.person === "" ? row.merchant : row.person,
        amountKes: row.amountKes.toString(),
      })),
    },
    outstanding: {
      rows: data.outstanding.length,
      totalKes: sum(kesBills).toString(),
      totalUsdc: sum(usdBills).toString(),
      overdue: data.outstanding.filter((bill) => bill.dueOn < overdueBefore)
        .length,
      withoutAmount: data.outstanding.filter(
        (bill) => bill.amountKes === null && bill.amountUsdc === null,
      ).length,
      preview: data.outstanding.slice(0, REPORT_PREVIEW_ROWS).map((bill) => ({
        dueOn: bill.dueOn,
        payee: bill.payee,
        overdue: bill.dueOn < overdueBefore,
        amountKes: bill.amountKes?.toString() ?? null,
        amountUsdc: bill.amountUsdc?.toString() ?? null,
      })),
    },
    floatTransfers: {
      rows: data.floatTransfers.length,
      preview: data.floatTransfers.slice(0, REPORT_PREVIEW_ROWS).map((row) => ({
        date: row.date,
        type: row.status === "issue" ? ("issue" as const) : ("top_up" as const),
        person: row.person,
        amountKes: row.amountKes.toString(),
      })),
    },
    receipts: {
      files: files.length,
      names: files.slice(0, REPORT_PREVIEW_RECEIPTS).map(({ name }) => name),
      expensesWithout: withoutReceipt.length,
      withoutPreview: withoutReceipt
        .slice(0, REPORT_PREVIEW_ROWS)
        .map((row) => ({
          date: row.date,
          merchant: row.merchant,
          amountKes: row.amountKes.toString(),
        })),
    },
    etims: {
      rows: etims.length,
      attached: countEtims("attached"),
      none: countEtims("none"),
      notRequired: countEtims("not_required"),
      preview: etims.slice(0, REPORT_PREVIEW_ETIMS_ROWS).map((row) => ({
        date: row.date,
        merchant: row.merchant,
        amountKes: row.amount_kes,
        status: etimsStatusOf(row.etims_status),
      })),
    },
  };
}

/** `month`'s files as they'd be downloaded now, from a read-only transaction. */
export function reportMonthSummary(
  scope: DbScope & { readonly organizationId: string },
  month: string,
  now: Date = new Date(),
): Effect.Effect<ReportMonthSummary, DatabaseError, DatabaseService> {
  return withScope(scope, (tx) =>
    Effect.gen(function* () {
      yield* query(() => tx.execute(sql`SET TRANSACTION READ ONLY`));
      const data = yield* readExportData(
        tx,
        scope.organizationId,
        monthBounds(month),
      );
      const etims = yield* readEtimsRows(tx, scope.organizationId, month);
      return summarise(month, data, etims, nairobiDate(now));
    }),
  );
}
