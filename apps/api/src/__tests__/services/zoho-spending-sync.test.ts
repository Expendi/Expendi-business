import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ZohoMapping } from "@expendi-business/shared";
import {
  accountingSyncsResponseSchema,
  billPaymentSchema,
  companySpendingDetailSchema,
  floatApprovalSchema,
  floatSpendingResultSchema,
  paidFromAccountSchema,
  payrollRunPaymentSchema,
  zohoStatusResponseSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AccountingSyncRow, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingSyncs,
  bills,
  cardPurchases,
  expenses,
  payouts,
  receiptFiles,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import { kesCentsFor } from "../../services/paycrest/amounts.js";
import { applyPayoutOutcome } from "../../services/payout/subjects.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import {
  enqueuePaidBill,
  enqueuePaidClaim,
  enqueueRecordedSpending,
} from "../../services/zoho/enqueue.js";
import { kesDecimal } from "../../services/zoho/posting.js";
import { syncAccountingItem } from "../../services/zoho/sync.js";
import { insertBill, insertPayee, readBill } from "../helpers/bills.js";
import { addCompanyHeldCard } from "../helpers/card-purchases.js";
import { claimFlow, makePayable } from "../helpers/claim-flow.js";
import {
  addCategory,
  randomSha256,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakeZoho,
  signPaycrestBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createNearUsdcPayingCompany,
  followPayout,
  makeNearUsdcFakes,
  registeredNearAccount,
} from "../helpers/near-usdc-payouts.js";
import {
  allowlistAddress,
  createPayingCompany,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import {
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import {
  connectZoho,
  signInToZoho,
  staffRequest,
  ZOHO_KES_ORGANIZATION,
  zohoStaffPath,
} from "../helpers/zoho.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * T44: petty cash spending, company spending, bills and payroll runs
 * pushed to Zoho Books (spec §6.17), against the fake Zoho.
 */

const TOKEN_KEY_BASE64 = Buffer.alloc(32, 7).toString("base64");

const near = makeNearUsdcFakes();
const { privy } = near;
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const rpc = makeFakeBaseRpc();
const zoho = makeFakeZoho();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let opsAdmin: TestStaff;

/** Accounts the fake's chart doesn't have by default. */
const EXTRA_ACCOUNTS = [
  { id: "acc-salaries", name: "Salaries", code: "6200", type: "expense" },
  { id: "acc-kcb", name: "KCB Current", code: null, type: "bank" },
] as const;

const OLD_CHANGE = new Date("2026-01-01T00:00:00Z");

/** 23 Nov in Nairobi: 28 Nov's payroll run is drafted. */
const NOV_23_EAT = new Date("2026-11-22T21:00:00Z");

beforeAll(async () => {
  runtime = makeTestRuntime(
    {
      ...near.layers,
      paycrest: paycrest.layer,
      fileStorage: storage.layer,
      baseRpc: rpc.layer,
      zoho: zoho.layer,
    },
    { ACCOUNTING_TOKEN_KEY: TOKEN_KEY_BASE64 },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  opsAdmin = await createStaff(owner);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  zoho.state.reset();
  zoho.state.accounts.push(...EXTRA_ACCOUNTS);
});

interface Company {
  readonly paying: PayingCompany;
  readonly company: TestCompany;
  readonly officeId: string;
  readonly kcbId: string;
  readonly cardId: string;
  readonly mapping: ZohoMapping;
}

const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function addPaidFromAccount(
  company: TestCompany,
  name: string,
  kind: "bank" | "card",
): Promise<string> {
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/paid-from-accounts`,
    company.admin,
    { method: "POST", body: { name, kind } },
  );
  expect(response.status).toBe(201);
  return paidFromAccountSchema.parse(await dataOf(response)).id;
}

/**
 * A funded company with an Office category and two paid-from accounts: the
 * KCB account is mapped in Zoho, the card isn't.
 */
async function setUpCompany(
  mainChain: "base" | "near" = "base",
): Promise<Company> {
  const paying =
    mainChain === "near"
      ? await createNearUsdcPayingCompany(runtime, db, near, 20_000n * USDC)
      : await createPayingCompany(runtime, db, 20_000n * USDC);
  const { company } = paying;
  const officeId = await addCategory(db, company, "Office");
  const kcbId = await addPaidFromAccount(
    company,
    "KCB current account",
    "bank",
  );
  const cardId = await addPaidFromAccount(company, "Founder's Visa", "card");
  return {
    paying,
    company,
    officeId,
    kcbId,
    cardId,
    mapping: {
      categoryAccounts: { [officeId]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
      pettyCashAccountId: "acc-petty",
      salariesAccountId: "acc-salaries",
      paidFromAccounts: { [kcbId]: "acc-kcb", [cardId]: null },
    },
  };
}

/**
 * A company connected to Zoho Books. Its wallet is on Base, where cash-outs
 * are funded in these tests, unless the test pays USDC from NEAR.
 */
async function connected(
  mainChain: "base" | "near" = "base",
): Promise<Company> {
  const setUp = await setUpCompany(mainChain);
  await connectZoho(app, opsAdmin, setUp.company, setUp.mapping);
  return setUp;
}

async function syncsOf(company: TestCompany): Promise<AccountingSyncRow[]> {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.select().from(accountingSyncs).orderBy(asc(accountingSyncs.createdAt)),
  );
}

async function onlySync(company: TestCompany): Promise<AccountingSyncRow> {
  const rows = await syncsOf(company);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("no sync");
  return row;
}

async function runSync(company: TestCompany): Promise<string[]> {
  const outcomes: string[] = [];
  for (const row of await syncsOf(company)) {
    outcomes.push(
      await runtime.runPromise(
        syncAccountingItem(company.organizationId, row.id),
      ),
    );
  }
  return outcomes;
}

const postedTo = (reference: string) =>
  zoho.state.expenses.filter(
    ({ draft }) => draft.referenceNumber === reference,
  );

async function expenseCreatedAt(
  company: TestCompany,
  expenseId: string,
): Promise<Date | undefined> {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({ createdAt: expenses.createdAt })
        .from(expenses)
        .where(eq(expenses.id, expenseId)),
  );
  return row?.createdAt;
}

// ── Passkey approvals and Paycrest ───────────────────────────────────────

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

interface Challenge<T> {
  readonly preview: T;
  readonly options: SignOptions;
}

async function challengeOf<T extends { readonly challengeId: string }>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<Challenge<T>> {
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    preview: schema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

async function confirm(
  { paying }: Company,
  path: string,
  { preview, options }: Challenge<{ readonly challengeId: string }>,
): Promise<void> {
  const response = await sendJson(
    app,
    `${path}/${preview.challengeId}/confirm`,
    paying.company.admin,
    {
      method: "POST",
      body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
    },
  );
  expect(response.status).toBe(200);
}

/** Paycrest settles (or refunds) the order, through its signed webhook. */
async function settle(payout: Payout, status = "settled"): Promise<void> {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, {
    ...order,
    status,
    paymentReference: status === "settled" ? "SKL3ABCDEF" : null,
  });
  const body = JSON.stringify({
    event: `payment_order.${status}`,
    webhookVersion: "1",
    data: { id: payout.providerOrderId, status },
  });
  const response = await app.request("/webhooks/paycrest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paycrest-signature": signPaycrestBody(body),
    },
    body,
  });
  expect(response.status).toBe(200);
}

// ── Floats ───────────────────────────────────────────────────────────────

const floatsPath = (company: TestCompany) =>
  `/organizations/${company.organizationId}/floats`;

/** An employee with a confirmed M-Pesa number, holding a paid float. */
async function floatHolder(
  setUp: Company,
  amountKes = "1,000",
): Promise<{ readonly holder: TestUser; readonly floatId: string }> {
  const { company } = setUp;
  const holder = await createUser(db);
  const membershipId = await addMember(db, company, holder);
  await makePayable(db, holder, "Jane Wanjiku");
  const issue = await challengeOf(
    await sendJson(app, floatsPath(company), company.admin, {
      method: "POST",
      body: { membershipId, amountKes },
    }),
    floatApprovalSchema,
  );
  await payFloatMovement(setUp, issue);
  return { holder, floatId: issue.preview.float.id };
}

async function payFloatMovement(
  setUp: Company,
  approval: Challenge<{
    readonly challengeId: string;
    readonly payment: { readonly payoutId: string };
  }>,
): Promise<void> {
  await confirm(setUp, `${floatsPath(setUp.company)}/approval`, approval);
  await settle(
    await readPayout(db, setUp.company, approval.preview.payment.payoutId),
  );
}

async function topUpFloat(setUp: Company, floatId: string): Promise<void> {
  const topUp = await challengeOf(
    await sendJson(
      app,
      `${floatsPath(setUp.company)}/${floatId}/top-ups`,
      setUp.company.admin,
      { method: "POST", body: { amountKes: "500" } },
    ),
    floatApprovalSchema,
  );
  await payFloatMovement(setUp, topUp);
}

async function spendFromFloat(
  { company, officeId }: Company,
  holder: TestUser,
  floatId: string,
  amountKes = "300",
) {
  const receipt = await uploadReceipt(app, storage, company, holder);
  const response = await sendJson(
    app,
    `${floatsPath(company)}/${floatId}/spending`,
    holder,
    {
      method: "POST",
      body: {
        merchant: "Naivas Supermarket",
        amountKes,
        spentOn: "2026-10-15",
        categoryId: officeId,
        description: "Printer paper",
        receiptFileIds: [receipt.receiptFileId],
      },
    },
  );
  expect(response.status).toBe(201);
  return {
    result: floatSpendingResultSchema.parse(await dataOf(response)),
    storageKey: receipt.storageKey,
  };
}

// ── Company spending ─────────────────────────────────────────────────────

async function recordCompanySpending(
  { company, officeId }: Company,
  paidFromAccountId: string,
): Promise<{ readonly id: string; readonly storageKey: string }> {
  const receipt = await uploadReceipt(app, storage, company, company.admin);
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/company-spending`,
    company.admin,
    {
      method: "POST",
      body: {
        merchant: "Kenya Power",
        amountKes: "4,500.00",
        spentOn: "2026-10-15",
        categoryId: officeId,
        description: "October electricity",
        paidFromAccountId,
        mpesaCode: "SKL3ABCDEF",
        receiptFileIds: [receipt.receiptFileId],
      },
    },
  );
  expect(response.status).toBe(201);
  const { id } = companySpendingDetailSchema.parse(await dataOf(response));
  return { id, storageKey: receipt.storageKey };
}

// ── Bills ────────────────────────────────────────────────────────────────

let tills = 300_000;

async function tillBill(
  { company, officeId }: Company,
  amountKes = 250_000n,
): Promise<string> {
  tills += 1;
  const payeeId = await insertPayee(db, company, {
    name: "Kenya Power",
    method: "mpesa_till",
    tillNumber: String(tills),
    accountName: "Kenya Power",
    detailsChangedAt: OLD_CHANGE,
  });
  return insertBill(db, company, {
    payeeId,
    categoryId: officeId,
    amountKes,
    reference: "INV-0042",
    dueOn: nairobiDate(new Date()),
    status: "due",
  });
}

/** A file on the bill, straight to the table, with its bytes in storage. */
async function attachBillFile(
  company: TestCompany,
  billId: string,
  role: "invoice" | "proof",
  contentType: "application/pdf" | "image/jpeg",
): Promise<Uint8Array> {
  const bytes = new Uint8Array([role === "invoice" ? 1 : 2, 3, 5, 8]);
  const storageKey = `org/${company.organizationId}/receipts/${randomUUID()}`;
  storage.state.put(storageKey, bytes.byteLength, contentType, bytes);
  await runInScope(db, asAdmin(company), (tx) =>
    tx.insert(receiptFiles).values({
      organizationId: company.organizationId,
      billId,
      billRole: role,
      uploadedBy: company.admin.id,
      storageKey,
      kind: contentType === "application/pdf" ? "pdf" : "photo",
      sha256: randomSha256(),
      contentType,
      byteSize: bytes.byteLength,
    }),
  );
  return bytes;
}

const billsPath = (company: TestCompany) =>
  `/organizations/${company.organizationId}/bills`;

/** Approve & pay through Expendi; returns the bill's payout. */
async function payBill(setUp: Company, billId: string): Promise<Payout> {
  const payment = await challengeOf(
    await sendJson(
      app,
      `${billsPath(setUp.company)}/payment`,
      setUp.company.admin,
      {
        method: "POST",
        body: { billIds: [billId] },
      },
    ),
    billPaymentSchema,
  );
  await confirm(setUp, `${billsPath(setUp.company)}/payment`, payment);
  return readPayout(
    db,
    setUp.company,
    payment.preview.bills[0]?.payoutId ?? "",
  );
}

function markPaidOutside(
  { company }: Company,
  billId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return sendJson(
    app,
    `${billsPath(company)}/${billId}/mark-paid-outside`,
    company.admin,
    { method: "POST", body: { paidOn: nairobiDate(new Date()), ...body } },
  );
}

// ── Payroll ──────────────────────────────────────────────────────────────

const PEOPLE = [
  ["Amina Wanjiru", 3_000_000n],
  ["Brian Otieno", 2_000_000n],
] as const;

/** Amina and Brian on payroll, the 28 Nov run drafted. */
async function draftedRun(setUp: Company): Promise<string> {
  const { company, officeId } = setUp;
  for (const [name, amountKes] of PEOPLE) {
    const payeeId = await insertPersonnelPayee(db, company, name);
    await insertSalary(db, company, {
      payeeId,
      categoryId: officeId,
      amountKes,
    });
  }
  await runtime.runPromise(draftDuePayroll(company.organizationId, NOV_23_EAT));
  const [run] = await runsOf(db, company);
  if (!run) throw new Error("no run drafted");
  return run.id;
}

const runPath = (company: TestCompany, runId: string) =>
  `/organizations/${company.organizationId}/payroll-runs/${runId}`;

/** Approve & pay all; returns each person's payout, by amount. */
async function payRun(setUp: Company, runId: string): Promise<Payout[]> {
  const path = runPath(setUp.company, runId);
  const payment = await challengeOf(
    await sendJson(app, `${path}/payment`, setUp.company.admin, {
      method: "POST",
    }),
    payrollRunPaymentSchema,
  );
  await confirm(setUp, `${path}/payment`, payment);
  const runBills = await billsOfRun(db, setUp.company, runId);
  return runInScope(db, asAdmin(setUp.company), (tx) =>
    tx
      .select()
      .from(payouts)
      .where(
        and(eq(payouts.payrollRunId, runId), eq(payouts.subjectType, "bill")),
      )
      .orderBy(asc(payouts.amountKes)),
  ).then((rows) =>
    rows.filter((row) => runBills.some((bill) => bill.id === row.subjectId)),
  );
}

// ═════════════════════════════════════════════════════════════════════════

describe("petty cash spending in Zoho Books", () => {
  it("is queued as it's recorded and posted through the petty cash account", async () => {
    // #given
    const setUp = await connected();
    const { holder, floatId } = await floatHolder(setUp);
    const { result, storageKey } = await spendFromFloat(setUp, holder, floatId);
    const spendingId = result.spending?.id ?? "";
    const receiptBytes = new Uint8Array([0xff, 0xd8, 0xff, 9]);
    storage.state.put(
      storageKey,
      receiptBytes.byteLength,
      "image/jpeg",
      receiptBytes,
    );

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(
      zoho.state.expenses.map(({ organizationId, draft, receipt }) => ({
        organizationId,
        draft,
        receipt: receipt?.fileName,
      })),
    ).toEqual([
      {
        organizationId: ZOHO_KES_ORGANIZATION,
        draft: {
          accountId: "acc-travel",
          paidThroughAccountId: "acc-petty",
          date: "2026-10-15",
          amount: "300.00",
          referenceNumber: spendingId,
          description: "Naivas Supermarket · Printer paper · Jane Wanjiku",
        },
        receipt: `expendi-${spendingId}.jpg`,
      },
    ]);
  });

  it("queues the spending in the transaction that records it", async () => {
    // #given
    const setUp = await connected();
    const { holder, floatId } = await floatHolder(setUp);

    // #when
    const { result } = await spendFromFloat(setUp, holder, floatId);

    // #then
    const sync = await onlySync(setUp.company);
    expect(sync).toMatchObject({
      subjectType: "expense",
      subjectId: result.spending?.id,
      status: "pending",
    });
    // now() is the transaction's start: equal only in one transaction.
    expect(sync.createdAt).toEqual(
      await expenseCreatedAt(setUp.company, result.spending?.id ?? ""),
    );
  });

  it("posts the part over the float through petty cash, and the claim for the extra once it's paid, through the wallet", async () => {
    // #given KES 1,000 on the float, a KES 1,200 purchase
    const setUp = await connected();
    const { holder, floatId } = await floatHolder(setUp);
    const { result } = await spendFromFloat(setUp, holder, floatId, "1,200");
    const floatPartId = result.spending?.id ?? "";
    const claimId = result.overspendClaim?.id ?? "";

    // #when the claim is paid, then the job runs
    await claimFlow({ app, db, storage, paycrest }, setUp.paying).pay(claimId);
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced", "synced"]);
    expect(
      [floatPartId, claimId].map((id) =>
        postedTo(id).map(({ draft }) => [
          draft.paidThroughAccountId,
          draft.amount,
        ]),
      ),
    ).toEqual([[["acc-petty", "1000.00"]], [["acc-wallet", "200.00"]]]);
  });

  it("waits for the petty cash account to be chosen", async () => {
    // #given
    const setUp = await setUpCompany();
    await connectZoho(app, opsAdmin, setUp.company, {
      ...setUp.mapping,
      pettyCashAccountId: null,
    });
    const { holder, floatId } = await floatHolder(setUp);
    await spendFromFloat(setUp, holder, floatId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["deferred"]);
    expect(zoho.state.expenses).toEqual([]);
    expect((await onlySync(setUp.company)).lastError).toBe(
      "Choose the petty cash account in the Zoho mapping.",
    );
  });
});

describe("company spending in Zoho Books", () => {
  it("is posted through the account it was paid from, as mapped", async () => {
    // #given
    const setUp = await connected();
    const { id } = await recordCompanySpending(setUp, setUp.kcbId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      {
        accountId: "acc-travel",
        paidThroughAccountId: "acc-kcb",
        date: "2026-10-15",
        amount: "4500.00",
        referenceNumber: id,
        description: "Kenya Power · October electricity · M-Pesa SKL3ABCDEF",
      },
    ]);
    expect(await onlySync(setUp.company)).toMatchObject({
      receiptAttached: true,
    });
  });

  it("queues the spending in the transaction that records it", async () => {
    // #given
    const setUp = await connected();

    // #when
    const { id } = await recordCompanySpending(setUp, setUp.kcbId);

    // #then
    const sync = await onlySync(setUp.company);
    expect(sync).toMatchObject({ subjectType: "expense", subjectId: id });
    expect(sync.createdAt).toEqual(await expenseCreatedAt(setUp.company, id));
  });

  it("waits, naming the account, while its paid-from account isn't mapped", async () => {
    // #given
    const setUp = await connected();
    await recordCompanySpending(setUp, setUp.cardId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["deferred"]);
    expect(zoho.state.expenses).toEqual([]);
    expect((await onlySync(setUp.company)).lastError).toBe(
      `Map the paid-from account "Founder's Visa" to a Zoho Paid Through account.`,
    );
  });
});

describe("bills in Zoho Books", () => {
  it("posts a bill paid through Expendi through the wallet's account, with its invoice", async () => {
    // #given
    const setUp = await connected();
    const billId = await tillBill(setUp);
    await attachBillFile(setUp.company, billId, "proof", "image/jpeg");
    const invoice = await attachBillFile(
      setUp.company,
      billId,
      "invoice",
      "application/pdf",
    );
    await settle(await payBill(setUp, billId));
    const { paidOn } = await readBill(db, setUp.company, billId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(
      zoho.state.expenses.map(({ draft, receipt }) => ({ draft, receipt })),
    ).toEqual([
      {
        draft: {
          accountId: "acc-travel",
          paidThroughAccountId: "acc-wallet",
          date: paidOn,
          amount: "2500.00",
          referenceNumber: billId,
          description: "Kenya Power · Ref INV-0042 · Paid SKL3ABCDEF",
        },
        receipt: {
          bytes: invoice,
          contentType: "application/pdf",
          fileName: `expendi-${billId}.pdf`,
        },
      },
    ]);
  });

  it("posts a bill paid through Pretium with Pretium's receipt and no fee line", async () => {
    // #given a paid cash-out that Pretium paid, as Pretium leaves it
    const setUp = await connected();
    const billId = await tillBill(setUp);
    const payout = await payBill(setUp, billId);
    await settle(payout);
    await updatePayout(db, setUp.company, payout.id, {
      provider: "pretium",
      providerOrderId: `TX${randomUUID().slice(0, 8).toUpperCase()}`,
      providerStatus: "COMPLETE",
      providerReference: "TKP9PRETIUM",
      gatewayOrderId: null,
      feeUsdc: 0n,
    });
    const { paidOn } = await readBill(db, setUp.company, billId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      {
        accountId: "acc-travel",
        paidThroughAccountId: "acc-wallet",
        date: paidOn,
        amount: "2500.00",
        referenceNumber: billId,
        description: "Kenya Power · Ref INV-0042 · Paid TKP9PRETIUM",
      },
    ]);
  });

  it("queues a bill in the same change that marks it paid", async () => {
    // #given
    const setUp = await connected();
    const billId = await tillBill(setUp);
    const payout = await payBill(setUp, billId);

    // #when
    const exit = await runtime.runPromiseExit(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        applyPayoutOutcome(tx, {
          ...payout,
          status: "paid",
          paidAt: new Date(),
        }).pipe(Effect.zipRight(Effect.fail("payout write failed"))),
      ),
    );

    // #then
    expect(exit._tag).toBe("Failure");
    expect(await syncsOf(setUp.company)).toEqual([]);
    expect((await readBill(db, setUp.company, billId)).status).toBe("paying");
    await settle(payout);
    expect(await onlySync(setUp.company)).toMatchObject({
      subjectType: "bill",
      subjectId: billId,
    });
  });

  it("posts a USD bill at the KES its payment was worth", async () => {
    // #given USD 25 to an allowlisted NEAR account
    const setUp = await connected("near");
    const address = registeredNearAccount(near);
    await allowlistAddress(runtime, setUp.paying, address, "Vercel", "near");
    const payeeId = await insertPayee(db, setUp.company, {
      name: "Vercel Inc",
      method: "usdc",
      usdcChain: "near",
      usdcAddress: address,
      detailsChangedAt: OLD_CHANGE,
    });
    const billId = await insertBill(db, setUp.company, {
      payeeId,
      categoryId: setUp.officeId,
      currency: "usd",
      amountKes: null,
      amountUsdc: 25n * USDC,
      dueOn: nairobiDate(new Date()),
      status: "due",
    });
    const payout = await payBill(setUp, billId);
    if (!payout.txHash) throw new Error("no hash");
    await followPayout(runtime, payout);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(kesCentsFor(25n * USDC, "128.68")).toBe(payout.amountKes);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      expect.objectContaining({
        paidThroughAccountId: "acc-wallet",
        amount: kesDecimal(payout.amountKes),
        description: "Vercel Inc · USD 25.00",
      }),
    ]);
  });

  it("posts a bill paid outside once, as the bill, through the account it was paid from", async () => {
    // #given
    const setUp = await connected();
    const billId = await tillBill(setUp, 1_299_900n);

    // #when
    const response = await markPaidOutside(setUp, billId, {
      paidFromAccountId: setUp.kcbId,
      note: "Paid by bank transfer",
    });
    const outcomes = await runSync(setUp.company);

    // #then
    expect(response.status).toBe(200);
    expect(outcomes).toEqual(["synced"]);
    expect(
      (await syncsOf(setUp.company)).map(({ subjectType, subjectId }) => [
        subjectType,
        subjectId,
      ]),
    ).toEqual([["bill", billId]]);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      {
        accountId: "acc-travel",
        paidThroughAccountId: "acc-kcb",
        date: nairobiDate(new Date()),
        amount: "12999.00",
        referenceNumber: billId,
        description: "Kenya Power · Paid by bank transfer · Ref INV-0042",
      },
    ]);
  });

  it("never queues a paid-outside bill's company spending entry on its own", async () => {
    // #given
    const setUp = await connected();
    const billId = await tillBill(setUp);
    await markPaidOutside(setUp, billId, { paidFromAccountId: setUp.kcbId });
    const [spending] = await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx
          .select({ id: expenses.id })
          .from(expenses)
          .where(eq(expenses.billId, billId)),
    );

    // #when
    await runtime.runPromise(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        enqueueRecordedSpending(
          tx,
          setUp.company.organizationId,
          spending?.id ?? "",
        ),
      ),
    );

    // #then
    expect(
      (await syncsOf(setUp.company)).map(({ subjectType }) => subjectType),
    ).toEqual(["bill"]);
  });

  it("waits for the account a bill paid outside came from", async () => {
    // #given
    const setUp = await connected();
    const billId = await tillBill(setUp);
    await markPaidOutside(setUp, billId, {});

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["deferred"]);
    expect(zoho.state.expenses).toEqual([]);
    expect((await onlySync(setUp.company)).lastError).toContain(
      "without saying which account paid it",
    );
  });

  it("posts a bill paid by a company-held card once, as the bill, from its spending row", async () => {
    // #given a USD 21.50 Card purchase paid the bill, recorded at KES 2,770
    const setUp = await connected();
    const { company, officeId } = setUp;
    const { cardId } = await addCompanyHeldCard(db, company, {
      defaultCategoryId: officeId,
    });
    const payeeId = await insertPayee(db, company, { name: "Anthropic" });
    const itemId = await insertRecurringItem(db, company, {
      payeeId,
      categoryId: officeId,
      currency: "usd",
      amountKes: null,
      amountUsdc: 20n * USDC,
      payVia: "card",
      cardId,
    });
    const today = nairobiDate(new Date());
    const { billId, spendingId } = await runInScope(
      db,
      asAdmin(company),
      async (tx) => {
        const [purchase] = await tx
          .insert(cardPurchases)
          .values({
            organizationId: company.organizationId,
            cardId,
            lithicTransactionToken: randomUUID(),
            status: "settled",
            merchant: "ANTHROPIC",
            mcc: "5734",
            settledUsdCents: 2_150n,
            authorizedAt: new Date(),
            categoryId: officeId,
            recurringItemId: itemId,
          })
          .returning({ id: cardPurchases.id });
        if (!purchase) throw new Error("purchase insert returned no row");
        const [bill] = await tx
          .insert(bills)
          .values({
            organizationId: company.organizationId,
            payeeId,
            recurringItemId: itemId,
            overviewHeading: "subscriptions",
            categoryId: officeId,
            currency: "usd",
            amountUsdc: 21_500_000n,
            dueOn: today,
            status: "paid_by_card",
            paidOn: today,
            paidAt: new Date(),
            cardPurchaseId: purchase.id,
          })
          .returning({ id: bills.id });
        if (!bill) throw new Error("bill insert returned no row");
        const [spending] = await tx
          .insert(expenses)
          .values({
            organizationId: company.organizationId,
            membershipId: company.adminMembershipId,
            kind: "card",
            status: "recorded",
            overviewHeading: "subscriptions",
            paidFromAccountId: setUp.kcbId,
            billId: bill.id,
            categoryId: officeId,
            merchant: "ANTHROPIC",
            amountKes: 277_000n,
            spentOn: today,
          })
          .returning({ id: expenses.id });
        if (!spending) throw new Error("spending insert returned no row");
        return { billId: bill.id, spendingId: spending.id };
      },
    );

    // #when
    await runtime.runPromise(
      withScope(asAdmin(company), (tx) =>
        Effect.zipRight(
          enqueueRecordedSpending(tx, company.organizationId, spendingId),
          enqueuePaidBill(tx, company.organizationId, billId),
        ),
      ),
    );
    const outcomes = await runSync(company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(
      (await syncsOf(company)).map(({ subjectType, subjectId }) => [
        subjectType,
        subjectId,
      ]),
    ).toEqual([["bill", billId]]);
    expect(zoho.state.expenses.map(({ draft }) => draft)).toEqual([
      {
        accountId: "acc-travel",
        paidThroughAccountId: "acc-kcb",
        date: today,
        amount: "2770.00",
        referenceNumber: billId,
        description: "Anthropic · USD 21.50",
      },
    ]);
  });

  it("never queues a bill that isn't paid, or a salary payment", async () => {
    // #given
    const setUp = await connected();
    const unpaid = await tillBill(setUp);
    const runId = await draftedRun(setUp);
    const [salary] = await billsOfRun(db, setUp.company, runId);
    await runInScope(db, asAdmin(setUp.company), (tx) =>
      tx
        .update(bills)
        .set({
          status: "paid_outside",
          paidOn: "2026-11-28",
          paidAt: new Date(),
          markedPaidBy: setUp.company.admin.id,
        })
        .where(eq(bills.id, salary?.id ?? "")),
    );

    // #when
    await runtime.runPromise(
      withScope(asAdmin(setUp.company), (tx) =>
        Effect.forEach([unpaid, salary?.id ?? ""], (billId) =>
          enqueuePaidBill(tx, setUp.company.organizationId, billId),
        ),
      ),
    );

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });
});

describe("payroll runs in Zoho Books", () => {
  it("posts a paid run as one expense for its total, to the salaries account, with no names or per-person amounts", async () => {
    // #given
    const setUp = await connected();
    const runId = await draftedRun(setUp);
    const runPayouts = await payRun(setUp, runId);
    for (const payout of runPayouts) await settle(payout);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(
      (await syncsOf(setUp.company)).map(({ subjectType, subjectId }) => [
        subjectType,
        subjectId,
      ]),
    ).toEqual([["payroll_run", runId]]);
    expect(
      zoho.state.expenses.map(({ draft, receipt }) => ({ draft, receipt })),
    ).toEqual([
      {
        draft: {
          accountId: "acc-salaries",
          paidThroughAccountId: "acc-wallet",
          date: "2026-11-28",
          amount: "50000.00",
          referenceNumber: runId,
          description: "Salaries · payroll run for 2026-11-28",
        },
        receipt: null,
      },
    ]);
  });

  it("queues nothing while anyone in the run is unpaid", async () => {
    // #given
    const setUp = await connected();
    const runId = await draftedRun(setUp);
    const [brian, amina] = await payRun(setUp, runId);
    if (!brian || !amina) throw new Error("expected two payouts");

    // #when
    await settle(amina);
    await settle(brian, "refunded");

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });

  it("queues the run in the same change that pays its last person", async () => {
    // #given
    const setUp = await connected();
    const runId = await draftedRun(setUp);
    const [first, last] = await payRun(setUp, runId);
    if (!first || !last) throw new Error("expected two payouts");
    await settle(first);
    const lastPayout = await readPayout(db, setUp.company, last.id);

    // #when
    const exit = await runtime.runPromiseExit(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        applyPayoutOutcome(tx, {
          ...lastPayout,
          status: "paid",
          paidAt: new Date(),
        }).pipe(Effect.zipRight(Effect.fail("payout write failed"))),
      ),
    );

    // #then
    expect(exit._tag).toBe("Failure");
    expect(await syncsOf(setUp.company)).toEqual([]);
    await settle(lastPayout);
    expect(await onlySync(setUp.company)).toMatchObject({
      subjectType: "payroll_run",
      subjectId: runId,
    });
  });
});

describe("what never syncs", () => {
  it("never queues a float's issue or top-up", async () => {
    // #given
    const setUp = await connected();

    // #when
    const { floatId } = await floatHolder(setUp);
    await topUpFloat(setUp, floatId);

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });

  it("never queues or posts imported history", async () => {
    // #given
    const setUp = await connected();
    const importedIds = [randomUUID(), randomUUID()];
    await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx.insert(expenses).values([
          {
            id: importedIds[0],
            organizationId: setUp.company.organizationId,
            membershipId: setUp.company.adminMembershipId,
            categoryId: setUp.officeId,
            kind: "claim",
            status: "paid_outside",
            source: "import",
            merchant: "Imported lunch",
            amountKes: 50_000n,
            spentOn: "2026-08-01",
            overviewHeading: "petty_cash",
          },
          {
            id: importedIds[1],
            organizationId: setUp.company.organizationId,
            membershipId: setUp.company.adminMembershipId,
            categoryId: setUp.officeId,
            kind: "company",
            status: "recorded",
            source: "import",
            merchant: "Imported rent",
            amountKes: 9_000_000n,
            spentOn: "2026-08-01",
            overviewHeading: "transactions",
            paidFromAccountId: setUp.kcbId,
          },
        ]),
    );

    // #when
    await runtime.runPromise(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        Effect.forEach(importedIds, (id) =>
          Effect.zipRight(
            enqueuePaidClaim(tx, setUp.company.organizationId, id),
            enqueueRecordedSpending(tx, setUp.company.organizationId, id),
          ),
        ),
      ),
    );
    const queuedBeforeForcing = await syncsOf(setUp.company);
    await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx.insert(accountingSyncs).values(
          importedIds.map((subjectId) => ({
            organizationId: setUp.company.organizationId,
            subjectType: "expense" as const,
            subjectId,
          })),
        ),
    );
    const outcomes = await runSync(setUp.company);

    // #then
    expect(queuedBeforeForcing).toEqual([]);
    expect(outcomes).toEqual(["failed", "failed"]);
    expect(zoho.state.searches).toEqual([]);
    expect(zoho.state.expenses).toEqual([]);
  });

  it("queues nothing for a company without a Zoho connection", async () => {
    // #given
    const setUp = await setUpCompany();
    const billId = await tillBill(setUp);

    // #when
    await recordCompanySpending(setUp, setUp.kcbId);
    await markPaidOutside(setUp, billId, { paidFromAccountId: setUp.kcbId });

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });
});

describe("the T44 account mapping", () => {
  async function organizationChosen(): Promise<Company> {
    const setUp = await setUpCompany();
    await signInToZoho(app, opsAdmin, setUp.company);
    const chosen = await staffRequest(
      app,
      opsAdmin,
      "POST",
      zohoStaffPath(setUp.company, "/organization"),
      { externalOrganizationId: ZOHO_KES_ORGANIZATION },
    );
    expect(chosen.status).toBe(200);
    return setUp;
  }

  const putMapping = (company: TestCompany, mapping: unknown) =>
    staffRequest(
      app,
      opsAdmin,
      "PUT",
      zohoStaffPath(company, "/mapping"),
      mapping,
    );

  async function auditedMapping(company: TestCompany) {
    const { rows } = await owner.query<{
      after: Record<string, unknown>;
    }>(
      `SELECT after FROM audit_log
       WHERE organization_id = $1 AND action = 'accounting_connection.mapping_changed'
       ORDER BY occurred_at`,
      [company.organizationId],
    );
    return rows.map(({ after }) => after);
  }

  it("saves the petty cash, salaries and paid-from accounts, audited", async () => {
    // #given
    const setUp = await organizationChosen();

    // #when
    const reply = await putMapping(setUp.company, setUp.mapping);

    // #then
    expect(reply.status).toBe(200);
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        pettyCashAccountId: "acc-petty",
        salariesAccountId: "acc-salaries",
        paidFromAccounts: [
          {
            paidFromAccountId: setUp.cardId,
            name: "Founder's Visa",
            kind: "card",
            accountId: null,
          },
          {
            paidFromAccountId: setUp.kcbId,
            name: "KCB current account",
            kind: "bank",
            accountId: "acc-kcb",
          },
        ],
      },
    );
    expect(await auditedMapping(setUp.company)).toEqual([
      expect.objectContaining({
        pettyCashAccountId: "acc-petty",
        salariesAccountId: "acc-salaries",
        paidFromAccounts: { [setUp.kcbId]: "acc-kcb", [setUp.cardId]: null },
      }),
    ]);
  });

  it("keeps them when a mapping leaves them out", async () => {
    // #given
    const setUp = await organizationChosen();
    await putMapping(setUp.company, setUp.mapping);

    // #when
    const reply = await putMapping(setUp.company, {
      categoryAccounts: {},
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    });

    // #then
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        pettyCashAccountId: "acc-petty",
        salariesAccountId: "acc-salaries",
        paidFromAccounts: [
          expect.objectContaining({ accountId: null }),
          expect.objectContaining({ accountId: "acc-kcb" }),
        ],
      },
    );
  });

  it.each<[string, (setUp: Company) => Partial<ZohoMapping>]>([
    [
      "an expense account for petty cash",
      () => ({ pettyCashAccountId: "acc-travel" }),
    ],
    [
      "a bank account for salaries",
      () => ({ salariesAccountId: "acc-wallet" }),
    ],
    [
      "a paid-from account mapped to an expense account",
      ({ kcbId }) => ({ paidFromAccounts: { [kcbId]: "acc-travel" } }),
    ],
    [
      "a paid-from account that isn't the company's",
      () => ({ paidFromAccounts: { [randomUUID()]: "acc-kcb" } }),
    ],
  ])("refuses %s and saves nothing", async (_label, change) => {
    // #given
    const setUp = await organizationChosen();

    // #when
    const reply = await putMapping(setUp.company, {
      ...setUp.mapping,
      ...change(setUp),
    });

    // #then
    expect(reply.status).toBe(400);
    const status = await staffRequest(
      app,
      opsAdmin,
      "GET",
      zohoStaffPath(setUp.company),
    );
    expect(
      zohoStatusResponseSchema.parse(status.data).connection,
    ).toMatchObject({
      pettyCashAccountId: null,
      salariesAccountId: null,
      paidFromAccounts: [
        expect.objectContaining({ accountId: null }),
        expect.objectContaining({ accountId: null }),
      ],
    });
  });

  it("clears them when staff switch to another organization", async () => {
    // #given
    const setUp = await organizationChosen();
    await putMapping(setUp.company, setUp.mapping);
    zoho.state.organizations.push({
      id: "60003",
      name: "Acme Branch Ltd",
      currencyCode: "KES",
    });

    // #when
    const reply = await staffRequest(
      app,
      opsAdmin,
      "POST",
      zohoStaffPath(setUp.company, "/organization"),
      { externalOrganizationId: "60003" },
    );

    // #then
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        pettyCashAccountId: null,
        salariesAccountId: null,
        paidFromAccounts: [
          expect.objectContaining({ accountId: null }),
          expect.objectContaining({ accountId: null }),
        ],
      },
    );
  });
});

describe("the staff sync list", () => {
  it("names spending by kind, and shows no detail of bills to staff", async () => {
    // #given
    const setUp = await connected();
    const { holder, floatId } = await floatHolder(setUp);
    await spendFromFloat(setUp, holder, floatId);
    await markPaidOutside(setUp, await tillBill(setUp), {
      paidFromAccountId: setUp.kcbId,
    });

    // #when
    const reply = await staffRequest(
      app,
      opsAdmin,
      "GET",
      zohoStaffPath(setUp.company, "/syncs?status=pending"),
    );

    // #then
    const listed = accountingSyncsResponseSchema.parse(reply.data);
    expect(
      listed.syncs
        .map(({ subjectType, subject }) => [
          subjectType,
          subject?.expenseKind ?? null,
        ])
        .sort(),
    ).toEqual([
      ["bill", null],
      ["expense", "float"],
    ]);
  });
});
