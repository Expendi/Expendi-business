import { describe, expect, it } from "vitest";

import type { PublicInvoice } from "@expendi-business/shared";

import type { InvoicePdfData } from "../../services/invoices/invoice-pdf.js";
import {
  invoicePdfFilename,
  renderInvoicePdf,
} from "../../services/invoices/invoice-pdf.js";

const PAY_URL = "https://business.expendi.test/pay/abc";
const TX_HASH = "6mKzv7RfQ9cYw2PqL8nXbT3jDe4HsUa1VgCoNiEp5MtY";

const invoiceOf = (overrides: Partial<PublicInvoice> = {}): PublicInvoice => ({
  number: "INV-0013",
  status: "open",
  overdue: false,
  from: { name: "Acme Studio Ltd", kraPin: "P051234567Q" },
  billTo: {
    name: "Safaricom PLC",
    email: "ap@safaricom.test",
    address: "Westlands, Nairobi",
    taxId: "P000111222Z",
  },
  issueOn: "2026-11-02",
  dueOn: "2026-12-02",
  lines: [
    {
      id: "6e0a1d4e-2a0e-4f35-9a7c-3c1f2b8e9d01",
      description: "Brand identity workshop",
      quantity: "2",
      unitPriceCents: "250000",
      amountCents: "500000",
    },
  ],
  subtotalCents: "500000",
  taxRateBps: 1600,
  taxLabel: "VAT",
  taxCents: "80000",
  totalCents: "580000",
  note: "Thank you for your business.",
  chains: ["base"],
  canPay: true,
  ...overrides,
});

async function render(data: InvoicePdfData) {
  const texts: string[] = [];
  const bytes = await renderInvoicePdf(data, {
    compress: false,
    onText: (text) => texts.push(text),
  });
  return { bytes, texts };
}

const pageCount = (bytes: Buffer) =>
  bytes.toString("latin1").match(/\/Type \/Page\b(?!s)/g)?.length ?? 0;

describe("renderInvoicePdf", () => {
  it("draws an open invoice on one A4 page with its number, total and pay link", async () => {
    // #given
    const data = { invoice: invoiceOf(), payUrl: PAY_URL, payment: null };

    // #when
    const { bytes, texts } = await render(data);

    // #then
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("latin1")).toContain("/MediaBox [0 0 595.28 841.89]");
    expect(pageCount(bytes)).toBe(1);
    expect(texts).toEqual(
      expect.arrayContaining([
        "Invoice",
        "INV-0013",
        "Acme Studio Ltd",
        "KRA PIN P051234567Q",
        "Safaricom PLC",
        "Tax ID P000111222Z",
        "2 November 2026",
        "2 December 2026",
        "Brand identity workshop",
        "2,500.00",
        "VAT (16%)",
        "$800.00",
        "$5,800.00",
        "Thank you for your business.",
        "PAY IN USDC",
        PAY_URL,
      ]),
    );
    expect(texts).not.toContain("PAID");
    expect(texts).not.toContain("OVERDUE");
    expect(texts).not.toContain("VOID");
  });

  it("embeds Outfit and not a standard font", async () => {
    // #given
    const data = { invoice: invoiceOf(), payUrl: PAY_URL, payment: null };

    // #when
    const { bytes } = await render(data);

    // #then
    const source = bytes.toString("latin1");
    expect(source).toMatch(/\/BaseFont \/[A-Z]{6}\+Outfit-Regular/);
    expect(source).toMatch(/\/BaseFont \/[A-Z]{6}\+Outfit-SemiBold/);
    expect(source).not.toContain("/Helvetica");
  });

  it("heads the page with the Expendi Business mark and name", async () => {
    // #given
    const data = { invoice: invoiceOf(), payUrl: PAY_URL, payment: null };

    // #when
    const { bytes, texts } = await render(data);

    // #then
    expect({
      first: texts[0],
      markDrawn: /\/Width 377\b/.test(bytes.toString("latin1")),
    }).toEqual({ first: "Expendi Business", markDrawn: true });
  });

  it("stamps an open invoice past its due date OVERDUE", async () => {
    // #given
    const data = {
      invoice: invoiceOf({ overdue: true }),
      payUrl: PAY_URL,
      payment: null,
    };

    // #when
    const { texts } = await render(data);

    // #then
    expect(texts).toContain("OVERDUE");
    expect(texts).toContain(PAY_URL);
  });

  it("stamps a paid invoice PAID with when, how much and the transaction", async () => {
    // #given
    const data = {
      invoice: invoiceOf({ status: "paid", canPay: false }),
      payUrl: null,
      payment: {
        paidOn: "2026-11-12",
        amountUsdc: 5_800_000_000n,
        chain: "base" as const,
        txHash: TX_HASH,
      },
    };

    // #when
    const { bytes, texts } = await render(data);

    // #then
    expect(bytes.toString("latin1")).toContain(
      `/URI (https://nearblocks.io/txns/${TX_HASH})`,
    );
    expect(texts).toEqual(
      expect.arrayContaining([
        "PAID",
        "PAYMENT RECEIVED",
        "Paid on 12 November 2026",
        "Received 5,800.00 USDC",
        "Paid from Base",
        `NEAR transaction ${TX_HASH}`,
      ]),
    );
    expect(texts).not.toContain("PAY IN USDC");
  });

  it("stamps a paid invoice settled outside Expendi PAID without chain details", async () => {
    // #given
    const data = {
      invoice: invoiceOf({ status: "paid", canPay: false }),
      payUrl: null,
      payment: {
        paidOn: "2026-11-12",
        amountUsdc: null,
        chain: null,
        txHash: null,
      },
    };

    // #when
    const { texts } = await render(data);

    // #then
    expect(texts).toContain("PAID");
    expect(texts).toContain("Paid on 12 November 2026");
    expect(texts.some((text) => text.startsWith("NEAR transaction"))).toBe(
      false,
    );
    expect(texts.some((text) => text.startsWith("Received"))).toBe(false);
  });

  it("stamps a void invoice VOID and offers no payment", async () => {
    // #given
    const data = {
      invoice: invoiceOf({ status: "void", canPay: false }),
      payUrl: null,
      payment: null,
    };

    // #when
    const { texts } = await render(data);

    // #then
    expect(texts).toContain("VOID");
    expect(texts).not.toContain("PAY IN USDC");
  });

  it("leaves out the tax row when the invoice has no tax", async () => {
    // #given
    const data = {
      invoice: invoiceOf({
        taxRateBps: null,
        taxCents: "0",
        totalCents: "500000",
      }),
      payUrl: PAY_URL,
      payment: null,
    };

    // #when
    const { texts } = await render(data);

    // #then
    expect(texts.some((text) => text.startsWith("VAT"))).toBe(false);
    expect(texts).toContain("$5,000.00");
  });

  it("flows many lines onto more pages and repeats the table header", async () => {
    // #given
    const [line] = invoiceOf().lines;
    if (line === undefined) throw new Error("fixture has no line");
    const lines = Array.from({ length: 50 }, (_, index) => ({
      ...line,
      id: `6e0a1d4e-2a0e-4f35-9a7c-3c1f2b8e9${String(index).padStart(3, "0")}`,
      description: `Line item ${index + 1}`,
    }));
    const data = {
      invoice: invoiceOf({ lines }),
      payUrl: PAY_URL,
      payment: null,
    };

    // #when
    const { bytes, texts } = await render(data);

    // #then
    expect(pageCount(bytes)).toBeGreaterThan(1);
    expect(
      texts.filter((text) => text === "DESCRIPTION").length,
    ).toBeGreaterThan(1);
    expect(texts).toContain("Line item 50");
    expect(texts).toContain(PAY_URL);
  });

  it("compresses by default", async () => {
    // #given
    const data = { invoice: invoiceOf(), payUrl: PAY_URL, payment: null };

    // #when
    const bytes = await renderInvoicePdf(data);

    // #then
    expect(bytes.toString("latin1")).toContain("/FlateDecode");
  });
});

describe("invoicePdfFilename", () => {
  it("names the file after the invoice number", () => {
    expect(invoicePdfFilename("INV-0013")).toBe("INV-0013.pdf");
  });

  it("keeps slashes and quotes out of the header", () => {
    expect(invoicePdfFilename('2026/11 "a"')).toBe("2026-11-a-.pdf");
  });
});
