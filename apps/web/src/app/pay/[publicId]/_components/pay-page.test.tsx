import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PublicInvoice, PublicPayQuote } from "@expendi-business/shared";

import type { LoadState } from "./pay-page";
import type { PayState } from "./pay-panel";
import { formatCountdown } from "./pay-format";
import { PayContent } from "./pay-page";

const INVOICE: PublicInvoice = {
  number: "INV-0042",
  status: "open",
  overdue: false,
  from: { name: "Acme Ltd", kraPin: "P051234567Z" },
  billTo: {
    name: "Wanjiru Traders",
    email: "ap@wanjiru.test",
    address: null,
    taxId: null,
  },
  issueOn: "2026-11-01",
  dueOn: "2026-12-01",
  lines: [
    {
      id: "6b0f2c9e-1d2a-4f0e-8a77-0c2f4c6d9a01",
      description: "Consulting",
      quantity: "2.5",
      unitPriceCents: "40000",
      amountCents: "100000",
    },
  ],
  subtotalCents: "100000",
  taxRateBps: 1600,
  taxLabel: "VAT",
  taxCents: "16000",
  totalCents: "116000",
  note: "Thank you.",
  chains: ["base", "ethereum", "arbitrum", "solana"],
  canPay: true,
};

const QUOTE: PublicPayQuote = {
  id: "7f0c6f3e-5c1b-4a52-9d57-0a0e6f6f3a11",
  chain: "base",
  amountIn: "1160000000",
  depositAddress: "0x1234567890abcdef1234567890abcdef12345678",
  deadline: "2026-11-12T12:30:00.000Z",
  status: "awaiting_deposit",
};

const text = (html: string) =>
  html
    .replace(/<svg[\s\S]*?<\/svg>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/\s+/g, " ");

function render(
  overrides: {
    load?: LoadState;
    pay?: PayState;
    paidOnPage?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <PayContent
      load={overrides.load ?? { kind: "ready", invoice: INVOICE }}
      pay={overrides.pay ?? { kind: "idle" }}
      paidOnPage={overrides.paidOnPage ?? false}
      onChoose={vi.fn()}
      onRetry={vi.fn()}
      onPrint={vi.fn()}
    />,
  );
}

function withInvoice(patch: Partial<PublicInvoice>): LoadState {
  return { kind: "ready", invoice: { ...INVOICE, ...patch } };
}

function withQuote(patch: Partial<PublicPayQuote>): PayState {
  return { kind: "quote", quote: { ...QUOTE, ...patch } };
}

describe("the invoice pay page", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-12T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the invoice and the chain chooser for an open invoice", () => {
    const html = render();
    const content = text(html);

    expect({
      heading: content.includes("Invoice INV-0042 from Acme Ltd"),
      due: content.includes("Amount due $1,160.00"),
      pin: content.includes("KRA PIN P051234567Z"),
      billTo: content.includes("ap@wanjiru.test"),
      line: content.includes("2.5 × $400.00"),
      tax: content.includes("VAT (16%) $160.00"),
      note: content.includes("Thank you."),
      networks: ["Base", "Ethereum", "Arbitrum", "Solana"].map((name) =>
        html.includes(`>${name}</button>`),
      ),
      printButton: content.includes("Print or save as PDF"),
      overdue: content.includes("Overdue"),
    }).toEqual({
      heading: true,
      due: true,
      pin: true,
      billTo: true,
      line: true,
      tax: true,
      note: true,
      networks: [true, true, true, true],
      printButton: true,
      overdue: false,
    });
  });

  it("flags an overdue invoice and omits the tax line when untaxed", () => {
    const content = text(
      render({
        load: withInvoice({ overdue: true, taxRateBps: null, taxCents: "0" }),
      }),
    );

    expect({
      overdue: content.includes("Overdue"),
      tax: content.includes("VAT"),
    }).toEqual({ overdue: true, tax: false });
  });

  it("hides the pay panel and buttons from print", () => {
    const html = render();

    expect(html.match(/print:hidden/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(
      /<section[^>]*aria-labelledby="pay-heading"[^>]*print:hidden/,
    );
  });

  it("shows the deposit address, exact amount, countdown and warnings", () => {
    const html = render({ pay: withQuote({}) });
    const content = text(html);

    expect({
      waiting: content.includes("Waiting for your payment"),
      amount: content.includes("1,160.00 USDC"),
      address: content.includes(QUOTE.depositAddress),
      countdown: content.includes("30:00"),
      qr: html.includes("<svg"),
      copy: content.includes("Copy address"),
      onlyUsdc: content.includes("Send only USDC on Base"),
      exact: content.includes("Send exactly this amount, in one transfer"),
      mismatch: content.includes(
        "A different amount, token or network won't mark the invoice paid",
      ),
    }).toEqual({
      waiting: true,
      amount: true,
      address: true,
      countdown: true,
      qr: true,
      copy: true,
      onlyUsdc: true,
      exact: true,
      mismatch: true,
    });
  });

  it("shows full USDC precision", () => {
    const content = text(
      render({ pay: withQuote({ amountIn: "1250123456" }) }),
    );

    expect(content).toContain("1,250.123456 USDC");
  });

  it("says a payment is being confirmed and drops the address", () => {
    const content = text(render({ pay: withQuote({ status: "processing" }) }));

    expect({
      confirming: content.includes("Payment received, confirming"),
      address: content.includes(QUOTE.depositAddress),
    }).toEqual({ confirming: true, address: false });
  });

  it("confirms payment and names where the receipt goes", () => {
    const content = text(
      render({
        load: withInvoice({ status: "paid" }),
        pay: withQuote({ status: "paid" }),
        paidOnPage: true,
      }),
    );

    expect(content).toContain(
      "Paid. A receipt is on its way to ap@wanjiru.test",
    );
  });

  it("tells the customer a mismatched payment will be sorted out", () => {
    const content = text(
      render({ pay: withQuote({ status: "needs_attention" }) }),
    );

    expect(content).toContain(
      "We received a payment that didn't match Acme Ltd will confirm it with you.",
    );
  });

  it("offers a new address once one expires", () => {
    const html = render({ pay: withQuote({ status: "expired" }) });

    expect({
      expired: text(html).includes("This address expired"),
      button: html.includes(">Get a new address</button>"),
      address: html.includes(QUOTE.depositAddress),
    }).toEqual({ expired: true, button: true, address: false });
  });

  it("shows the API's message when a quote can't be made", () => {
    const content = text(
      render({
        pay: {
          kind: "failed",
          chain: "base",
          message: "Payments are unavailable right now.",
        },
      }),
    );

    expect(content).toContain("Payments are unavailable right now.");
  });

  it("explains an open invoice that can't take payments", () => {
    const html = render({ load: withInvoice({ canPay: false }) });

    expect({
      message: text(html).includes(
        "Acme Ltd can't take payments through this link right now. Contact them to pay.",
      ),
      panel: html.includes("pay-heading"),
    }).toEqual({ message: true, panel: false });
  });

  it("shows a paid invoice with no pay panel", () => {
    const html = render({
      load: withInvoice({ status: "paid", canPay: false }),
    });

    expect({
      paid: text(html).includes("This invoice has been paid."),
      panel: html.includes("pay-heading"),
    }).toEqual({ paid: true, panel: false });
  });

  it("shows a cancelled invoice with no pay panel", () => {
    const html = render({
      load: withInvoice({ status: "void", canPay: false }),
    });

    expect({
      void: text(html).includes("This invoice was cancelled."),
      panel: html.includes("pay-heading"),
    }).toEqual({ void: true, panel: false });
  });

  it("shows a friendly message for an unknown link", () => {
    expect(text(render({ load: { kind: "not_found" } }))).toContain(
      "This invoice link isn't valid",
    );
  });

  it("shows a retry for a load that failed", () => {
    const html = render({
      load: { kind: "failed", message: "Couldn't reach Expendi Business." },
    });

    expect({
      title: text(html).includes("Couldn't load this invoice"),
      retry: html.includes(">Try again</button>"),
    }).toEqual({ title: true, retry: true });
  });

  it("shows a loading state first", () => {
    expect(render({ load: { kind: "loading" } })).toContain('aria-busy="true"');
  });
});

describe("formatCountdown", () => {
  it("counts down in minutes, then hours", () => {
    expect([
      formatCountdown(0),
      formatCountdown(65_000),
      formatCountdown(2 * 3600_000 - 1000),
    ]).toEqual([null, "01:05", "1:59:59"]);
  });
});
