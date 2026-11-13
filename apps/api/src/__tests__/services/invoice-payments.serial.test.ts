import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { OneClickStatus } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearTransactionOutcome } from "../../services/chain/near.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  invoicePayments,
  invoices,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { invoiceReceiptEmail } from "../../services/email/invoice-receipt-email.js";
import { nairobiToday } from "../../services/expenses/rules.js";
import { refreshOpenFundIns } from "../../services/intents/fund-in.js";
import { creditSettledQuotes } from "../../services/intents/quote-credit.js";
import {
  getPayQuote,
  quoteForPayment,
} from "../../services/invoices/pay-link.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import {
  createDeliveryCompany,
  settleOpenQuotes,
  switchBalanceHome,
} from "../helpers/confidential-delivery.js";
import { makeFakeEmailSender, makeFakePrivyWallets } from "../helpers/fakes.js";
import { makeFakeFastNear } from "../helpers/fast-near.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  readInvoice,
} from "../helpers/invoices.js";
import {
  createFundedCompany,
  ledgerOf,
  readQuote,
} from "../helpers/money-in.js";
import {
  ftTransferLog,
  makeFakeNearRpc,
  nearOutcome,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const DASHBOARD_ORIGIN = "https://business.expendi.test";
const rpc = makeFakeNearRpc();
const fastNear = makeFakeFastNear();
const oneClick = makeFakeOneClick();
const email = makeFakeEmailSender();
const privy = makeFakePrivyWallets();
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime(
    {
      nearRpc: rpc.layer,
      fastNear: fastNear.layer,
      oneClick: oneClick.layer,
      emailSender: email.layer,
      privyWallets: privy.layer,
    },
    { DASHBOARD_ORIGINS: DASHBOARD_ORIGIN },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
  email.state.reset();
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const watch = () => runtime.runPromise(watchNearDeposits());

const forgetPosition = () =>
  owner.query("UPDATE wallets SET deposits_resume_token = NULL WHERE id = $1", [
    funded.walletId,
  ]);

const openInvoice = () =>
  createCustomerAndInvoice(db, funded.company, { status: "open" });

/** A pay-link quote as the customer would take it. */
async function takeQuote(publicId: string | null, chain: "base" | "arbitrum") {
  const quote = await runtime.runPromise(
    quoteForPayment(publicId ?? "", chain),
  );
  return readQuote(db, funded, quote.id);
}

/** 1Click delivers the quote's USDC to the company wallet and says so. */
function delivered(quote: { amountOut: bigint; depositAddress: string }) {
  const outcome: NearTransactionOutcome = nearOutcome(
    [
      {
        executorId: TEST_USDC_CONTRACT,
        logs: [
          ftTransferLog([
            {
              from: NEAR_INTENTS_ACCOUNT_ID,
              to: funded.accountId,
              amount: quote.amountOut,
            },
          ]),
        ],
      },
    ],
    { signerId: NEAR_INTENTS_ACCOUNT_ID },
  );
  rpc.state.outcomes.set(outcome.txHash, outcome);
  fastNear.state.index(funded.accountId, outcome);
  oneClick.state.setStatus(quote.depositAddress, {
    status: "SUCCESS",
    destinationChainTxHashes: [outcome.txHash],
  });
  return outcome;
}

const paymentsOf = (invoiceId: string) =>
  runInScope(db, asAdmin(funded.company), (tx) =>
    tx
      .select()
      .from(invoicePayments)
      .where(eq(invoicePayments.invoiceId, invoiceId))
      .orderBy(invoicePayments.createdAt),
  );

interface AuditRow {
  readonly action: string;
  readonly actorType: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

async function auditFor(entityId: string): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(
    `SELECT action, actor_type AS "actorType", before, after
       FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
    [entityId],
  );
  return rows;
}

const voidInvoice = (invoiceId: string) =>
  runInScope(db, asAdmin(funded.company), (tx) =>
    tx
      .update(invoices)
      .set({
        status: "void",
        voidedAt: new Date(),
        voidedReason: "Sent to the wrong customer",
        voidedBy: funded.company.admin.id,
      })
      .where(eq(invoices.id, invoiceId)),
  );

describe("the deposit watcher and an invoice payment quote's delivery", () => {
  it("credits it as a deposit and marks the invoice paid in the same transaction", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    const delivery = delivered(quote);

    // #when
    const summary = await watch();

    // #then
    const [credit] = await ledgerOf(db, funded);
    const [row] = await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) => tx.query.walletTransactions.findMany(),
    );
    const payments = await paymentsOf(invoice.invoiceId);
    const paid = await readInvoice(db, funded.company, invoice.invoiceId);
    const deposit = (await auditFor(row?.id ?? "")).find(
      (entry) => entry.action === "wallet.deposit_received",
    );
    expect({
      credited: summary.credited,
      ledger: {
        type: credit?.type,
        usdcAmount: credit?.usdcAmount,
        txHash: credit?.txHash,
      },
      invoice: paid.status,
      payments: payments.map((payment) => ({
        kind: payment.kind,
        intentQuoteId: payment.intentQuoteId,
        walletTransactionId: payment.walletTransactionId,
        amountUsdc: payment.amountUsdc,
        paidOn: payment.paidOn,
        recordedBy: payment.recordedBy,
      })),
      quote: (await readQuote(db, funded, quote.id)).status,
      depositAudit: {
        actorType: deposit?.actorType,
        invoiceId: deposit?.after?.invoiceId,
        invoicePaymentId: deposit?.after?.invoicePaymentId,
      },
    }).toEqual({
      credited: 1,
      ledger: {
        type: "deposit",
        usdcAmount: quote.amountOut,
        txHash: delivery.txHash,
      },
      invoice: "paid",
      payments: [
        {
          kind: "link",
          intentQuoteId: quote.id,
          walletTransactionId: row?.id,
          amountUsdc: quote.amountOut,
          paidOn: nairobiToday(),
          recordedBy: null,
        },
      ],
      quote: "succeeded",
      depositAudit: {
        actorType: "system",
        invoiceId: invoice.invoiceId,
        invoicePaymentId: payments[0]?.id,
      },
    });
  });

  it("credits nothing when the payment can't be recorded with it", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    delivered(quote);
    await runInScope(db, asAdmin(funded.company), async (tx) => {
      const [earlier] = await tx
        .insert(walletTransactions)
        .values({
          organizationId: funded.company.organizationId,
          walletId: funded.walletId,
          type: "deposit",
          chain: "near",
          usdcAmount: 1n,
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
          blockNumber: 1n,
        })
        .returning({ id: walletTransactions.id });
      await tx.insert(invoicePayments).values({
        organizationId: funded.company.organizationId,
        invoiceId: invoice.invoiceId,
        kind: "link",
        intentQuoteId: quote.id,
        walletTransactionId: earlier?.id ?? "",
        amountUsdc: 1n,
        paidOn: nairobiToday(),
      });
    });

    // #when
    const summary = await watch();

    // #then
    // The wallet would fail every run, so take it out of the watcher's way.
    await owner.query("UPDATE wallets SET status = 'creating' WHERE id = $1", [
      funded.walletId,
    ]);
    expect({
      failed: summary.failed,
      credited: summary.credited,
      ledgerAmounts: (await ledgerOf(db, funded)).map((row) => row.usdcAmount),
      payments: (await paymentsOf(invoice.invoiceId)).length,
    }).toEqual({ failed: 1, credited: 0, ledgerAmounts: [1n], payments: 1 });
  });

  it("pays an invoice voided meanwhile, and says so in the audit log", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    await voidInvoice(invoice.invoiceId);
    delivered(quote);

    // #when
    await watch();

    // #then
    const paid = await readInvoice(db, funded.company, invoice.invoiceId);
    const settled = (await auditFor(invoice.invoiceId)).find(
      (entry) => entry.action === "invoice.paid",
    );
    expect({
      status: paid.status,
      voidedAt: paid.voidedAt,
      before: settled?.before?.status,
      note: settled?.after?.note,
      actorType: settled?.actorType,
    }).toEqual({
      status: "paid",
      voidedAt: null,
      before: "void",
      note: "paid after void",
      actorType: "system",
    });
  });

  it("records a second payment on a paid invoice and tells admins it is extra", async () => {
    // #given
    const invoice = await openInvoice();
    const first = await takeQuote(invoice.publicId, "base");
    const second = await takeQuote(invoice.publicId, "arbitrum");
    delivered(first);
    await watch();
    delivered(second);

    // #when
    await watch();

    // #then
    const paid = await readInvoice(db, funded.company, invoice.invoiceId);
    const { rows: notices } = await owner.query<{ title: string }>(
      "SELECT title FROM notification_outbox WHERE organization_id = $1 AND kind = 'invoice_paid' AND channel = 'push' ORDER BY created_at",
      [funded.company.organizationId],
    );
    expect({
      status: paid.status,
      payments: (await paymentsOf(invoice.invoiceId)).map(
        (payment) => payment.intentQuoteId,
      ),
      ledger: (await ledgerOf(db, funded)).length,
      audit: (await auditFor(invoice.invoiceId)).map((entry) => entry.action),
      notices: notices.map((notice) => notice.title),
    }).toEqual({
      status: "paid",
      payments: [first.id, second.id],
      ledger: 2,
      audit: [
        "invoice.payment_quote_created",
        "invoice.payment_quote_created",
        "invoice.paid",
        "invoice.payment_recorded",
      ],
      notices: [
        `Invoice ${invoice.number} was paid`,
        `Invoice ${invoice.number} was paid again`,
      ],
    });
  });

  it("records nothing more when the same transfer is read again", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    delivered(quote);
    await watch();
    await forgetPosition();

    // #when
    const again = await watch();

    // #then
    expect({
      credited: again.credited,
      alreadyCredited: again.alreadyCredited,
      ledger: (await ledgerOf(db, funded)).length,
      payments: (await paymentsOf(invoice.invoiceId)).length,
      receipts: email.state.sent.length,
    }).toEqual({
      credited: 0,
      alreadyCredited: 1,
      ledger: 1,
      payments: 1,
      receipts: 1,
    });
  });

  it("emails the customer one receipt for the payment", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "arbitrum");
    delivered(quote);

    // #when
    await watch();

    // #then
    const [payment] = await paymentsOf(invoice.invoiceId);
    const [receipt] = email.state.sent;
    expect({
      count: email.state.sent.length,
      to: receipt?.to,
      subject: receipt?.subject,
      idempotencyKey: receipt?.idempotencyKey,
      mentions: [
        invoice.number,
        funded.company.name,
        "Arbitrum",
        nairobiToday(),
        "100.00 USDC",
      ].every((part) => receipt?.text.includes(part)),
    }).toEqual({
      count: 1,
      to: "ap@customer.test",
      subject: `Payment received for invoice ${invoice.number}`,
      idempotencyKey: `invoice-payment-${payment?.id}-receipt`,
      mentions: true,
    });
    const [deposit] = await ledgerOf(db, funded);
    const transactionUrl = `https://nearblocks.io/txns/${deposit?.txHash ?? ""}`;
    expect(receipt?.text).toContain(`Transaction: ${transactionUrl}`);
    expect(receipt?.html).toContain(
      `<a href="${transactionUrl}">View the transaction on NEAR</a>`,
    );
    expect(receipt?.text).toContain(
      `Download receipt (PDF): ${DASHBOARD_ORIGIN}/pay/${invoice.publicId}/pdf`,
    );
    expect(receipt?.html).toContain(
      `href="${DASHBOARD_ORIGIN}/pay/${invoice.publicId}/pdf">Download receipt (PDF)</a>`,
    );
  });

  it("keeps the credit and the paid invoice when the receipt can't be sent", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    delivered(quote);
    email.state.failNext();

    // #when
    const summary = await watch();

    // #then
    expect({
      credited: summary.credited,
      failed: summary.failed,
      invoice: (await readInvoice(db, funded.company, invoice.invoiceId))
        .status,
      sent: email.state.sent.length,
    }).toEqual({ credited: 1, failed: 0, invoice: "paid", sent: 0 });
  });

  it("credits an unrelated deposit as before and pays no invoice", async () => {
    // #given
    const invoice = await openInvoice();
    const outcome = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: "someone.near",
                to: funded.accountId,
                amount: 5_000_000n,
              },
            ]),
          ],
        },
      ],
      { signerId: "someone.near" },
    );
    rpc.state.outcomes.set(outcome.txHash, outcome);
    fastNear.state.index(funded.accountId, outcome);

    // #when
    await watch();

    // #then
    expect({
      ledger: (await ledgerOf(db, funded)).length,
      invoice: (await readInvoice(db, funded.company, invoice.invoiceId))
        .status,
      payments: await paymentsOf(invoice.invoiceId),
    }).toEqual({ ledger: 1, invoice: "open", payments: [] });
  });
});

describe("refreshOpenFundIns and invoice payment quotes", () => {
  const refresh = () => runtime.runPromise(refreshOpenFundIns());

  it.each<[OneClickStatus, string, boolean]>([
    ["SUCCESS", "succeeded", true],
    ["REFUNDED", "refunded", true],
    ["FAILED", "failed", true],
    ["PROCESSING", "depositing", false],
    ["PENDING_DEPOSIT", "quoted", false],
  ])(
    "moves a quote 1Click reports as %s to %s",
    async (reported, expected, settled) => {
      // #given
      const invoice = await openInvoice();
      const quote = await takeQuote(invoice.publicId, "base");
      oneClick.state.setStatus(quote.depositAddress, { status: reported });

      // #when
      await refresh();

      // #then
      const saved = await readQuote(db, funded, quote.id);
      expect({
        status: saved.status,
        oneClickStatus: saved.oneClickStatus,
        settled: saved.settledAt !== null,
      }).toEqual({ status: expected, oneClickStatus: reported, settled });
    },
  );

  it("expires a quote whose deadline passed with no deposit", async () => {
    // #given
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(intentQuotes)
          .set({ deadline: new Date(Date.now() - 60_000) })
          .where(eq(intentQuotes.id, quote.id)),
    );

    // #when
    const summary = await refresh();

    // #then
    expect({
      status: (await readQuote(db, funded, quote.id)).status,
      settled: summary.settled,
    }).toEqual({ status: "expired", settled: 1 });
  });
});

describe("invoiceReceiptEmail", () => {
  const receipt = {
    to: "ap@customer.test",
    invoiceNumber: "INV-1",
    companyName: "Acme",
    amountUsdc: 100_000_000n,
    chainName: "Base",
    paidOn: "2026-11-13",
    paymentId: "payment-1",
    pdfUrl: "https://business.expendi.test/pay/abc/pdf",
  };

  it("names the transaction when a chain shows the delivery", () => {
    // #when
    const message = invoiceReceiptEmail({
      ...receipt,
      transactionUrl: "https://nearblocks.io/txns/abc",
    });

    // #then
    expect(message.text).toBe(
      [
        "Acme received your payment for invoice INV-1.",
        "Amount: 100.00 USDC",
        "Paid from: Base",
        "Date: 2026-11-13",
        "Transaction: https://nearblocks.io/txns/abc",
        "",
        "Keep this email as your receipt.",
        "Download receipt (PDF): https://business.expendi.test/pay/abc/pdf",
        "",
      ].join("\n"),
    );
    expect(message.html).toContain("View the transaction on NEAR");
  });

  it("has no transaction line when no chain shows the delivery", () => {
    // #when
    const message = invoiceReceiptEmail({ ...receipt, transactionUrl: null });

    // #then
    expect(message.text).toBe(
      [
        "Acme received your payment for invoice INV-1.",
        "Amount: 100.00 USDC",
        "Paid from: Base",
        "Date: 2026-11-13",
        "",
        "Keep this email as your receipt.",
        "Download receipt (PDF): https://business.expendi.test/pay/abc/pdf",
        "",
      ].join("\n"),
    );
    expect(message.html).not.toContain("transaction");
  });
});

describe("an invoice payment quote of a company with a confidential account", () => {
  const refresh = () => runtime.runPromise(refreshOpenFundIns());

  afterEach(async () => {
    await settleOpenQuotes(db, funded);
  });

  const callsFor = (depositAddress: string, call: string) =>
    oneClick.state.calls.filter(
      (entry) => entry.depositAddress === depositAddress && entry.call === call,
    );

  it("is quoted for delivery to the confidential account with the company's session, the rest unchanged", async () => {
    // #given
    funded = await createDeliveryCompany(db, privy);
    const invoice = await openInvoice();
    const before = oneClick.state.quoteRequests.length;
    const callsBefore = oneClick.state.calls.length;

    // #when
    const quote = await takeQuote(invoice.publicId, "base");

    // #then
    const [request] = oneClick.state.quoteRequests.slice(before);
    const [call] = oneClick.state.calls.slice(callsBefore);
    expect({
      request: {
        recipient: request?.recipient,
        recipientType: request?.recipientType,
        refundTo: request?.refundTo,
        refundType: request?.refundType,
        swapType: request?.swapType,
        amount: request?.amount,
      },
      sessionSent: call?.session !== undefined,
      saved: {
        recipientType: quote.recipientType,
        refundType: quote.refundType,
        depositType: quote.depositType,
        purpose: quote.purpose,
      },
    }).toEqual({
      request: {
        recipient: funded.accountId,
        recipientType: "CONFIDENTIAL_INTENTS",
        refundTo: funded.accountId,
        refundType: "INTENTS",
        swapType: "EXACT_INPUT",
        amount: 100_000_000n,
      },
      sessionSent: true,
      saved: {
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "INTENTS",
        depositType: "ORIGIN_CHAIN",
        purpose: "invoice_payment",
      },
    });
  });

  it("is quoted for a company wallet's invoice exactly as before: no recipient type, no session", async () => {
    // #given
    funded = await createDeliveryCompany(db, privy, "company_wallet");
    const invoice = await openInvoice();
    const before = oneClick.state.quoteRequests.length;
    const callsBefore = oneClick.state.calls.length;

    // #when
    const quote = await takeQuote(invoice.publicId, "base");

    // #then
    const [request] = oneClick.state.quoteRequests.slice(before);
    const [call] = oneClick.state.calls.slice(callsBefore);
    expect({
      hasRecipientType: request !== undefined && "recipientType" in request,
      session: call?.session,
      saved: quote.recipientType,
      signIns: oneClick.state.signIns.filter(
        (signer) => signer === funded.accountId,
      ),
    }).toEqual({
      hasRecipientType: false,
      session: undefined,
      saved: "DESTINATION_CHAIN",
      signIns: [],
    });
  });

  it("is asked about with the session when the customer's page polls it", async () => {
    // #given
    funded = await createDeliveryCompany(db, privy);
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(intentQuotes)
          .set({ oneClickCheckedAt: new Date(Date.now() - 60_000) })
          .where(eq(intentQuotes.id, quote.id)),
    );

    // #when
    await runtime.runPromise(getPayQuote(invoice.publicId ?? "", quote.id));

    // #then
    expect(
      callsFor(quote.depositAddress, "status").map(
        (call) => call.session !== undefined,
      ),
    ).toEqual([true]);
  });

  it("is credited once, at settlement, and never again by the deposit watcher", async () => {
    // #given
    funded = await createDeliveryCompany(db, privy);
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    oneClick.state.deliverConfidential(quote.depositAddress, quote.amountOut);
    await refresh();
    await runtime.runPromise(creditSettledQuotes());
    const stray = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: NEAR_INTENTS_ACCOUNT_ID,
                to: funded.accountId,
                amount: quote.amountOut,
              },
            ]),
          ],
        },
      ],
      { signerId: NEAR_INTENTS_ACCOUNT_ID },
    );
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountOut: quote.amountOut,
      destinationChainTxHashes: [stray.txHash],
    });
    rpc.state.outcomes.set(stray.txHash, stray);
    fastNear.state.index(funded.accountId, stray);
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(intentQuotes)
          .set({ destinationChainTxHashes: [stray.txHash] })
          .where(eq(intentQuotes.id, quote.id)),
    );

    // #when
    const summary = await watch();

    // #then
    expect({
      credited: summary.credited,
      internal: summary.internal >= 1,
      ledger: (await ledgerOf(db, funded)).map((row) => row.usdcAmount),
      payments: (await paymentsOf(invoice.invoiceId)).length,
      receipts: email.state.sent.length,
    }).toEqual({
      credited: 0,
      internal: true,
      ledger: [quote.amountOut],
      payments: 1,
      receipts: 1,
    });
  });

  it("is credited by the deposit watcher, not at settlement, once the company is switched after the quote", async () => {
    // #given
    funded = await createDeliveryCompany(db, privy, "company_wallet");
    const invoice = await openInvoice();
    const quote = await takeQuote(invoice.publicId, "base");
    await switchBalanceHome(db, funded, "confidential_account");
    delivered(quote);

    // #when
    await refresh();
    await runtime.runPromise(creditSettledQuotes());
    const atSettlement = await ledgerOf(db, funded);
    await watch();

    // #then
    const [credit] = await ledgerOf(db, funded);
    expect({
      atSettlement,
      credit: {
        usdcAmount: credit?.usdcAmount,
        intentQuoteId: credit?.intentQuoteId,
      },
      invoice: (await readInvoice(db, funded.company, invoice.invoiceId))
        .status,
    }).toEqual({
      atSettlement: [],
      credit: { usdcAmount: quote.amountOut, intentQuoteId: null },
      invoice: "paid",
    });
  });
});
