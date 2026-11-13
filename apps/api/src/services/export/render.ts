import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { strToU8 } from "fflate";

import type { ExportFile } from "@expendi-business/shared";
import {
  OVERVIEW_HEADING_LABELS,
  reportFilename,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DbScope } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { StorageError } from "../storage/file-storage.js";
import type {
  ExportData,
  ExportReceipt,
  MoneyOutKind,
  MoneyOutRow,
  OutstandingBill,
} from "./data.js";
import type { Cell, Row, Sheet, ZipEntry } from "./format.js";
import type { TreasuryMonth, TreasuryValue } from "./treasury.js";
import { query, withScope } from "../../db/scope.js";
import { ServiceUnavailable } from "../../errors.js";
import { FileStorage } from "../storage/file-storage.js";
import { readExportData } from "./data.js";
import {
  csvFile,
  kesCell,
  kesDecimal,
  usdCell,
  workbookFile,
  zipFile,
} from "./format.js";
import { monthBounds } from "./month.js";

/** The main sheet's columns, in the order spec §6.11 lists them. */
export const MONEY_OUT_COLUMNS = [
  "Date",
  "Kind",
  "Overview heading",
  "Payee or employee",
  "Merchant",
  "Category",
  "Amount (KES)",
  "Status",
  "Source",
  "Approved by",
  "Self-approved",
  "M-Pesa code",
  "eTIMS invoice number",
  "eTIMS status",
  "Receipt file",
  "Payout reference",
] as const;

export const OUTSTANDING_COLUMNS = [
  "Due date",
  "Payee",
  "Overview heading",
  "Category",
  "Amount (KES)",
  "Amount (USD)",
  "Status at month end",
  "Reference",
] as const;

/** The Treasury sheet: one row for the month, for companies with Treasury on. */
export const TREASURY_COLUMNS = [
  "Value at the start (USD)",
  "Start value read on",
  "Value at the end (USD)",
  "End value read on",
  "Moved to Treasury (USD)",
  "Moved to wallet (USD)",
  "Yield for the month (USD)",
  "Cost of moves (USD)",
] as const;

/** The Treasury moves sheet: one row per move that ended in the month. */
export const TREASURY_MOVE_COLUMNS = [
  "Date",
  "Direction",
  "Amount that left (USD)",
  "Amount that arrived (USD)",
  "Cost (USD)",
  "Transaction references",
] as const;

export const SHEET_NAMES = {
  moneyOut: "Money out",
  outstanding: "Outstanding bills",
  floatTransfers: "Float transfers",
  treasury: "Treasury",
  treasuryMoves: "Treasury moves",
} as const;

export const NO_SNAPSHOT = "No snapshot";

const KIND_LABELS: Readonly<Record<MoneyOutKind, string>> = {
  claim: "Reimbursement",
  float: "Float",
  bill: "Bill",
  salary: "Salary",
  company: "Company",
  card: "Expendi card",
};

const STATUS_LABELS: Readonly<Record<string, string>> = {
  paid: "Paid",
  paid_outside: "Paid outside Expendi",
  recorded: "Recorded",
  issue: "Float issued",
  top_up: "Float topped up",
};

export const ETIMS_LABELS: Readonly<Record<string, string>> = {
  attached: "Attached",
  not_required: "Not required",
  none: "None",
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  app: "App",
  import: "Import",
};

const EXTENSIONS: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/heif": "heif",
  "application/pdf": "pdf",
};

const slug = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");

/** Whole shillings as `1500`, otherwise `1499.50`. */
const filenameAmount = (cents: bigint): string =>
  cents % 100n === 0n ? (cents / 100n).toString() : kesDecimal(cents);

/**
 * `YYYY-MM-DD_person_merchant_amount.ext` (spec §6.11), e.g.
 * `2026-11-03_jane-wanjiku_java-house_1500.jpg`. Parts left empty, or a
 * merchant that is the payee itself, are skipped.
 */
function receiptStem(row: MoneyOutRow): string {
  const person = slug(row.person);
  const merchant = slug(row.merchant);
  return [
    row.date,
    person,
    merchant === person ? "" : merchant,
    filenameAmount(row.amountKes),
  ]
    .filter((part) => part !== "")
    .join("_");
}

const extensionOf = (receipt: ExportReceipt): string =>
  receipt.smsText === null ? (EXTENSIONS[receipt.contentType] ?? "bin") : "txt";

export interface NamedReceipt {
  readonly name: string;
  readonly receipt: ExportReceipt;
}

/**
 * Names every receipt once, after the first row it belongs to, and gives
 * each row the names of its files. A clash gets `_2`, `_3`, … before the
 * extension. An overspend's float spending and its claim share the
 * purchase's receipts, so both rows list the same files.
 */
export function nameReceipts(
  rows: readonly MoneyOutRow[],
  receipts: readonly ExportReceipt[],
): { readonly files: NamedReceipt[]; readonly byOwner: Map<string, string[]> } {
  const byOwnerId = new Map<string, ExportReceipt[]>();
  for (const receipt of receipts) {
    byOwnerId.set(receipt.ownerId, [
      ...(byOwnerId.get(receipt.ownerId) ?? []),
      receipt,
    ]);
  }
  const used = new Set<string>();
  const files: NamedReceipt[] = [];
  const byOwner = new Map<string, string[]>();
  for (const row of rows) {
    const ownerId = row.receiptOwnerId;
    if (ownerId === null || byOwner.has(ownerId)) continue;
    const stem = receiptStem(row);
    const names = (byOwnerId.get(ownerId) ?? []).map((receipt) => {
      const extension = extensionOf(receipt);
      let name = `${stem}.${extension}`;
      for (let suffix = 2; used.has(name); suffix += 1) {
        name = `${stem}_${suffix}.${extension}`;
      }
      used.add(name);
      files.push({ name, receipt });
      return name;
    });
    byOwner.set(ownerId, names);
  }
  return { files, byOwner };
}

function moneyOutRow(row: MoneyOutRow, receiptNames: readonly string[]): Row {
  return [
    row.date,
    KIND_LABELS[row.kind],
    OVERVIEW_HEADING_LABELS[row.heading],
    row.person,
    row.merchant,
    row.category,
    kesCell(row.amountKes),
    STATUS_LABELS[row.status] ?? row.status,
    SOURCE_LABELS[row.source] ?? row.source,
    row.approvedBy,
    row.selfApproved ? "Yes" : "No",
    row.mpesaCode,
    row.etimsInvoiceNumber,
    ETIMS_LABELS[row.etimsStatus] ?? row.etimsStatus,
    receiptNames.join("; "),
    row.payoutReference,
  ];
}

function outstandingRow(bill: OutstandingBill, lastDay: string): Row {
  return [
    bill.dueOn,
    bill.payee,
    OVERVIEW_HEADING_LABELS[bill.heading],
    bill.category,
    bill.amountKes === null ? "" : kesCell(bill.amountKes),
    bill.amountUsdc === null ? "" : usdCell(bill.amountUsdc),
    bill.dueOn === lastDay ? "Due" : "Overdue",
    bill.reference,
  ];
}

const DIRECTION_LABELS = {
  to_treasury: "To Treasury",
  to_wallet: "To wallet",
} as const;

/** A missing snapshot is said, not left blank or shown as zero. */
const valueCell = (value: TreasuryValue): Cell =>
  value.usdc === null ? NO_SNAPSHOT : usdCell(value.usdc);

const valueDay = (value: TreasuryValue): string =>
  value.snapshotDate ??
  (value.note === "turned_on_later"
    ? "Treasury was turned on after this date"
    : "");

function treasurySheets(treasury: TreasuryMonth): {
  readonly summary: Sheet;
  readonly moves: Sheet;
} {
  return {
    summary: {
      name: SHEET_NAMES.treasury,
      rows: [
        TREASURY_COLUMNS,
        [
          valueCell(treasury.opening),
          valueDay(treasury.opening),
          valueCell(treasury.closing),
          valueDay(treasury.closing),
          usdCell(treasury.movedToTreasuryUsdc),
          usdCell(treasury.movedToWalletUsdc),
          treasury.yieldUsdc === null
            ? NO_SNAPSHOT
            : usdCell(treasury.yieldUsdc),
          usdCell(treasury.costUsdc),
        ],
      ],
    },
    moves: {
      name: SHEET_NAMES.treasuryMoves,
      rows: [
        TREASURY_MOVE_COLUMNS,
        ...treasury.moves.map((move): Row => [
          move.date,
          DIRECTION_LABELS[move.direction],
          usdCell(move.leftUsdc),
          usdCell(move.arrivedUsdc),
          usdCell(move.costUsdc),
          move.references.join("; "),
        ]),
      ],
    },
  };
}

export interface ExportSheets {
  readonly moneyOut: Sheet;
  readonly outstanding: Sheet;
  readonly floatTransfers: Sheet;
  /** Only for a company with Treasury on. */
  readonly treasury: {
    readonly summary: Sheet;
    readonly moves: Sheet;
  } | null;
  readonly receipts: readonly NamedReceipt[];
}

export function exportSheets(data: ExportData, month: string): ExportSheets {
  const { lastDay } = monthBounds(month);
  const { files, byOwner } = nameReceipts(data.moneyOut, data.receipts);
  const namesOf = (row: MoneyOutRow) =>
    row.receiptOwnerId === null ? [] : (byOwner.get(row.receiptOwnerId) ?? []);
  return {
    moneyOut: {
      name: SHEET_NAMES.moneyOut,
      rows: [
        MONEY_OUT_COLUMNS,
        ...data.moneyOut.map((row) => moneyOutRow(row, namesOf(row))),
      ],
    },
    outstanding: {
      name: SHEET_NAMES.outstanding,
      rows: [
        OUTSTANDING_COLUMNS,
        ...data.outstanding.map((bill) => outstandingRow(bill, lastDay)),
      ],
    },
    floatTransfers: {
      name: SHEET_NAMES.floatTransfers,
      rows: [
        MONEY_OUT_COLUMNS,
        ...data.floatTransfers.map((row) => moneyOutRow(row, [])),
      ],
    },
    treasury: data.treasury ? treasurySheets(data.treasury) : null,
    receipts: files,
  };
}

export const EXPORT_CONTENT_TYPES: Readonly<Record<ExportFile, string>> = {
  workbook: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "application/zip",
  receipts: "application/zip",
};

export const exportFilename = (month: string, file: ExportFile): string =>
  reportFilename(month, file);

/** Files are dated noon on the month's first day, so a month renders the same bytes each time. */
const fileTime = (month: string): Date => new Date(`${month}-01T12:00:00Z`);

export type RenderedExport = Readonly<Record<ExportFile, Uint8Array>>;

const receiptMissing = new ServiceUnavailable({
  message:
    "A receipt couldn't be read from storage, so the export wasn't made. Try again in a few minutes.",
});

function loadReceipts(
  receipts: readonly NamedReceipt[],
): Effect.Effect<ZipEntry[], ServiceUnavailable | StorageError, FileStorage> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    return yield* Effect.forEach(
      receipts,
      ({
        name,
        receipt,
      }): Effect.Effect<ZipEntry, ServiceUnavailable | StorageError> =>
        receipt.storageKey === null
          ? Effect.succeed({ name, bytes: strToU8(receipt.smsText) })
          : storage
              .get(receipt.storageKey)
              .pipe(
                Effect.flatMap((stored) =>
                  stored
                    ? Effect.succeed({ name, bytes: stored.bytes, store: true })
                    : Effect.fail(receiptMissing),
                ),
              ),
      { concurrency: 4 },
    );
  });
}

/**
 * Reads one company's month and renders the export's files. With
 * `receipts: false` the zip is left empty, for downloads that don't need it.
 * A receipt that can't be read fails the whole export: an archive quietly
 * missing a receipt is worse than none.
 */
export function renderExport(
  scope: DbScope & { readonly organizationId: string },
  month: string,
  options: { readonly receipts: boolean } = { receipts: true },
): Effect.Effect<
  RenderedExport,
  ServiceUnavailable | DatabaseError | StorageError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const data = yield* withScope(scope, (tx) =>
      query(() => tx.execute(sql`SET TRANSACTION READ ONLY`)).pipe(
        Effect.zipRight(
          readExportData(tx, scope.organizationId, monthBounds(month)),
        ),
      ),
    );
    const sheets = exportSheets(data, month);
    const mtime = fileTime(month);
    const receipts = options.receipts
      ? yield* loadReceipts(sheets.receipts)
      : [];
    return {
      workbook: workbookFile(
        [
          sheets.moneyOut,
          sheets.outstanding,
          sheets.floatTransfers,
          ...(sheets.treasury
            ? [sheets.treasury.summary, sheets.treasury.moves]
            : []),
        ],
        mtime,
      ),
      csv: zipFile(
        [
          { name: "money-out.csv", bytes: csvFile(sheets.moneyOut.rows) },
          {
            name: "outstanding-bills.csv",
            bytes: csvFile(sheets.outstanding.rows),
          },
          {
            name: "float-transfers.csv",
            bytes: csvFile(sheets.floatTransfers.rows),
          },
          ...(sheets.treasury
            ? [
                {
                  name: "treasury.csv",
                  bytes: csvFile(sheets.treasury.summary.rows),
                },
                {
                  name: "treasury-moves.csv",
                  bytes: csvFile(sheets.treasury.moves.rows),
                },
              ]
            : []),
        ],
        mtime,
      ),
      receipts: zipFile(receipts, mtime),
    };
  });
}
