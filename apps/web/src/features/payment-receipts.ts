import type {
  CashOutReceipt,
  CashOutReceiptKind,
} from "@expendi-business/shared";
import { cashOutReceiptLabel } from "@expendi-business/shared";

/** One row of a paid cash-out's receipts: "M-Pesa receipts" and their codes. */
export interface ReceiptRow {
  readonly kind: CashOutReceiptKind;
  readonly label: string;
  readonly codes: readonly string[];
}

/**
 * The rows a payment's receipts make, codes in the order they were paid:
 * one per kind, so a salary split into several M-Pesa cash-outs is one
 * "M-Pesa receipts" row. None until a cash-out is paid.
 */
export function receiptRows(
  receipts: readonly CashOutReceipt[],
): readonly ReceiptRow[] {
  const codes = new Map<CashOutReceiptKind, string[]>();
  for (const receipt of receipts) {
    const kindCodes = codes.get(receipt.kind) ?? [];
    kindCodes.push(receipt.code);
    codes.set(receipt.kind, kindCodes);
  }
  return [...codes].map(([kind, kindCodes]) => ({
    kind,
    label: cashOutReceiptLabel(kind, kindCodes.length),
    codes: kindCodes,
  }));
}
