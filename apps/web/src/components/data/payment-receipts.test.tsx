import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { CashOutReceipt } from "@expendi-business/shared";

import { receiptRows } from "~/features/payment-receipts";
import { PaymentReceiptItems } from "./payment-receipts";

const MPESA: CashOutReceipt = { kind: "mpesa", code: "UKDCW299LW" };
const BANK: CashOutReceipt = { kind: "bank", code: "FT26317XK9QZ" };
const SPLIT: CashOutReceipt[] = [
  { kind: "mpesa", code: "UKD1AAAAAA" },
  { kind: "mpesa", code: "UKD2BBBBBB" },
  { kind: "mpesa", code: "UKD3CCCCCC" },
];

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** Each copy button's accessible name: its text, screen-reader part included. */
const copyButtons = (html: string) =>
  [...html.matchAll(/<button[^>]*>(.*?)<\/button>/gs)].map((match) =>
    text(match[1] ?? ""),
  );

function render(receipts: readonly CashOutReceipt[]): string {
  return renderToStaticMarkup(
    <dl>
      <PaymentReceiptItems receipts={receipts} />
    </dl>,
  );
}

describe("receiptRows", () => {
  it("makes one row per kind, codes in the order they were paid", () => {
    expect(receiptRows([...SPLIT, BANK])).toEqual([
      {
        kind: "mpesa",
        label: "M-Pesa receipts",
        codes: ["UKD1AAAAAA", "UKD2BBBBBB", "UKD3CCCCCC"],
      },
      { kind: "bank", label: "Bank reference", codes: ["FT26317XK9QZ"] },
    ]);
  });

  it("makes no row before a cash-out is paid", () => {
    expect(receiptRows([])).toEqual([]);
  });
});

describe("a payment's receipt rows", () => {
  it("shows an M-Pesa receipt with a button that copies it", () => {
    // #when
    const html = render([MPESA]);

    // #then
    expect({
      row: text(html).startsWith("M-Pesa receipt UKDCW299LW"),
      buttons: copyButtons(html),
    }).toEqual({ row: true, buttons: ["Copy M-Pesa receipt UKDCW299LW"] });
  });

  it("calls a bank transfer's code its bank reference", () => {
    // #when
    const html = render([BANK]);

    // #then
    expect({
      row: text(html).startsWith("Bank reference FT26317XK9QZ"),
      buttons: copyButtons(html),
    }).toEqual({ row: true, buttons: ["Copy Bank reference FT26317XK9QZ"] });
  });

  it("lists a split payment's receipts in one row, in order, each copyable", () => {
    // #when
    const html = render(SPLIT);

    // #then
    expect({
      rows: html.match(/<dt/g)?.length,
      row: text(html).startsWith("M-Pesa receipts UKD1AAAAAA"),
      buttons: copyButtons(html),
    }).toEqual({
      rows: 1,
      row: true,
      buttons: [
        "Copy M-Pesa receipt UKD1AAAAAA",
        "Copy M-Pesa receipt UKD2BBBBBB",
        "Copy M-Pesa receipt UKD3CCCCCC",
      ],
    });
  });

  it("shows nothing before a cash-out is paid", () => {
    expect(render([])).toBe("<dl></dl>");
  });
});
