import { z } from "zod";

/**
 * The receipt a paid cash-out leaves: the M-Pesa receipt for an M-Pesa
 * number, Till or Paybill, or the bank's reference for a bank transfer. A
 * USDC payout has none.
 */
export const CASH_OUT_RECEIPT_KINDS = ["mpesa", "bank"] as const;
export const cashOutReceiptKindSchema = z.enum(CASH_OUT_RECEIPT_KINDS);
export type CashOutReceiptKind = z.infer<typeof cashOutReceiptKindSchema>;

export const cashOutReceiptSchema = z.object({
  kind: cashOutReceiptKindSchema,
  /** As the payee sees it, e.g. the M-Pesa code `UKDCW299LW`. */
  code: z.string().min(1),
});

export type CashOutReceipt = z.infer<typeof cashOutReceiptSchema>;

/**
 * `paymentReceipts` on anything a cash-out pays: one per paid cash-out, in
 * the order they were paid out (a salary split into several cash-outs has
 * several), empty until one is paid. Always sent; optional only for clients
 * built before it.
 */
export const paymentReceiptsSchema = z
  .array(cashOutReceiptSchema)
  .optional()
  .default(() => []);

const RECEIPT_LABELS: Readonly<
  Record<CashOutReceiptKind, { one: string; many: string }>
> = {
  mpesa: { one: "M-Pesa receipt", many: "M-Pesa receipts" },
  bank: { one: "Bank reference", many: "Bank references" },
};

/** What to call `count` receipts of `kind`, e.g. "M-Pesa receipts". */
export function cashOutReceiptLabel(
  kind: CashOutReceiptKind,
  count = 1,
): string {
  const labels = RECEIPT_LABELS[kind];
  return count === 1 ? labels.one : labels.many;
}
