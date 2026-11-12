import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  Customer,
  Invoice,
  InvoiceDraftRequest,
  MatchableDeposit,
} from "@expendi-business/shared";
import { customerSchema, invoiceSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { invoices } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeEmailSender } from "../helpers/fakes.js";
import {
  asAdmin,
  createCustomerAndInvoice,
  insertDeposit,
  readInvoice,
} from "../helpers/invoices.js";
import { createFundedCompany } from "../helpers/money-in.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const DASHBOARD = "https://dash.expendi.test";
const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let funded: FundedCompany;
let employee: TestUser;
let accountant: TestUser;
let customer: Customer;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { emailSender: email.layer },
    { DASHBOARD_ORIGINS: `${DASHBOARD}/, http://localhost:3002` },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  email.state.reset();
  funded = await createFundedCompany(db);
  employee = await createUser(db);
  accountant = await createUser(db);
  await addMember(db, funded.company, employee);
  await addMember(db, funded.company, accountant, { role: "accountant" });
  customer = await addCustomer();
});

const orgPath = (organizationId = funded.company.organizationId) =>
  `/organizations/${organizationId}`;
const base = (organizationId?: string) => `${orgPath(organizationId)}/invoices`;

const send = (
  method: string,
  path: string,
  body?: unknown,
  user: Pick<TestUser, "privyUserId"> = funded.company.admin,
) => sendJson(app, path, user, { method, body });

async function dataOf<T>(response: Response): Promise<T> {
  const { data } = (await response.json()) as { data: T };
  return data;
}

async function addCustomer(fields: Record<string, unknown> = {}) {
  const response = await send("POST", `${orgPath()}/customers`, {
    name: "Safaricom PLC",
    email: "ap@safaricom.test",
    address: "Waiyaki Way",
    taxId: "P051234567X",
    ...fields,
  });
  return customerSchema.parse(await dataOf(response));
}

let numbering = 0;
function draftBody(
  overrides: Partial<InvoiceDraftRequest> = {},
): InvoiceDraftRequest {
  numbering += 1;
  return {
    customerId: customer.id,
    number: `INV-${String(numbering).padStart(4, "0")}`,
    issueOn: "2026-11-02",
    terms: "net_30",
    lines: [
      { description: "Consulting", quantity: "1", unitPriceCents: "10000" },
    ],
    ...overrides,
  };
}

async function createDraft(
  overrides: Partial<InvoiceDraftRequest> = {},
): Promise<Invoice> {
  const response = await send("POST", base(), draftBody(overrides));
  if (response.status !== 201) {
    throw new Error(
      `create answered ${response.status}: ${await response.text()}`,
    );
  }
  return invoiceSchema.parse(await dataOf(response));
}

async function sendDraft(invoiceId: string): Promise<Invoice> {
  const response = await send("POST", `${base()}/${invoiceId}/send`);
  if (response.status !== 200) {
    throw new Error(
      `send answered ${response.status}: ${await response.text()}`,
    );
  }
  return invoiceSchema.parse(await dataOf(response));
}

const errorOf = async (response: Response) =>
  ((await response.json()) as { error: { _tag: string; message: string } })
    .error;

describe("roles", () => {
  it("lets an admin write, an accountant read only, and keeps employees out", async () => {
    // #given
    const invoice = await createDraft();
    const paths = [
      ["GET", base()],
      ["GET", `${base()}/next-number`],
      ["GET", `${base()}/${invoice.id}`],
      ["GET", `${base()}/${invoice.id}/matchable-deposits`],
    ] as const;
    const writes = [
      ["POST", base(), draftBody()],
      ["PATCH", `${base()}/${invoice.id}`, draftBody()],
      ["DELETE", `${base()}/${invoice.id}`, undefined],
      ["POST", `${base()}/${invoice.id}/send`, undefined],
      ["POST", `${base()}/${invoice.id}/remind`, undefined],
      ["POST", `${base()}/${invoice.id}/void`, { reason: "x" }],
      ["POST", `${base()}/${invoice.id}/mark-paid`, { paidOn: "2026-11-02" }],
      [
        "POST",
        `${base()}/${invoice.id}/match`,
        { walletTransactionId: invoice.id },
      ],
      ["DELETE", `${base()}/${invoice.id}/payments/${invoice.id}`, undefined],
    ] as const;

    // #when
    const accountantReads = await Promise.all(
      paths.map(([method, path]) => send(method, path, undefined, accountant)),
    );
    const accountantWrites = await Promise.all(
      writes.map(([method, path, body]) =>
        send(method, path, body, accountant),
      ),
    );
    const employeeAll = await Promise.all(
      [...paths, ...writes].map(([method, path, body]) =>
        send(method, path, body, employee),
      ),
    );

    // #then
    expect(accountantReads.map((r) => r.status)).toEqual([200, 200, 200, 200]);
    expect(accountantWrites.map((r) => r.status)).toEqual(
      writes.map(() => 403),
    );
    expect(employeeAll.map((r) => r.status)).toEqual(
      [...paths, ...writes].map(() => 403),
    );
  });

  it("shows nothing of another company's invoices and refuses its prefix", async () => {
    // #given
    const other = await createFundedCompany(db);
    const mine = await createDraft();
    const theirs = await createCustomerAndInvoice(db, other.company);

    // #when
    const readTheirs = await send("GET", `${base()}/${theirs.invoiceId}`);
    const sendTheirs = await send("POST", `${base()}/${theirs.invoiceId}/send`);
    const deleteTheirs = await send("DELETE", `${base()}/${theirs.invoiceId}`);
    const underTheirPrefix = await send(
      "GET",
      `${base(other.company.organizationId)}/${theirs.invoiceId}`,
    );
    const list = await dataOf<{ invoices: { id: string }[] }>(
      await send("GET", base()),
    );

    // #then
    expect([readTheirs.status, sendTheirs.status, deleteTheirs.status]).toEqual(
      [404, 404, 404],
    );
    expect(underTheirPrefix.status).toBe(403);
    expect(list.invoices.map((i) => i.id)).toEqual([mine.id]);
  });
});

describe("drafts", () => {
  it("computes line amounts, tax and total with half-up rounding", async () => {
    // #when
    const invoice = await createDraft({
      taxRateBps: 1600,
      taxLabel: "VAT",
      note: "Thank you",
      lines: [
        { description: "Hours", quantity: "2.5", unitPriceCents: "1999" },
        { description: "Fee", quantity: "1", unitPriceCents: "1" },
      ],
    });

    // #then 2.5 × 1999 = 4997.5 -> 4998; subtotal 4999; tax 799.84 -> 800
    expect(invoice).toMatchObject({
      status: "draft",
      overdue: false,
      customerName: "Safaricom PLC",
      subtotalCents: "4999",
      taxRateBps: 1600,
      taxCents: "800",
      totalCents: "5799",
      dueOn: "2026-12-02",
      publicId: null,
      note: "Thank you",
      billTo: { name: "Safaricom PLC", email: "ap@safaricom.test" },
      from: { name: funded.company.name },
      lines: [
        { description: "Hours", amountCents: "4998" },
        { description: "Fee", amountCents: "1" },
      ],
    });
  });

  it("sets the due date from the terms, or the chosen date", async () => {
    // #when
    const onReceipt = await createDraft({ terms: "on_receipt" });
    const net15 = await createDraft({ terms: "net_15" });
    const custom = await createDraft({ terms: "custom", dueOn: "2026-11-20" });

    // #then
    expect([onReceipt.dueOn, net15.dueOn, custom.dueOn]).toEqual([
      "2026-11-02",
      "2026-11-17",
      "2026-11-20",
    ]);
  });

  it("refuses a duplicate number, but frees it when the draft is deleted", async () => {
    // #given
    const first = await createDraft({ number: "INV-0900" });

    // #when
    const duplicate = await send(
      "POST",
      base(),
      draftBody({ number: "INV-0900" }),
    );
    const removal = await send("DELETE", `${base()}/${first.id}`);
    const reused = await send(
      "POST",
      base(),
      draftBody({ number: "INV-0900" }),
    );

    // #then
    expect(duplicate.status).toBe(409);
    expect((await errorOf(duplicate)).message).toBe(
      "That invoice number is already used.",
    );
    expect(removal.status).toBe(204);
    expect(reused.status).toBe(201);
  });

  it("suggests the next number from the company's invoices", async () => {
    // #given
    await createDraft({ number: "INV-0041" });
    await createDraft({ number: "2026/INV-0007" });

    // #when
    const next = await send("GET", `${base()}/next-number`);

    // #then
    expect(await dataOf(next)).toEqual({ number: "INV-0042" });
  });

  it("replaces the lines when a draft is updated", async () => {
    // #given
    const draft = await createDraft();

    // #when
    const response = await send(
      "PATCH",
      `${base()}/${draft.id}`,
      draftBody({
        number: draft.number,
        lines: [{ description: "New", quantity: "3", unitPriceCents: "250" }],
      }),
    );

    // #then
    expect(await dataOf<Invoice>(response)).toMatchObject({
      totalCents: "750",
      lines: [{ description: "New", amountCents: "750" }],
    });
  });

  it("refuses an archived customer on a new or updated draft", async () => {
    // #given
    const archived = await addCustomer({ name: "Old customer" });
    await send("PATCH", `${orgPath()}/customers/${archived.id}`, {
      archived: true,
    });
    const draft = await createDraft();

    // #when
    const create = await send(
      "POST",
      base(),
      draftBody({ customerId: archived.id }),
    );
    const update = await send(
      "PATCH",
      `${base()}/${draft.id}`,
      draftBody({ number: draft.number, customerId: archived.id }),
    );

    // #then
    expect([create.status, update.status]).toEqual([400, 400]);
  });

  it("refuses an invoice that comes to too much", async () => {
    // #when
    const response = await send(
      "POST",
      base(),
      draftBody({
        lines: [
          {
            description: "Huge",
            quantity: "1",
            unitPriceCents: "999999999999999",
          },
        ],
      }),
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("only lets a draft be edited or deleted", async () => {
    // #given
    const draft = await createDraft();
    await sendDraft(draft.id);

    // #when
    const edit = await send(
      "PATCH",
      `${base()}/${draft.id}`,
      draftBody({ number: draft.number }),
    );
    const remove = await send("DELETE", `${base()}/${draft.id}`);

    // #then
    expect([edit.status, remove.status]).toEqual([409, 409]);
  });
});

describe("sending", () => {
  it("snapshots the parties, makes the pay link and emails the customer", async () => {
    // #given
    const draft = await createDraft({ note: "Net 30, thanks" });

    // #when
    const invoice = await sendDraft(draft.id);
    await send("PATCH", `${orgPath()}/customers/${customer.id}`, {
      name: "Renamed Ltd",
    });
    const later = await dataOf<Invoice>(
      await send("GET", `${base()}/${draft.id}`),
    );

    // #then
    expect(invoice.status).toBe("open");
    expect(invoice.publicId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(invoice.sentAt).not.toBeNull();
    expect(later.billTo.name).toBe("Safaricom PLC");
    expect(later.from.name).toBe(funded.company.name);
    expect(email.state.sent).toHaveLength(1);
    const [message] = email.state.sent;
    expect(message).toMatchObject({
      to: "ap@safaricom.test",
      idempotencyKey: `invoice-${draft.id}-sent`,
    });
    expect(message?.subject).toBe(
      `Invoice ${draft.number} from ${funded.company.name} — $100.00 due 2 December 2026`,
    );
    expect(message?.text).toContain(`${DASHBOARD}/pay/${invoice.publicId}`);
    expect(message?.html).toContain(
      `href="${DASHBOARD}/pay/${invoice.publicId}"`,
    );
    expect(message?.text).toContain("Net 30, thanks");
  });

  it("stays sent when the email fails, and remind can retry", async () => {
    // #given
    const draft = await createDraft();
    email.state.failNext();

    // #when
    const invoice = await sendDraft(draft.id);
    const remind = await send("POST", `${base()}/${draft.id}/remind`);

    // #then
    expect(invoice.status).toBe("open");
    expect(remind.status).toBe(200);
    expect(email.state.sent).toHaveLength(1);
  });

  it("refuses a send without an active company wallet", async () => {
    // #given
    const bare = await createCompany(db);
    const seeded = await createCustomerAndInvoice(db, bare);

    // #when
    const response = await send(
      "POST",
      `${base(bare.organizationId)}/${seeded.invoiceId}/send`,
      undefined,
      bare.admin,
    );

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "Set up your company wallet before sending invoices.",
    );
    expect((await readInvoice(db, bare, seeded.invoiceId)).status).toBe(
      "draft",
    );
    expect(email.state.sent).toEqual([]);
  });

  it("refuses a zero total, an archived customer and a second send", async () => {
    // #given
    const free = await createDraft({
      lines: [{ description: "Gift", quantity: "1", unitPriceCents: "0" }],
    });
    const archivedCustomer = await addCustomer({ name: "Soon archived" });
    const forArchived = await createDraft({ customerId: archivedCustomer.id });
    await send("PATCH", `${orgPath()}/customers/${archivedCustomer.id}`, {
      archived: true,
    });
    const ok = await createDraft();
    await sendDraft(ok.id);

    // #when
    const zero = await send("POST", `${base()}/${free.id}/send`);
    const archived = await send("POST", `${base()}/${forArchived.id}/send`);
    const again = await send("POST", `${base()}/${ok.id}/send`);

    // #then
    expect([zero.status, archived.status, again.status]).toEqual([
      400, 400, 409,
    ]);
  });

  it("answers 503 and changes nothing when no dashboard origin is configured", async () => {
    // #given
    const bare = makeTestRuntime(
      { emailSender: email.layer },
      { DASHBOARD_ORIGINS: undefined },
    );
    const bareApp = createApp({ runtime: bare });
    const draft = await createDraft();

    // #when
    const response = await sendJson(
      bareApp,
      `${base()}/${draft.id}/send`,
      funded.company.admin,
      { method: "POST" },
    );
    await bare.dispose();

    // #then
    expect(response.status).toBe(503);
    expect((await readInvoice(db, funded.company, draft.id)).status).toBe(
      "draft",
    );
    expect(email.state.sent).toEqual([]);
  });
});

describe("reminding", () => {
  it("refuses a reminder right after an email, then resends the link", async () => {
    // #given
    const draft = await createDraft();
    const invoice = await sendDraft(draft.id);
    email.state.reset();

    // #when
    const tooSoon = await send("POST", `${base()}/${draft.id}/remind`);
    await runInScope(db, asAdmin(funded.company), (tx) =>
      tx
        .update(invoices)
        .set({ lastEmailedAt: new Date(Date.now() - 11 * 60_000) })
        .where(eq(invoices.id, draft.id)),
    );
    const remind = await send("POST", `${base()}/${draft.id}/remind`);

    // #then
    expect(remind.status).toBe(200);
    expect(tooSoon.status).toBe(429);
    expect(email.state.sent).toHaveLength(1);
    expect(email.state.sent[0]?.text).toContain(`/pay/${invoice.publicId}`);
    expect(email.state.sent[0]?.text).toContain("A reminder from");
    expect(await dataOf<{ remindedAt: string }>(remind)).toEqual({
      remindedAt: expect.stringMatching(/^\d{4}-/) as string,
    });
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_log WHERE entity_id = $1 AND action = 'invoice.reminded'",
      [draft.id],
    );
    expect(rows).toHaveLength(1);
  });

  it("only reminds an open invoice", async () => {
    // #given
    const draft = await createDraft();

    // #when
    const response = await send("POST", `${base()}/${draft.id}/remind`);

    // #then
    expect(response.status).toBe(409);
  });
});

describe("lifecycle", () => {
  it("goes draft, open, paid, open again after an undo, then void", async () => {
    // #given
    const draft = await createDraft();
    const sent = await sendDraft(draft.id);
    expect(sent.status).toBe("open");

    // #when it is marked paid
    const paid = await send("POST", `${base()}/${draft.id}/mark-paid`, {
      paidOn: "2026-11-05",
      reference: "MPESA-123",
      note: "Paid by cheque",
    });
    const paidInvoice = await dataOf<Invoice>(paid);

    // #then
    expect(paidInvoice).toMatchObject({
      status: "paid",
      payments: [
        {
          kind: "outside",
          amountUsdc: null,
          paidOn: "2026-11-05",
          reference: "MPESA-123",
          note: "Paid by cheque",
          chain: null,
          txHash: null,
        },
      ],
    });
    expect(paidInvoice.paidAt).not.toBeNull();
    const [payment] = paidInvoice.payments;

    // #when a paid invoice is voided
    const voidPaid = await send("POST", `${base()}/${draft.id}/void`, {
      reason: "Mistake",
    });

    // #then
    expect(voidPaid.status).toBe(409);
    expect((await errorOf(voidPaid)).message).toBe(
      "A paid invoice can't be voided.",
    );

    // #when the payment is undone
    const undone = await send(
      "DELETE",
      `${base()}/${draft.id}/payments/${payment?.id}`,
    );

    // #then
    expect(await dataOf(undone)).toMatchObject({
      status: "open",
      paidAt: null,
      payments: [],
    });

    // #when it is voided
    const voided = await send("POST", `${base()}/${draft.id}/void`, {
      reason: "Customer cancelled",
    });

    // #then
    expect(await dataOf(voided)).toMatchObject({
      status: "void",
      voidedReason: "Customer cancelled",
    });
    const markVoid = await send("POST", `${base()}/${draft.id}/mark-paid`, {
      paidOn: "2026-11-06",
    });
    expect(markVoid.status).toBe(409);
    const actions = await owner.query<{ action: string }>(
      "SELECT action FROM audit_log WHERE entity_type = 'invoice' AND entity_id = $1 ORDER BY occurred_at, id",
      [draft.id],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "invoice.created",
      "invoice.sent",
      "invoice.paid",
      "invoice.payment_removed",
      "invoice.voided",
    ]);
  });

  it("refuses to void a draft and a paid date in the future", async () => {
    // #given
    const draft = await createDraft();
    await sendDraft(draft.id);

    // #when
    const future = await send("POST", `${base()}/${draft.id}/mark-paid`, {
      paidOn: "2999-01-01",
    });
    const second = await createDraft();
    const voidDraft = await send("POST", `${base()}/${second.id}/void`, {
      reason: "x",
    });

    // #then
    expect([future.status, voidDraft.status]).toEqual([400, 409]);
  });
});

describe("listing", () => {
  it("lists newest first, filters by status and finds overdue open invoices", async () => {
    // #given
    const draft = await createDraft();
    const late = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
      customerId: customer.id,
      issueOn: "2020-01-01",
      dueOn: "2020-01-31",
    });
    const current = await createCustomerAndInvoice(db, funded.company, {
      status: "open",
      customerId: customer.id,
      issueOn: "2020-01-01",
      dueOn: "2999-01-01",
    });

    // #when
    const idsFor = async (query: string) =>
      (
        await dataOf<{ invoices: { id: string; overdue: boolean }[] }>(
          await send("GET", `${base()}${query}`),
        )
      ).invoices;

    // #then
    expect((await idsFor("")).map((i) => i.id)).toEqual([
      current.invoiceId,
      late.invoiceId,
      draft.id,
    ]);
    expect((await idsFor("?status=draft")).map((i) => i.id)).toEqual([
      draft.id,
    ]);
    expect((await idsFor("?status=open")).map((i) => i.id)).toEqual([
      current.invoiceId,
      late.invoiceId,
    ]);
    const overdue = await idsFor("?status=overdue");
    expect(overdue.map((i) => i.id)).toEqual([late.invoiceId]);
    expect(overdue[0]?.overdue).toBe(true);
    expect((await idsFor("?status=open")).map((i) => i.overdue)).toEqual([
      false,
      true,
    ]);
    expect((await send("GET", `${base()}?status=bogus`)).status).toBe(400);
  });
});

describe("matching a deposit", () => {
  async function openInvoice() {
    const draft = await createDraft();
    return sendDraft(draft.id);
  }

  it("matches an unused deposit, pays the invoice and takes the deposit off the list", async () => {
    // #given
    const invoice = await openInvoice();
    const depositId = await insertDeposit(db, funded, 100_000_000n);

    // #when
    const before = await dataOf<{ deposits: MatchableDeposit[] }>(
      await send("GET", `${base()}/${invoice.id}/matchable-deposits`),
    );
    const matched = await send("POST", `${base()}/${invoice.id}/match`, {
      walletTransactionId: depositId,
    });
    const after = await dataOf<{ deposits: MatchableDeposit[] }>(
      await send("GET", `${base()}/${invoice.id}/matchable-deposits`),
    );

    // #then
    expect(before.deposits).toHaveLength(1);
    expect(before.deposits[0]).toMatchObject({
      walletTransactionId: depositId,
      amountUsdc: "100000000",
    });
    expect(before.deposits[0]?.from).toBeTruthy();
    expect(before.deposits[0]?.txHash).toBeTruthy();
    expect(await dataOf(matched)).toMatchObject({
      status: "paid",
      payments: [
        {
          kind: "matched",
          amountUsdc: "100000000",
          walletTransactionId: depositId,
          chain: null,
        },
      ],
    });
    expect(after.deposits).toEqual([]);
  });

  it("refuses a deposit another invoice already uses", async () => {
    // #given
    const first = await openInvoice();
    const second = await openInvoice();
    const depositId = await insertDeposit(db, funded);
    await send("POST", `${base()}/${first.id}/match`, {
      walletTransactionId: depositId,
    });

    // #when
    const response = await send("POST", `${base()}/${second.id}/match`, {
      walletTransactionId: depositId,
    });

    // #then
    expect(response.status).toBe(409);
    expect((await readInvoice(db, funded.company, second.id)).status).toBe(
      "open",
    );
  });

  it("refuses another company's deposit and an unknown one", async () => {
    // #given
    const invoice = await openInvoice();
    const other = await createFundedCompany(db);
    const foreign = await insertDeposit(db, other);

    // #when
    const theirs = await send("POST", `${base()}/${invoice.id}/match`, {
      walletTransactionId: foreign,
    });
    const unknown = await send("POST", `${base()}/${invoice.id}/match`, {
      walletTransactionId: invoice.id,
    });

    // #then
    expect([theirs.status, unknown.status]).toEqual([404, 404]);
  });

  it("lists only this company's deposits", async () => {
    // #given
    const invoice = await openInvoice();
    const other = await createFundedCompany(db);
    await insertDeposit(db, other);
    const mine = await insertDeposit(db, funded);

    // #when
    const list = await dataOf<{ deposits: MatchableDeposit[] }>(
      await send("GET", `${base()}/${invoice.id}/matchable-deposits`),
    );

    // #then
    expect(list.deposits.map((d) => d.walletTransactionId)).toEqual([mine]);
  });
});
