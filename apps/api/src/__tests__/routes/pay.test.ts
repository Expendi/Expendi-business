import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PublicPayQuote } from "@expendi-business/shared";
import {
  publicInvoiceSchema,
  publicPayQuoteSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { OneClickStatus } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  invoicePayments,
  invoices,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
} from "../../services/intents/one-click.js";
import { getInvoicePdfData } from "../../services/invoices/invoice-pdf.js";
import { createCompany } from "../helpers/db.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  insertDeposit,
  insertInvoiceQuote,
} from "../helpers/invoices.js";
import { createFundedCompany, readQuote } from "../helpers/money-in.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const DASHBOARD_ORIGIN = "https://business.expendi.test";
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let app: App;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { oneClick: oneClick.layer },
    { DASHBOARD_ORIGINS: DASHBOARD_ORIGIN },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  app = createApp({ runtime });
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
  oneClick.state.quoteRequests.length = 0;
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const open = (options: Parameters<typeof createCustomerAndInvoice>[2] = {}) =>
  createCustomerAndInvoice(db, funded.company, { status: "open", ...options });

const show = (publicId: string) => app.request(`/pay/${publicId}`);

const requestQuote = (publicId: string, body: unknown = { chain: "base" }) =>
  app.request(`/pay/${publicId}/quotes`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const readQuoteOf = (publicId: string, quoteId: string) =>
  app.request(`/pay/${publicId}/quotes/${quoteId}`);

async function payQuote(
  publicId: string,
  chain = "base",
): Promise<PublicPayQuote> {
  const response = await requestQuote(publicId, { chain });
  const body = (await response.json()) as { data?: unknown };
  return publicPayQuoteSchema.parse(body.data);
}

const setInvoice = (
  invoiceId: string,
  values: Partial<typeof invoices.$inferInsert>,
) =>
  runInScope(db, asAdmin(funded.company), (tx) =>
    tx.update(invoices).set(values).where(eq(invoices.id, invoiceId)),
  );

const setQuote = (
  quoteId: string,
  values: Partial<typeof intentQuotes.$inferInsert>,
) =>
  runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
    tx.update(intentQuotes).set(values).where(eq(intentQuotes.id, quoteId)),
  );

describe("GET /pay/:publicId", () => {
  it("shows an open invoice as its customer sees it, without the company's ID", async () => {
    // #given
    const invoice = await open({
      taxRateBps: 1600,
      lines: [{ quantity: "2", unitPriceCents: 5_000n }],
    });

    // #when
    const response = await show(invoice.publicId ?? "");

    // #then
    const text = await response.text();
    const shown = publicInvoiceSchema.parse(
      (JSON.parse(text) as { data: unknown }).data,
    );
    expect({
      status: response.status,
      number: shown.number,
      invoiceStatus: shown.status,
      overdue: shown.overdue,
      from: shown.from.name,
      billTo: shown.billTo.email,
      totalCents: shown.totalCents,
      taxCents: shown.taxCents,
      lines: shown.lines.map((line) => line.amountCents),
      chains: shown.chains,
      canPay: shown.canPay,
      leaksOrganization: text.includes(funded.company.organizationId),
    }).toEqual({
      status: 200,
      number: invoice.number,
      invoiceStatus: "open",
      overdue: false,
      from: funded.company.name,
      billTo: "ap@customer.test",
      totalCents: "11600",
      taxCents: "1600",
      lines: ["10000"],
      chains: ["base", "ethereum", "arbitrum", "solana"],
      canPay: true,
      leaksOrganization: false,
    });
  });

  it("flags an open invoice past its due date as overdue", async () => {
    // #given
    const invoice = await open({ issueOn: "2020-01-01", dueOn: "2020-01-31" });

    // #when
    const response = await show(invoice.publicId ?? "");

    // #then
    const shown = publicInvoiceSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect({ status: shown.status, overdue: shown.overdue }).toEqual({
      status: "open",
      overdue: true,
    });
  });

  it("shows paid and void invoices as such, and cannot be paid", async () => {
    // #given
    const paid = await open();
    const voided = await open();
    await setInvoice(paid.invoiceId, { status: "paid", paidAt: new Date() });
    await setInvoice(voided.invoiceId, {
      status: "void",
      voidedAt: new Date(),
      voidedReason: "Duplicate",
      voidedBy: funded.company.admin.id,
    });

    // #when
    const shown = await Promise.all(
      [paid, voided].map(async (invoice) =>
        publicInvoiceSchema.parse(
          (
            (await (await show(invoice.publicId ?? "")).json()) as {
              data: unknown;
            }
          ).data,
        ),
      ),
    );

    // #then
    expect(shown.map(({ status, canPay }) => ({ status, canPay }))).toEqual([
      { status: "paid", canPay: false },
      { status: "void", canPay: false },
    ]);
  });

  it("cannot be paid while the company's wallet isn't active", async () => {
    // #given
    const noWallet = await createCompany(db);
    const invoice = await createCustomerAndInvoice(db, noWallet, {
      status: "open",
    });

    // #when
    const response = await show(invoice.publicId ?? "");

    // #then
    const shown = publicInvoiceSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect({ status: response.status, canPay: shown.canPay }).toEqual({
      status: 200,
      canPay: false,
    });
  });

  it.each([
    ["an unknown ID", () => randomBytes(32).toString("base64url")],
    ["a malformed ID", () => "not-a-public-id"],
  ])("answers 404 for %s", async (_name, publicId) => {
    // #when
    const response = await show(publicId());

    // #then
    expect(response.status).toBe(404);
  });

  it("answers 404 for a draft, which has no link", async () => {
    // #given
    const draft = await createCustomerAndInvoice(db, funded.company);

    // #when
    const response = await show(draft.invoiceId);

    // #then
    expect(response.status).toBe(404);
  });

  it("allows the dashboard's origin to call it, without credentials", async () => {
    // #given
    const invoice = await open();

    // #when
    const preflight = await app.request(`/pay/${invoice.publicId}/quotes`, {
      method: "OPTIONS",
      headers: {
        origin: DASHBOARD_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });
    const other = await app.request(`/pay/${invoice.publicId}`, {
      headers: { origin: "https://evil.example" },
    });

    // #then
    expect({
      allowed: preflight.headers.get("access-control-allow-origin"),
      other: other.headers.get("access-control-allow-origin"),
    }).toEqual({ allowed: DASHBOARD_ORIGIN, other: null });
  });
});

describe("GET /pay/:publicId/pdf", () => {
  const pdf = (publicId: string) => app.request(`/pay/${publicId}/pdf`);

  it("serves an open invoice as a PDF download that isn't cached", async () => {
    // #given
    const invoice = await open({ number: "INV-0013" });

    // #when
    const response = await pdf(invoice.publicId ?? "");

    // #then
    const bytes = Buffer.from(await response.arrayBuffer());
    expect({
      status: response.status,
      type: response.headers.get("content-type"),
      disposition: response.headers.get("content-disposition"),
      cache: response.headers.get("cache-control"),
      magic: bytes.subarray(0, 5).toString(),
    }).toEqual({
      status: 200,
      type: "application/pdf",
      disposition: 'attachment; filename="INV-0013.pdf"',
      cache: "no-store",
      magic: "%PDF-",
    });
  });

  it("answers 404 in the error envelope for an unknown ID", async () => {
    // #when
    const response = await pdf(randomBytes(32).toString("base64url"));

    // #then
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      error: { _tag: "NotFound", message: "Invoice not found." },
    });
  });

  it("answers 404 for something that isn't a public ID", async () => {
    // #when
    const response = await pdf("INV-0013");

    // #then
    expect(response.status).toBe(404);
  });

  it("reads the payment that settled a paid invoice", async () => {
    // #given
    const invoice = await open();
    const quote = await insertInvoiceQuote(db, funded, invoice.invoiceId);
    const depositId = await insertDeposit(db, funded);
    await runInScope(db, asAdmin(funded.company), (tx) =>
      tx.insert(invoicePayments).values({
        organizationId: funded.company.organizationId,
        invoiceId: invoice.invoiceId,
        kind: "link",
        intentQuoteId: quote.id,
        walletTransactionId: depositId,
        amountUsdc: 100_000_000n,
        paidOn: "2026-11-12",
      }),
    );
    await setInvoice(invoice.invoiceId, { status: "paid", paidAt: new Date() });
    const [deposit] = await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .select({ txHash: walletTransactions.txHash })
          .from(walletTransactions)
          .where(eq(walletTransactions.id, depositId)),
    );

    // #when
    const data = await runtime.runPromise(
      getInvoicePdfData(invoice.publicId ?? ""),
    );
    const response = await pdf(invoice.publicId ?? "");

    // #then
    expect(data.payUrl).toBeNull();
    expect(data.payment).toEqual({
      paidOn: "2026-11-12",
      amountUsdc: 100_000_000n,
      chain: "base",
      txHash: deposit?.txHash,
    });
    expect(response.status).toBe(200);
  });

  it("gives an open invoice the pay link on the first dashboard origin", async () => {
    // #given
    const invoice = await open();

    // #when
    const data = await runtime.runPromise(
      getInvoicePdfData(invoice.publicId ?? ""),
    );

    // #then
    expect(data.payUrl).toBe(`${DASHBOARD_ORIGIN}/pay/${invoice.publicId}`);
    expect(data.payment).toBeNull();
  });

  it("serves a void invoice", async () => {
    // #given
    const invoice = await open();
    await setInvoice(invoice.invoiceId, {
      status: "void",
      voidedAt: new Date(),
      voidedReason: "Duplicate",
      voidedBy: funded.company.admin.id,
    });

    // #when
    const response = await pdf(invoice.publicId ?? "");

    // #then
    expect(response.status).toBe(200);
  });
});

describe("POST /pay/:publicId/quotes", () => {
  it("takes a firm 1Click quote for exactly the invoice total, refunds into NEAR Intents, and saves it", async () => {
    // #given
    const invoice = await open({
      taxRateBps: 1600,
      lines: [{ quantity: "1", unitPriceCents: 10_000n }],
    });

    // #when
    const response = await requestQuote(invoice.publicId ?? "");

    // #then
    const quote = publicPayQuoteSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    const [request] = oneClick.state.quoteRequests;
    const saved = await readQuote(db, funded, quote.id);
    const { rows: audit } = await owner.query<{
      actor_type: string;
      actor_id: string;
      after: Record<string, unknown>;
    }>(
      `SELECT actor_type, actor_id, after FROM audit_log
         WHERE entity_id = $1 AND action = 'invoice.payment_quote_created'`,
      [invoice.invoiceId],
    );
    expect({
      status: response.status,
      quote: {
        chain: quote.chain,
        amountIn: quote.amountIn,
        state: quote.status,
      },
      request: {
        dry: request?.dry,
        swapType: request?.swapType,
        originAsset: request?.originAsset,
        destinationAsset: request?.destinationAsset,
        amount: request?.amount,
        recipient: request?.recipient,
        refundTo: request?.refundTo,
        refundType: request?.refundType,
        slippageBps: request?.slippageBps,
        deadlineMs: Math.round(
          ((request?.deadline.getTime() ?? 0) - Date.now()) / 60_000,
        ),
      },
      saved: {
        purpose: saved.purpose,
        invoiceId: saved.invoiceId,
        keyed: saved.quoteKey.startsWith(
          `invoice-payment:${invoice.invoiceId}:base:`,
        ),
        refundType: saved.refundType,
        depositAddress: saved.depositAddress === quote.depositAddress,
      },
      audit: audit.map((row) => [
        row.actor_type,
        row.actor_id,
        row.after.quoteId,
      ]),
    }).toEqual({
      status: 201,
      quote: {
        chain: "base",
        amountIn: "116000000",
        state: "awaiting_deposit",
      },
      request: {
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.base,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: 116_000_000n,
        recipient: funded.accountId,
        refundTo: funded.accountId,
        refundType: "INTENTS",
        slippageBps: 100,
        deadlineMs: 120,
      },
      saved: {
        purpose: "invoice_payment",
        invoiceId: invoice.invoiceId,
        keyed: true,
        refundType: "INTENTS",
        depositAddress: true,
      },
      audit: [["system", "invoice-pay-link", quote.id]],
    });
  });

  it("returns the open quote for the same chain instead of taking another", async () => {
    // #given
    const invoice = await open();
    const first = await payQuote(invoice.publicId ?? "");

    // #when
    const again = await payQuote(invoice.publicId ?? "");
    const otherChain = await payQuote(invoice.publicId ?? "", "arbitrum");

    // #then
    expect({
      sameQuote: again.id === first.id,
      otherChain: otherChain.id !== first.id,
      oneClickCalls: oneClick.state.quoteRequests.length,
    }).toEqual({ sameQuote: true, otherChain: true, oneClickCalls: 2 });
  });

  it("takes a new quote once the open one has under 30 minutes left", async () => {
    // #given
    const invoice = await open();
    const first = await payQuote(invoice.publicId ?? "");
    await setQuote(first.id, {
      deadline: new Date(Date.now() + 29 * 60_000),
    });

    // #when
    const next = await payQuote(invoice.publicId ?? "");

    // #then
    expect({
      newQuote: next.id !== first.id,
      oneClickCalls: oneClick.state.quoteRequests.length,
    }).toEqual({ newQuote: true, oneClickCalls: 2 });
  });

  it("takes a new quote when the earlier one is no longer open", async () => {
    // #given
    const invoice = await open();
    const first = await payQuote(invoice.publicId ?? "");
    await setQuote(first.id, { status: "expired", settledAt: new Date() });

    // #when
    const next = await payQuote(invoice.publicId ?? "");

    // #then
    expect(next.id).not.toBe(first.id);
  });

  it("answers 409 for an invoice that is void or already paid", async () => {
    // #given
    const paid = await open();
    const voided = await open();
    await setInvoice(paid.invoiceId, { status: "paid", paidAt: new Date() });
    await setInvoice(voided.invoiceId, {
      status: "void",
      voidedAt: new Date(),
      voidedReason: "Duplicate",
      voidedBy: funded.company.admin.id,
    });

    // #when
    const responses = [
      await requestQuote(paid.publicId ?? ""),
      await requestQuote(voided.publicId ?? ""),
    ];

    // #then
    expect({
      statuses: responses.map((response) => response.status),
      message: ((await responses[0]?.json()) as { error: { message: string } })
        .error.message,
      oneClickCalls: oneClick.state.quoteRequests.length,
    }).toEqual({
      statuses: [409, 409],
      message: "This invoice isn't open for payment.",
      oneClickCalls: 0,
    });
  });

  it("answers 409 when the company's wallet isn't active", async () => {
    // #given
    const noWallet = await createCompany(db);
    const invoice = await createCustomerAndInvoice(db, noWallet, {
      status: "open",
    });

    // #when
    const response = await requestQuote(invoice.publicId ?? "");

    // #then
    expect({
      status: response.status,
      oneClickCalls: oneClick.state.quoteRequests.length,
    }).toEqual({ status: 409, oneClickCalls: 0 });
  });

  it("answers 503 with a plain message when 1Click refuses, and saves nothing", async () => {
    // #given
    const invoice = await open();
    oneClick.state.failNextQuotes("refused");

    // #when
    const response = await requestQuote(invoice.publicId ?? "");

    // #then
    const body = (await response.json()) as { error: { message: string } };
    const saved = await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) => tx.select().from(intentQuotes),
    );
    expect({
      status: response.status,
      message: body.error.message,
      saved: saved.length,
    }).toEqual({
      status: 503,
      message:
        "Paying this invoice isn't available right now. Try again in a minute.",
      saved: 0,
    });
  });

  it("answers 400 for a chain that isn't one of the fund-in chains", async () => {
    // #given
    const invoice = await open();

    // #when
    const response = await requestQuote(invoice.publicId ?? "", {
      chain: "near",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("answers 404 for an unknown link", async () => {
    // #when
    const response = await requestQuote(randomBytes(32).toString("base64url"));

    // #then
    expect(response.status).toBe(404);
  });
});

describe("GET /pay/:publicId/quotes/:quoteId", () => {
  const status = async (publicId: string, quoteId: string) =>
    publicPayQuoteSchema.parse(
      (
        (await (await readQuoteOf(publicId, quoteId)).json()) as {
          data: unknown;
        }
      ).data,
    ).status;

  it.each<[OneClickStatus | null, string]>([
    [null, "awaiting_deposit"],
    ["PENDING_DEPOSIT", "awaiting_deposit"],
    ["KNOWN_DEPOSIT_TX", "processing"],
    ["INCOMPLETE_DEPOSIT", "processing"],
    ["PROCESSING", "processing"],
    ["SUCCESS", "processing"],
    ["REFUNDED", "needs_attention"],
    ["FAILED", "needs_attention"],
  ])("shows 1Click's %s as %s", async (reported, expected) => {
    // #given
    const invoice = await open();
    const quote = await payQuote(invoice.publicId ?? "");
    if (reported !== null) {
      oneClick.state.setStatus(quote.depositAddress, { status: reported });
    }

    // #when
    const shown = await status(invoice.publicId ?? "", quote.id);

    // #then
    expect(shown).toBe(expected);
  });

  it("shows a quote past its deadline that 1Click never saw a deposit for as expired", async () => {
    // #given
    const invoice = await open();
    const quote = await payQuote(invoice.publicId ?? "");
    await setQuote(quote.id, { deadline: new Date(Date.now() - 60_000) });

    // #when
    const shown = await status(invoice.publicId ?? "", quote.id);

    // #then
    expect(shown).toBe("expired");
  });

  it("shows paid once the invoice has a link payment from this quote", async () => {
    // #given
    const invoice = await open();
    const quote = await payQuote(invoice.publicId ?? "");
    const depositId = await insertDeposit(db, funded);
    await runInScope(db, asAdmin(funded.company), (tx) =>
      tx.insert(invoicePayments).values({
        organizationId: funded.company.organizationId,
        invoiceId: invoice.invoiceId,
        kind: "link",
        intentQuoteId: quote.id,
        walletTransactionId: depositId,
        amountUsdc: 100_000_000n,
        paidOn: "2026-11-12",
      }),
    );

    // #when
    const shown = await status(invoice.publicId ?? "", quote.id);

    // #then
    expect(shown).toBe("paid");
  });

  it("asks 1Click at most every 15 seconds", async () => {
    // #given
    const invoice = await open();
    const quote = await payQuote(invoice.publicId ?? "");
    const publicId = invoice.publicId ?? "";
    oneClick.state.setStatus(quote.depositAddress, { status: "PROCESSING" });
    const first = await status(publicId, quote.id);
    oneClick.state.setStatus(quote.depositAddress, { status: "REFUNDED" });

    // #when
    const soon = await status(publicId, quote.id);
    await setQuote(quote.id, {
      oneClickCheckedAt: new Date(Date.now() - 16_000),
    });
    const later = await status(publicId, quote.id);

    // #then
    expect([first, soon, later]).toEqual([
      "processing",
      "processing",
      "needs_attention",
    ]);
  });

  it("answers from what it has when 1Click can't be asked", async () => {
    // #given
    const invoice = await open();
    const quote = await payQuote(invoice.publicId ?? "");
    oneClick.state.failNextStatus();

    // #when
    const response = await readQuoteOf(invoice.publicId ?? "", quote.id);

    // #then
    expect({
      status: response.status,
      shown: publicPayQuoteSchema.parse(
        ((await response.json()) as { data: unknown }).data,
      ).status,
    }).toEqual({ status: 200, shown: "awaiting_deposit" });
  });

  it("answers 404 for a quote of another invoice or one that doesn't exist", async () => {
    // #given
    const invoice = await open();
    const other = await open();
    const quote = await payQuote(invoice.publicId ?? "");

    // #when
    const responses = await Promise.all([
      readQuoteOf(other.publicId ?? "", quote.id),
      readQuoteOf(invoice.publicId ?? "", crypto.randomUUID()),
      readQuoteOf(invoice.publicId ?? "", "not-a-uuid"),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      404, 404, 404,
    ]);
  });
});
