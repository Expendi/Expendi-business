import type { CashOutReceipt } from "@expendi-business/shared";

/**
 * Receipts as each screen's tests give them, and how the receipt row then
 * reads: label, codes in order, and each copy button's accessible name.
 */
export const RECEIPT_SAMPLES: readonly {
  readonly name: string;
  readonly receipts: readonly CashOutReceipt[];
  readonly reads: string;
}[] = [
  {
    name: "an M-Pesa receipt",
    receipts: [{ kind: "mpesa", code: "UKDCW299LW" }],
    reads: "M-Pesa receipt UKDCW299LW Copy M-Pesa receipt UKDCW299LW",
  },
  {
    name: "a bank reference",
    receipts: [{ kind: "bank", code: "FT26317XK9QZ" }],
    reads: "Bank reference FT26317XK9QZ Copy Bank reference FT26317XK9QZ",
  },
  {
    name: "a split payment's receipts, in order",
    receipts: [
      { kind: "mpesa", code: "UKD1AAAAAA" },
      { kind: "mpesa", code: "UKD2BBBBBB" },
    ],
    reads:
      "M-Pesa receipts UKD1AAAAAA Copy M-Pesa receipt UKD1AAAAAA UKD2BBBBBB Copy M-Pesa receipt UKD2BBBBBB",
  },
];

/** A page's text as one line, tags dropped. */
export const pageText = (html: string): string =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Whether any receipt row shows. */
export const showsReceipt = (text: string): boolean =>
  /M-Pesa receipt|Bank reference/.test(text);
