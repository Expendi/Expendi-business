import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { MembershipRole } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import {
  customers,
  intentQuotes,
  invoiceLineItems,
  invoicePayments,
  invoices,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { findInvoiceByPublicId } from "../../services/invoices/public-lookup.js";
import { createCompany } from "../helpers/db.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  insertDeposit,
  insertInvoiceQuote,
} from "../helpers/invoices.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { createFundedCompany } from "../helpers/money-in.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;
let funded: FundedCompany;

const asRole = (company: TestCompany, role: MembershipRole | undefined) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role,
});

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
  funded = await createFundedCompany(db);
  await Promise.all([
    createCustomerAndInvoice(db, fixture.companyA, { status: "open" }),
    createCustomerAndInvoice(db, fixture.companyB, { status: "open" }),
  ]);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("isolation", () => {
  it.each(["customers", "invoices", "invoice_line_items"])(
    "%s is isolated between companies",
    async (table) => {
      await expectTableIsolation(fixture, table, "organization_id", "admin");
    },
  );

  it("invoice_payments is isolated between companies", async () => {
    for (const company of [fixture.companyA, fixture.companyB]) {
      const { invoiceId } = await createCustomerAndInvoice(db, company, {
        status: "open",
      });
      await runInScope(db, asAdmin(company), (tx) =>
        tx.insert(invoicePayments).values({
          organizationId: company.organizationId,
          invoiceId,
          kind: "outside",
          paidOn: "2026-11-05",
        }),
      );
    }
    await expectTableIsolation(
      fixture,
      "invoice_payments",
      "organization_id",
      "admin",
    );
  });
});

describe("roles", () => {
  it("lets an accountant read invoices, lines and customers but not write", async () => {
    const company = await createCompany(db);
    const { invoiceId, customerId } = await createCustomerAndInvoice(
      db,
      company,
      { status: "open" },
    );
    const accountant = asRole(company, "accountant");

    const read = await runInScope(db, accountant, async (tx) => ({
      invoices: await tx.select().from(invoices),
      lines: await tx.select().from(invoiceLineItems),
      customers: await tx.select().from(customers),
    }));
    expect(read.invoices).toHaveLength(1);
    expect(read.lines).toHaveLength(1);
    expect(read.customers).toHaveLength(1);

    await expect(
      runInScope(db, accountant, (tx) =>
        tx.insert(customers).values({
          organizationId: company.organizationId,
          name: "Nope",
          email: "nope@customer.test",
        }),
      ),
    ).rejects.toThrow();
    const updated = await runInScope(db, accountant, (tx) =>
      tx
        .update(invoices)
        .set({ note: "changed" })
        .where(eq(invoices.id, invoiceId))
        .returning(),
    );
    expect(updated).toEqual([]);
    const renamed = await runInScope(db, accountant, (tx) =>
      tx
        .update(customers)
        .set({ name: "Changed" })
        .where(eq(customers.id, customerId))
        .returning(),
    );
    expect(renamed).toEqual([]);
  });

  it("hides everything from an employee", async () => {
    const company = await createCompany(db);
    await createCustomerAndInvoice(db, company, { status: "open" });
    const employee = asRole(company, "employee");

    const read = await runInScope(db, employee, async (tx) => ({
      invoices: await tx.select().from(invoices),
      lines: await tx.select().from(invoiceLineItems),
      customers: await tx.select().from(customers),
      payments: await tx.select().from(invoicePayments),
    }));
    expect(read).toEqual({
      invoices: [],
      lines: [],
      customers: [],
      payments: [],
    });
  });

  it("lets the system (no role) read and mark paid, but not write drafts", async () => {
    const company = await createCompany(db);
    const { invoiceId } = await createCustomerAndInvoice(db, company, {
      status: "open",
    });
    const system = asRole(company, undefined);

    const seen = await runInScope(db, system, (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
    );
    expect(seen).toHaveLength(1);
    const customerRows = await runInScope(db, system, (tx) =>
      tx.select().from(customers),
    );
    expect(customerRows).toEqual([]);
    await expect(
      runInScope(db, system, (tx) =>
        tx.insert(invoiceLineItems).values({
          organizationId: company.organizationId,
          invoiceId,
          position: 5,
          description: "x",
          quantity: "1",
          unitPriceCents: 1n,
          amountCents: 1n,
        }),
      ),
    ).rejects.toThrow();
  });

  it("stops the system recording a payment by hand", async () => {
    const company = await createCompany(db);
    const { invoiceId } = await createCustomerAndInvoice(db, company, {
      status: "open",
    });
    await expect(
      runInScope(db, asRole(company, undefined), (tx) =>
        tx.insert(invoicePayments).values({
          organizationId: company.organizationId,
          invoiceId,
          kind: "outside",
          paidOn: "2026-11-05",
        }),
      ),
    ).rejects.toThrow();
  });

  it("deletes drafts but not sent invoices", async () => {
    const company = await createCompany(db);
    const draft = await createCustomerAndInvoice(db, company);
    const sent = await createCustomerAndInvoice(db, company, {
      status: "open",
    });

    const removed = await runInScope(db, asAdmin(company), (tx) =>
      tx
        .delete(invoices)
        .where(eq(invoices.id, draft.invoiceId))
        .returning({ id: invoices.id }),
    );
    const kept = await runInScope(db, asAdmin(company), (tx) =>
      tx
        .delete(invoices)
        .where(eq(invoices.id, sent.invoiceId))
        .returning({ id: invoices.id }),
    );

    expect(removed).toHaveLength(1);
    expect(kept).toEqual([]);
    const lines = await runInScope(db, asAdmin(company), (tx) =>
      tx
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, draft.invoiceId)),
    );
    expect(lines).toEqual([]);
  });

  it("changes lines only while the invoice is a draft", async () => {
    const company = await createCompany(db);
    const sent = await createCustomerAndInvoice(db, company, {
      status: "open",
    });
    const lineRows = await runInScope(db, asAdmin(company), (tx) =>
      tx
        .delete(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, sent.invoiceId))
        .returning(),
    );
    expect(lineRows).toEqual([]);
    await expect(
      runInScope(db, asAdmin(company), (tx) =>
        tx.insert(invoiceLineItems).values({
          organizationId: company.organizationId,
          invoiceId: sent.invoiceId,
          position: 9,
          description: "late",
          quantity: "1",
          unitPriceCents: 1n,
          amountCents: 1n,
        }),
      ),
    ).rejects.toThrow();
  });

  it("deletes a hand-recorded payment but never a link payment", async () => {
    const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
    });
    const quote = await insertInvoiceQuote(db, funded, invoiceId);
    const depositId = await insertDeposit(db, funded);
    const [link, outside] = await runInScope(
      db,
      asAdmin(funded.company),
      (tx) =>
        tx
          .insert(invoicePayments)
          .values([
            {
              organizationId: funded.company.organizationId,
              invoiceId,
              kind: "link",
              intentQuoteId: quote.id,
              walletTransactionId: depositId,
              amountUsdc: 100_000_000n,
              paidOn: "2026-11-05",
            },
            {
              organizationId: funded.company.organizationId,
              invoiceId,
              kind: "outside",
              paidOn: "2026-11-05",
            },
          ])
          .returning({ id: invoicePayments.id }),
    );

    const gone = await runInScope(db, asAdmin(funded.company), (tx) =>
      tx
        .delete(invoicePayments)
        .where(eq(invoicePayments.id, link?.id ?? ""))
        .returning(),
    );
    const removed = await runInScope(db, asAdmin(funded.company), (tx) =>
      tx
        .delete(invoicePayments)
        .where(eq(invoicePayments.id, outside?.id ?? ""))
        .returning(),
    );

    expect(gone).toEqual([]);
    expect(removed).toHaveLength(1);
  });
});

describe("constraints", () => {
  const insertInvoice = (
    company: TestCompany,
    customerId: string,
    overrides: Partial<typeof invoices.$inferInsert>,
  ) =>
    runInScope(db, asAdmin(company), (tx) =>
      tx.insert(invoices).values({
        organizationId: company.organizationId,
        customerId,
        number: `INV-${randomUUID().slice(0, 8)}`,
        issueOn: "2026-11-02",
        dueOn: "2026-12-02",
        subtotalCents: 100n,
        taxCents: 16n,
        totalCents: 116n,
        createdBy: company.admin.id,
        ...overrides,
      }),
    );

  it.each([
    [
      "a total that isn't subtotal plus tax",
      { totalCents: 117n },
      "invoices_amounts",
    ],
    [
      "a negative subtotal",
      { subtotalCents: -1n, totalCents: 15n },
      "invoices_amounts",
    ],
    ["a tax rate over 100%", { taxRateBps: 10_001 }, "invoices_tax_rate_bps"],
    [
      "a due date before the issue date",
      { dueOn: "2026-11-01" },
      "invoices_due_not_before_issue",
    ],
    [
      "a sent invoice without its snapshot",
      { status: "open" as const, sentAt: new Date() },
      "invoices_sent_has_snapshot",
    ],
    [
      "a draft with a public ID",
      { publicId: "x" },
      "invoices_sent_has_snapshot",
    ],
    [
      "paid without a paid time",
      {
        status: "paid" as const,
        sentAt: new Date(),
        publicId: "p",
        billTo: { name: "a", email: "a@b.test", address: null, taxId: null },
        fromParty: { name: "c", kraPin: null },
      },
      "invoices_paid_has_time",
    ],
    [
      "a void invoice without a reason",
      {
        status: "void" as const,
        sentAt: new Date(),
        voidedAt: new Date(),
        publicId: "p",
        billTo: { name: "a", email: "a@b.test", address: null, taxId: null },
        fromParty: { name: "c", kraPin: null },
      },
      "invoices_void_recorded",
    ],
  ])("rejects %s", async (_label, overrides, constraint) => {
    const company = await createCompany(db);
    const { customerId } = await createCustomerAndInvoice(db, company);

    await expect(
      insertInvoice(company, customerId, overrides),
    ).rejects.toMatchObject({
      cause: { constraint },
    });
  });

  it("keeps a number unique per company only", async () => {
    const [a, b] = [fixture.companyA, fixture.companyB];
    const first = await createCustomerAndInvoice(db, a, { number: "DUP-1" });
    await expect(
      createCustomerAndInvoice(db, a, { number: "DUP-1" }),
    ).rejects.toMatchObject({
      cause: { constraint: "invoices_organization_number_unique" },
    });
    await expect(
      createCustomerAndInvoice(db, b, { number: "DUP-1" }),
    ).resolves.toBeDefined();
    expect(first.number).toBe("DUP-1");
  });

  it("refuses another company's customer", async () => {
    const other = await createCustomerAndInvoice(db, fixture.companyB);
    await expect(
      createCustomerAndInvoice(db, fixture.companyA, {
        customerId: other.customerId,
      }),
    ).rejects.toThrow();
  });

  it("refuses a second line in the same position", async () => {
    const { invoiceId } = await createCustomerAndInvoice(db, fixture.companyA);
    await expect(
      runInScope(db, asAdmin(fixture.companyA), (tx) =>
        tx.insert(invoiceLineItems).values({
          organizationId: fixture.companyA.organizationId,
          invoiceId,
          position: 0,
          description: "again",
          quantity: "1",
          unitPriceCents: 1n,
          amountCents: 1n,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "invoice_line_items_invoice_position_unique" },
    });
  });

  describe("invoice payments", () => {
    const insertPayment = (
      invoiceId: string,
      values: Partial<typeof invoicePayments.$inferInsert>,
    ) =>
      runInScope(db, asAdmin(funded.company), (tx) =>
        tx.insert(invoicePayments).values({
          organizationId: funded.company.organizationId,
          invoiceId,
          kind: "outside",
          paidOn: "2026-11-05",
          ...values,
        }),
      );

    it("needs a quote, a deposit and an amount for a link payment", async () => {
      const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });
      const quote = await insertInvoiceQuote(db, funded, invoiceId);
      const depositId = await insertDeposit(db, funded);
      const check = {
        cause: { constraint: "invoice_payments_kind_has_sources" },
      };

      await expect(
        insertPayment(invoiceId, {
          kind: "link",
          walletTransactionId: depositId,
          amountUsdc: 1n,
        }),
      ).rejects.toMatchObject(check);
      await expect(
        insertPayment(invoiceId, {
          kind: "link",
          intentQuoteId: quote.id,
          amountUsdc: 1n,
        }),
      ).rejects.toMatchObject(check);
      await expect(
        insertPayment(invoiceId, {
          kind: "link",
          intentQuoteId: quote.id,
          walletTransactionId: depositId,
        }),
      ).rejects.toMatchObject(check);
    });

    it("needs a deposit and no quote for a matched payment", async () => {
      const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });
      const quote = await insertInvoiceQuote(db, funded, invoiceId);
      const depositId = await insertDeposit(db, funded);
      const check = {
        cause: { constraint: "invoice_payments_kind_has_sources" },
      };

      await expect(
        insertPayment(invoiceId, { kind: "matched", amountUsdc: 1n }),
      ).rejects.toMatchObject(check);
      await expect(
        insertPayment(invoiceId, {
          kind: "matched",
          walletTransactionId: depositId,
          amountUsdc: 1n,
          intentQuoteId: quote.id,
        }),
      ).rejects.toMatchObject(check);
    });

    it("takes no deposit or amount for an outside payment", async () => {
      const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });
      const depositId = await insertDeposit(db, funded);
      const check = {
        cause: { constraint: "invoice_payments_kind_has_sources" },
      };

      await expect(
        insertPayment(invoiceId, {
          kind: "outside",
          walletTransactionId: depositId,
        }),
      ).rejects.toMatchObject(check);
      await expect(
        insertPayment(invoiceId, { kind: "outside", amountUsdc: 5n }),
      ).rejects.toMatchObject(check);
    });

    it("lets a deposit pay one invoice", async () => {
      const first = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });
      const second = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });
      const depositId = await insertDeposit(db, funded);
      await insertPayment(first.invoiceId, {
        kind: "matched",
        walletTransactionId: depositId,
        amountUsdc: 1n,
      });

      await expect(
        insertPayment(second.invoiceId, {
          kind: "matched",
          walletTransactionId: depositId,
          amountUsdc: 1n,
        }),
      ).rejects.toMatchObject({
        cause: { constraint: "invoice_payments_wallet_transaction_id_unique" },
      });
    });

    it("refuses another company's deposit", async () => {
      const other = await createFundedCompany(db);
      const foreignDeposit = await insertDeposit(db, other);
      const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
        status: "open",
      });

      await expect(
        insertPayment(invoiceId, {
          kind: "matched",
          walletTransactionId: foreignDeposit,
          amountUsdc: 1n,
        }),
      ).rejects.toMatchObject({
        cause: {
          constraint: "invoice_payments_wallet_transaction_organization_fk",
        },
      });
    });
  });
});

describe("invoice payment quotes", () => {
  it("require an invoice", async () => {
    const base = await insertInvoiceQuote(
      db,
      funded,
      (await createCustomerAndInvoice(db, funded.company, { status: "open" }))
        .invoiceId,
    );
    const {
      id: _id,
      createdAt: _c,
      updatedAt: _u,
      invoiceId: _i,
      ...rest
    } = base;

    await expect(
      runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
        tx.insert(intentQuotes).values({
          ...rest,
          quoteKey: `invoice:${randomUUID()}`,
          depositAddress: `0x${randomBytes(20).toString("hex")}`,
          invoiceId: null,
        }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_invoice_matches_purpose" },
    });
  });

  it("are the only quotes that name an invoice", async () => {
    const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
    });
    const base = await insertInvoiceQuote(db, funded, invoiceId);
    const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = base;

    await expect(
      runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
        tx.insert(intentQuotes).values({
          ...rest,
          quoteKey: `fund-in:${randomUUID()}`,
          depositAddress: `0x${randomBytes(20).toString("hex")}`,
          purpose: "fund_in",
        }),
      ),
    ).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_invoice_matches_purpose" },
    });
  });

  it("refuse another company's invoice", async () => {
    const foreign = await createCustomerAndInvoice(db, fixture.companyB, {
      status: "open",
    });

    await expect(
      insertInvoiceQuote(db, funded, foreign.invoiceId),
    ).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_invoice_organization_fk" },
    });
  });

  it("may refund into NEAR Intents", async () => {
    const { invoiceId } = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
    });

    const quote = await insertInvoiceQuote(db, funded, invoiceId);

    expect(quote).toMatchObject({
      purpose: "invoice_payment",
      refundType: "INTENTS",
      depositType: "ORIGIN_CHAIN",
      invoiceId,
    });
  });
});

describe("findInvoiceByPublicId", () => {
  const find = (publicId: string) =>
    runtime.runPromise(findInvoiceByPublicId(publicId));

  it("finds a sent invoice with no company in context", async () => {
    const { invoiceId, publicId } = await createCustomerAndInvoice(
      db,
      fixture.companyA,
      { status: "open" },
    );

    expect(await find(publicId ?? "")).toEqual({
      invoiceId,
      organizationId: fixture.companyA.organizationId,
    });
  });

  it("finds nothing for an unknown or malformed ID", async () => {
    expect(await find(randomBytes(32).toString("base64url"))).toBeNull();
    expect(await find("short")).toBeNull();
    expect(await find("' OR 1=1 --")).toBeNull();
  });

  it("never resolves a draft", async () => {
    const { invoiceId } = await createCustomerAndInvoice(db, fixture.companyA);
    const [draft] = await runInScope(db, asAdmin(fixture.companyA), (tx) =>
      tx.select().from(invoices).where(eq(invoices.id, invoiceId)),
    );
    expect(draft?.publicId).toBeNull();
  });
});
