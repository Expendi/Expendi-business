import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { IntentQuote, InvoiceRow } from "../../db/schema/index.js";
import type { TestCompany } from "./db.js";
import type { FundedCompany } from "./money-in.js";
import {
  customers,
  intentQuotes,
  invoiceLineItems,
  invoices,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
} from "../../services/intents/one-click.js";
import { invoiceTotals } from "../../services/invoices/money.js";
import { randomNearAccount, randomNearTxHash } from "./near.js";

export const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

export interface TestInvoiceLine {
  readonly description?: string;
  readonly quantity: string;
  readonly unitPriceCents: bigint;
}

export interface CreateInvoiceOptions {
  /** Defaults to `draft`. `open` is saved as if it had just been sent. */
  readonly status?: "draft" | "open";
  /** Reuse a customer instead of creating one. */
  readonly customerId?: string;
  readonly number?: string;
  readonly issueOn?: string;
  readonly dueOn?: string;
  readonly taxRateBps?: number | null;
  /** Defaults to one line of 1 × USD 100.00. */
  readonly lines?: readonly TestInvoiceLine[];
}

export interface TestInvoice {
  readonly customerId: string;
  readonly invoiceId: string;
  readonly number: string;
  readonly publicId: string | null;
  readonly totalCents: bigint;
}

/**
 * A customer and an invoice with lines, written straight to the tables as
 * the company's admin. An `open` invoice carries the snapshots and public
 * ID that sending would have set.
 */
export async function createCustomerAndInvoice(
  db: Database,
  company: TestCompany,
  options: CreateInvoiceOptions = {},
): Promise<TestInvoice> {
  const status = options.status ?? "draft";
  const lines = options.lines ?? [{ quantity: "1", unitPriceCents: 10_000n }];
  const taxRateBps = options.taxRateBps ?? null;
  const totals = invoiceTotals(lines, taxRateBps);
  const number = options.number ?? `INV-${randomUUID().slice(0, 8)}`;
  const publicId =
    status === "draft" ? null : randomBytes(32).toString("base64url");

  return runInScope(db, asAdmin(company), async (tx) => {
    const customerId =
      options.customerId ??
      (
        await tx
          .insert(customers)
          .values({
            organizationId: company.organizationId,
            name: `Customer ${randomUUID().slice(0, 8)}`,
            email: `ap-${randomUUID()}@customer.test`,
          })
          .returning({ id: customers.id })
      )[0]?.id;
    if (!customerId) throw new Error("customer insert returned no row");

    const [invoice] = await tx
      .insert(invoices)
      .values({
        organizationId: company.organizationId,
        customerId,
        number,
        terms: "net_30",
        issueOn: options.issueOn ?? "2026-11-02",
        dueOn: options.dueOn ?? "2026-12-02",
        taxRateBps,
        subtotalCents: totals.subtotalCents,
        taxCents: totals.taxCents,
        totalCents: totals.totalCents,
        createdBy: company.admin.id,
      })
      .returning({ id: invoices.id });
    if (!invoice) throw new Error("invoice insert returned no row");

    await tx.insert(invoiceLineItems).values(
      lines.map((line, position) => ({
        organizationId: company.organizationId,
        invoiceId: invoice.id,
        position,
        description: line.description ?? `Line ${position + 1}`,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents,
        amountCents: totals.lineAmounts[position] ?? 0n,
      })),
    );
    // Lines can only be written while the invoice is a draft, so it is sent after.
    if (status === "open") {
      await tx
        .update(invoices)
        .set({
          status: "open",
          sentAt: new Date(),
          publicId,
          billTo: {
            name: "Customer",
            email: "ap@customer.test",
            address: null,
            taxId: null,
          },
          fromParty: { name: company.name, kraPin: null },
        })
        .where(eq(invoices.id, invoice.id));
    }
    return {
      customerId,
      invoiceId: invoice.id,
      number,
      publicId,
      totalCents: totals.totalCents,
    };
  });
}

export async function readInvoice(
  db: Database,
  company: TestCompany,
  invoiceId: string,
): Promise<InvoiceRow> {
  const [invoice] = await runInScope(db, asAdmin(company), (tx) =>
    tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
  );
  if (!invoice) throw new Error(`invoice ${invoiceId} not found`);
  return invoice;
}

/** A NEAR deposit credited to the company wallet, for matching to an invoice. */
export async function insertDeposit(
  db: Database,
  funded: FundedCompany,
  usdcAmount = 100_000_000n,
): Promise<string> {
  const [row] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .insert(walletTransactions)
        .values({
          organizationId: funded.company.organizationId,
          walletId: funded.walletId,
          type: "deposit",
          chain: "near",
          usdcAmount,
          txHash: randomNearTxHash(),
          receiptId: randomNearTxHash(),
          logIndex: 0,
          transferIndex: 0,
          blockNumber: 150_000_000n,
          counterpartyAddress: randomNearAccount(),
        })
        .returning({ id: walletTransactions.id }),
  );
  if (!row) throw new Error("deposit insert returned no row");
  return row.id;
}

/**
 * An `invoice_payment` quote as the pay route saves it: a customer on Base
 * paying the invoice total to the company wallet, refunds into NEAR Intents.
 * Written directly; nothing is asked of 1Click.
 */
export async function insertInvoiceQuote(
  db: Database,
  funded: FundedCompany,
  invoiceId: string,
  amountIn = 100_000_000n,
): Promise<IntentQuote> {
  const [quote] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .insert(intentQuotes)
        .values({
          organizationId: funded.company.organizationId,
          walletId: funded.walletId,
          quoteKey: `invoice:${randomUUID()}`,
          purpose: "invoice_payment",
          invoiceId,
          swapType: "EXACT_INPUT",
          originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.base,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amountIn,
          amountOut: amountIn,
          minAmountOut: amountIn - 1_000n,
          depositAddress: `0x${randomBytes(20).toString("hex")}`,
          recipient: funded.accountId,
          refundTo: randomNearAccount(),
          refundType: "INTENTS",
          deadline: new Date(Date.now() + 2 * 3_600_000),
          quoteResponse: { signature: "ed25519:test" },
        })
        .returning(),
  );
  if (!quote) throw new Error("quote insert returned no row");
  return quote;
}
