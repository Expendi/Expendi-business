import type {
  CashOutReceipt,
  CashOutReceiptKind,
} from "@expendi-business/shared";
import { cashOutReceiptLabel } from "@expendi-business/shared";

export interface ReceiptRow {
  readonly label: string;
  /** The codes in the order they were paid, e.g. "UKDCW299LW, UKDCW301MX". */
  readonly value: string;
}

const CODE_SEPARATOR = ", ";

/**
 * One row per kind of receipt, in the order the cash-outs were paid; none
 * until a cash-out is paid. A salary split into several cash-outs has
 * several codes on one row.
 */
export function cashOutReceiptRows(
  receipts: readonly CashOutReceipt[],
): ReceiptRow[] {
  const codesByKind = new Map<CashOutReceiptKind, string[]>();
  for (const receipt of receipts) {
    const codes = codesByKind.get(receipt.kind) ?? [];
    codes.push(receipt.code);
    codesByKind.set(receipt.kind, codes);
  }
  return [...codesByKind].map(([kind, codes]) => ({
    label: cashOutReceiptLabel(kind, codes.length),
    value: codes.join(CODE_SEPARATOR),
  }));
}

const COPY_LABELS: Readonly<
  Record<CashOutReceiptKind, { one: string; many: string }>
> = {
  mpesa: { one: "Copy M-Pesa receipt", many: "Copy M-Pesa receipts" },
  bank: { one: "Copy bank reference", many: "Copy bank references" },
};

/** What a copy button copies and says; null when there's nothing to copy. */
export function cashOutReceiptCopy(
  receipts: readonly CashOutReceipt[],
): { label: string; value: string } | null {
  const [first] = receipts;
  if (!first) return null;
  const value = receipts.map((receipt) => receipt.code).join(CODE_SEPARATOR);
  if (receipts.some((receipt) => receipt.kind !== first.kind)) {
    return { label: "Copy the codes", value };
  }
  const labels = COPY_LABELS[first.kind];
  return { label: receipts.length === 1 ? labels.one : labels.many, value };
}
