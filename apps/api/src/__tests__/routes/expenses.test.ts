import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  Expense,
  ExpenseDetail,
  ExpenseListKind,
  ExpensesPage,
  ExpensesSummary,
  FloatApproval,
} from "@expendi-business/shared";
import {
  expenseDetailSchema,
  expensesPageSchema,
  expensesSummarySchema,
  floatApprovalSchema,
  floatSpendingResultSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NewExpense } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  expenses,
  floats,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import {
  addCategory,
  randomSha256,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
  signPaycrestBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import { expectRouteIsolation } from "../helpers/isolation.js";
import { createPayingCompany, readPayout } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;

let paying: PayingCompany;
let employee: TestUser;
let employeeMembershipId: string;
let accountant: TestUser;
let officeId: string;
let mealsId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    fileStorage: storage.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  openFloats.clear();
  paying = await createPayingCompany(runtime, db);
  officeId = await addCategory(db, company(), "Office supplies");
  mealsId = await addCategory(db, company(), "Meals");
  employee = await createUser(db);
  employeeMembershipId = await addMember(db, company(), employee);
  await db
    .update(users)
    .set({
      phone: `+2547${randomInt(10_000_000, 100_000_000)}`,
      phoneVerifiedAt: new Date(),
      fullName: "Jane Wanjiku",
    })
    .where(eq(users.id, employee.id));
  accountant = await createUser(db);
  await addMember(db, company(), accountant, { role: "accountant" });
});

const company = (): TestCompany => paying.company;
const admin = (): TestUser => paying.company.admin;
const companyPath = (rest = "", target: TestCompany = company()) =>
  `/organizations/${target.organizationId}${rest}`;

async function dataOf(response: Response): Promise<unknown> {
  expect(response.status, await response.clone().text()).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

function read(rest: string, user: TestUser = admin()): Promise<Response> {
  return sendJson(app, companyPath(`/expenses${rest}`), user);
}

async function listed(
  query = "",
  user: TestUser = admin(),
): Promise<ExpensesPage> {
  return expensesPageSchema.parse(await dataOf(await read(query, user)));
}

async function idsListed(query = ""): Promise<string[]> {
  return (await listed(query)).expenses.map((expense) => expense.id).sort();
}

async function detail(
  expenseId: string,
  user: TestUser = admin(),
): Promise<ExpenseDetail> {
  return expenseDetailSchema.parse(
    await dataOf(await read(`/${expenseId}`, user)),
  );
}

const asAdmin = (target: TestCompany = company()) => ({
  organizationId: target.organizationId,
  userId: target.admin.id,
  role: "admin" as const,
});

/** Each person holds at most one open float, so tests share it. */
const openFloats = new Map<string, string>();

async function openFloat(membershipId = employeeMembershipId): Promise<string> {
  const open = openFloats.get(membershipId);
  if (open) return open;
  const [float] = await runInScope(db, asAdmin(), (tx) =>
    tx
      .insert(floats)
      .values({ organizationId: company().organizationId, membershipId })
      .returning({ id: floats.id }),
  );
  if (!float) throw new Error("float insert returned no row");
  openFloats.set(membershipId, float.id);
  return float.id;
}

type Seeded = "claim" | "float" | "overspend" | "company";

/** An expense written straight to the table, as each kind is stored. */
async function seed(
  shape: Seeded,
  values: Partial<NewExpense> = {},
  target: TestCompany = company(),
): Promise<string> {
  const floatId =
    shape === "float" || shape === "overspend"
      ? (values.floatId ?? (await openFloat()))
      : null;
  const [row] = await runInScope(db, asAdmin(target), (tx) =>
    tx
      .insert(expenses)
      .values({
        organizationId: target.organizationId,
        membershipId:
          target === company()
            ? employeeMembershipId
            : target.adminMembershipId,
        kind: shape === "overspend" ? "claim" : shape,
        overviewHeading: shape === "company" ? "transactions" : "petty_cash",
        categoryId: officeId,
        merchant: `${shape} purchase`,
        amountKes: 123_456n,
        spentOn: "2026-10-15",
        description: "For the office",
        status:
          shape === "claim" || shape === "overspend" ? "submitted" : "recorded",
        floatId,
        ...values,
      })
      .returning({ id: expenses.id }),
  );
  if (!row) throw new Error("expense insert returned no row");
  return row.id;
}

async function attachPhoto(expenseId: string, uploader = employee) {
  const key = `org/${company().organizationId}/receipts/${randomUUID()}.jpg`;
  const [file] = await runInScope(db, asAdmin(), (tx) =>
    tx
      .insert(receiptFiles)
      .values({
        organizationId: company().organizationId,
        expenseId,
        uploadedBy: uploader.id,
        kind: "photo",
        storageKey: key,
        sha256: randomSha256(),
        byteSize: 180_000,
        contentType: "image/jpeg",
      })
      .returning({ id: receiptFiles.id }),
  );
  if (!file) throw new Error("receipt insert returned no row");
  return { id: file.id, key };
}

// ── The real float flow: issued and topped up through payouts, then spent ──

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

async function payFloatMovement(response: Response): Promise<FloatApproval> {
  expect(response.status, await response.clone().text()).toBe(201);
  const body = (await response.json()) as { data: { options: SignOptions } };
  const approval = floatApprovalSchema.parse(body.data);
  const confirmed = await sendJson(
    app,
    companyPath(`/floats/approval/${approval.challengeId}/confirm`),
    admin(),
    {
      method: "POST",
      body: {
        response: paying.passkey.sign(body.data.options, TEST_ORIGIN),
      },
    },
  );
  expect(confirmed.status, await confirmed.clone().text()).toBe(200);
  const payout = await readPayout(db, company(), approval.payment.payoutId);
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no Paycrest order for the float payout");
  paycrest.state.orders.set(order.id, {
    ...order,
    status: "settled",
    paymentReference: "SKL3ABCDEF",
  });
  const webhook = JSON.stringify({
    event: "payment_order.settled",
    webhookVersion: "1",
    data: { id: payout.providerOrderId, status: "settled" },
  });
  const settled = await app.request("/webhooks/paycrest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paycrest-signature": signPaycrestBody(webhook),
    },
    body: webhook,
  });
  expect(settled.status).toBe(200);
  return approval;
}

async function spendFromFloat(floatId: string, amountKes: string) {
  const photo = await uploadReceipt(app, storage, company(), employee);
  const response = await sendJson(
    app,
    companyPath(`/floats/${floatId}/spending`),
    employee,
    {
      method: "POST",
      body: {
        merchant: "Naivas Supermarket",
        amountKes,
        spentOn: "2026-10-15",
        categoryId: officeId,
        description: "Printer paper",
        receiptFileIds: [photo.receiptFileId],
      },
    },
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return floatSpendingResultSchema.parse(
    ((await response.json()) as { data: unknown }).data,
  );
}

describe("GET /organizations/:id/expenses", () => {
  it("lists claims, petty cash and company spending once each, latest purchase first", async () => {
    // #given
    const claim = await seed("claim", { spentOn: "2026-10-03" });
    const spending = await seed("float", { spentOn: "2026-10-20" });
    const overspend = await seed("overspend", { spentOn: "2026-10-12" });
    const recorded = await seed("company", { spentOn: "2026-10-28" });

    // #when
    const page = await listed();

    // #then
    expect(
      page.expenses.map((expense) => [expense.id, expense.listKind]),
    ).toEqual([
      [recorded, "company"],
      [spending, "petty_cash"],
      [overspend, "petty_cash"],
      [claim, "claim"],
    ]);
  });

  it("keeps money in integer cents, as decimal strings", async () => {
    // #given
    await seed("claim", { amountKes: 9_007_199_254_740_993n });

    // #when
    const [expense] = (await listed()).expenses;

    // #then
    expect(expense?.amountKes).toBe("9007199254740993");
  });

  it("counts float spending and overspend claims as petty cash, never the float's issue or top-up", async () => {
    // #given a float issued and topped up through Expendi, then spent past what's left
    const issued = await payFloatMovement(
      await sendJson(app, companyPath("/floats"), admin(), {
        method: "POST",
        body: { membershipId: employeeMembershipId, amountKes: "1,000" },
      }),
    );
    const floatId = issued.float.id;
    await payFloatMovement(
      await sendJson(app, companyPath(`/floats/${floatId}/top-ups`), admin(), {
        method: "POST",
        body: { amountKes: "500" },
      }),
    );
    const first = await spendFromFloat(floatId, "300");
    const second = await spendFromFloat(floatId, "1,500");
    const claim = await seed("claim");
    const recorded = await seed("company");

    // #when
    const pettyCash = (await listed("?kind=petty_cash")).expenses;

    // #then
    expect({
      ids: pettyCash.map((expense) => expense.id).sort(),
      kinds: pettyCash.map((expense) => expense.kind).sort(),
      totalKes: pettyCash
        .reduce((sum, expense) => sum + BigInt(expense.amountKes), 0n)
        .toString(),
      claims: await idsListed("?kind=claim"),
      company: await idsListed("?kind=company"),
    }).toEqual({
      ids: [
        first.spending?.id,
        second.spending?.id,
        second.overspendClaim?.id,
      ].sort(),
      kinds: ["claim", "float", "float"],
      totalKes: "180000",
      claims: [claim],
      company: [recorded],
    });
  });

  it("never lists the company spending a bill marked paid outside records, which still opens by its ID", async () => {
    // #given
    const payeeId = await insertPayee(db, company(), { name: "Safaricom" });
    const billId = await insertBill(db, company(), {
      payeeId,
      categoryId: officeId,
      dueOn: "2026-10-10",
      status: "due",
    });
    const marked = await sendJson(
      app,
      companyPath(`/bills/${billId}/mark-paid-outside`),
      admin(),
      { method: "POST", body: { paidOn: "2026-10-09" } },
    );
    expect(marked.status, await marked.clone().text()).toBe(200);
    const [spending] = await runInScope(db, asAdmin(), (tx) =>
      tx
        .select({ id: expenses.id })
        .from(expenses)
        .where(eq(expenses.billId, billId)),
    );
    const recorded = await seed("company");

    // #when
    const everything = (await listed()).expenses;
    const companyOnly = (await listed("?kind=company")).expenses;
    const opened = await detail(spending?.id ?? "");

    // #then
    expect({
      all: everything.map((expense) => expense.id),
      company: companyOnly.map((expense) => expense.id),
      opened: opened.bill?.id,
    }).toEqual({ all: [recorded], company: [recorded], opened: billId });
  });

  describe("filters", () => {
    const SHAPES: readonly [Seeded, ExpenseListKind][] = [
      ["claim", "claim"],
      ["float", "petty_cash"],
      ["overspend", "petty_cash"],
      ["company", "company"],
    ];

    /** One expense that matches every filter, and one per filter that misses only that one. */
    async function seedMatrix(shape: Seeded) {
      const colleague = await createUser(db);
      const colleagueMembershipId = await addMember(db, company(), colleague);
      const target = await seed(shape, {
        etimsStatus: "attached",
        etimsInvoiceNumber: `INV${randomInt(1_000_000)}`,
      });
      return {
        target,
        otherPerson: await seed(shape, {
          membershipId: colleagueMembershipId,
          etimsStatus: "attached",
          etimsInvoiceNumber: `INV${randomInt(1_000_000)}`,
          ...(shape === "float" || shape === "overspend"
            ? { floatId: await openFloat(colleagueMembershipId) }
            : {}),
        }),
        otherCategory: await seed(shape, {
          categoryId: mealsId,
          etimsStatus: "attached",
          etimsInvoiceNumber: `INV${randomInt(1_000_000)}`,
        }),
        otherMonth: await seed(shape, {
          spentOn: "2026-09-30",
          etimsStatus: "attached",
          etimsInvoiceNumber: `INV${randomInt(1_000_000)}`,
        }),
        otherEtims: await seed(shape, { etimsStatus: "none" }),
      };
    }

    it.each(SHAPES)(
      "narrows %s by employee, category, month and eTIMS status, alone and together",
      async (shape, listKind) => {
        // #given
        const rows = await seedMatrix(shape);
        const all = Object.values(rows).sort();
        const without = (excluded: string) =>
          all.filter((id) => id !== excluded);

        // #when
        const results = {
          employee: await idsListed(`?membershipId=${employeeMembershipId}`),
          category: await idsListed(`?categoryId=${officeId}`),
          month: await idsListed("?month=2026-10"),
          etims: await idsListed("?etimsStatus=attached"),
          kind: await idsListed(`?kind=${listKind}`),
          together: await idsListed(
            `?membershipId=${employeeMembershipId}&categoryId=${officeId}&month=2026-10&etimsStatus=attached&kind=${listKind}`,
          ),
        };

        // #then
        expect(results).toEqual({
          employee: without(rows.otherPerson),
          category: without(rows.otherCategory),
          month: without(rows.otherMonth),
          etims: without(rows.otherEtims),
          kind: all,
          together: [rows.target],
        });
      },
    );

    it.each(SHAPES)(
      "leaves %s out of the other kinds",
      async (shape, listKind) => {
        // #given
        await seed(shape);

        // #when
        const counts = Object.fromEntries(
          await Promise.all(
            (["claim", "petty_cash", "company"] as const).map(
              async (kind) =>
                [
                  kind,
                  (await listed(`?kind=${kind}`)).expenses.length,
                ] as const,
            ),
          ),
        );

        // #then
        expect(counts).toEqual({
          claim: listKind === "claim" ? 1 : 0,
          petty_cash: listKind === "petty_cash" ? 1 : 0,
          company: listKind === "company" ? 1 : 0,
        });
      },
    );

    it("takes a month from its first day to its last, inclusive", async () => {
      // #given
      const firstDay = await seed("claim", { spentOn: "2026-10-01" });
      const lastDay = await seed("company", { spentOn: "2026-10-31" });
      await seed("claim", { spentOn: "2026-09-30" });
      await seed("float", { spentOn: "2026-11-01" });
      const leapDay = await seed("claim", { spentOn: "2024-02-29" });

      // #when
      const october = await idsListed("?month=2026-10");
      const february = await idsListed("?month=2024-02");

      // #then
      expect({ october, february }).toEqual({
        october: [firstDay, lastDay].sort(),
        february: [leapDay],
      });
    });

    it("narrows by status, and by whether it has a receipt", async () => {
      // #given
      const waiting = await seed("claim");
      const rejected = await seed("claim", {
        status: "rejected",
        rejectedReason: "Not a work expense",
      });
      const recorded = await seed("company");
      await attachPhoto(waiting);

      // #when
      const results = {
        waiting: await idsListed("?status=submitted"),
        rejected: await idsListed("?status=rejected"),
        noReceipt: await idsListed("?noReceipt=true"),
        withReceipt: await idsListed("?noReceipt=false"),
        together: await idsListed("?status=submitted&noReceipt=true"),
      };

      // #then
      expect(results).toEqual({
        waiting: [waiting],
        rejected: [rejected],
        noReceipt: [rejected, recorded].sort(),
        withReceipt: [waiting],
        together: [],
      });
    });

    it.each([
      "month=2026-13",
      "month=2026-00",
      "month=0999-01",
      "month=2026-1",
      "kind=float",
      "kind=salary",
      "categoryId=office",
      "membershipId=someone",
      "etimsStatus=missing",
      "status=late",
      "noReceipt=1",
      "sort=size",
      "dir=up",
      "limit=0",
      "limit=101",
      "cursor=not-a-page",
    ])("refuses the malformed filter %s", async (filter) => {
      // #when
      const response = await read(`?${filter}`);

      // #then
      expect(response.status).toBe(400);
    });
  });

  it("pages through every kind on the same date without skipping or repeating", async () => {
    // #given
    const seeded = [
      await seed("claim"),
      await seed("company"),
      await seed("float"),
      await seed("overspend"),
      await seed("claim", { spentOn: "2026-10-14" }),
    ];

    // #when
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ExpensesPage = await listed(
        `?limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      seen.push(...page.expenses.map((expense) => expense.id));
      cursor = page.nextCursor;
    } while (cursor !== null);

    // #then
    expect({ count: seen.length, ids: [...seen].sort() }).toEqual({
      count: seeded.length,
      ids: [...seeded].sort(),
    });
  });

  it("shows an accountant exactly what an admin sees", async () => {
    // #given
    await seed("claim", {
      warnings: [
        { code: "older_than_60_days", spentOn: "2026-06-01", ageDays: 136 },
      ],
    });
    await seed("float");
    await seed("company");

    // #when
    const adminView = await listed();
    const asAccountant = await listed("", accountant);

    // #then
    expect(asAccountant).toEqual(adminView);
  });

  it("refuses employees, even for their own expenses", async () => {
    // #given
    const own = await seed("claim");

    // #when
    const statuses = [
      (await read("", employee)).status,
      (await read(`/${own}`, employee)).status,
    ];

    // #then
    expect(statuses).toEqual([403, 403]);
  });

  it("keeps each company's expenses to itself", async () => {
    // #given
    const other = await createCompany(db);
    await addCategory(db, other, "Office supplies").then((categoryId) =>
      seed("company", { categoryId }, other),
    );
    const ours = await seed("claim");

    // #when
    const listedHere = await idsListed();

    // #then
    expect(listedHere).toEqual([ours]);
    for (const suffix of ["", `/${ours}`]) {
      await expectRouteIsolation(
        app,
        { db, companyA: company(), companyB: other },
        (organizationId) => ({
          path: `/organizations/${organizationId}/expenses${suffix}`,
        }),
      );
    }
  });
});

describe("GET /organizations/:id/expenses, sorted", () => {
  async function named(fullName: string): Promise<string> {
    const person = await createUser(db);
    await db.update(users).set({ fullName }).where(eq(users.id, person.id));
    return addMember(db, company(), person);
  }

  /** Every page of the sort, followed through its cursors. */
  async function everyPage(query: string): Promise<string[]> {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: ExpensesPage = await listed(
        `?${query}&limit=2${cursor === null ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
      );
      seen.push(...page.expenses.map((expense) => expense.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return seen;
  }

  it("sorts by amount either way, a tie going by when it was recorded", async () => {
    // #given
    const fifty = await seed("company", { amountKes: 5_000n });
    const ten = await seed("claim", { amountKes: 1_000n });
    const thirty = await seed("company", { amountKes: 3_000n });
    const thirtyLater = await seed("claim", { amountKes: 3_000n });
    const twenty = await seed("claim", { amountKes: 2_000n });

    // #when
    const sorted = {
      asc: await everyPage("sort=amount&dir=asc"),
      desc: await everyPage("sort=amount&dir=desc"),
    };

    // #then
    expect(sorted).toEqual({
      asc: [ten, twenty, thirty, thirtyLater, fifty],
      desc: [fifty, thirtyLater, thirty, twenty, ten],
    });
  });

  it("sorts by merchant without regard to case, whatever the name holds", async () => {
    // #given
    const naivas = await seed("claim", { merchant: "Naivas | Sarit" });
    const java = await seed("claim", { merchant: "java House" });
    const artcaffe = await seed("company", { merchant: "Artcaffe" });
    const quickmart = await seed("claim", { merchant: "Quickmart" });

    // #when
    const sorted = await everyPage("sort=merchant&dir=asc");

    // #then
    expect(sorted).toEqual([artcaffe, java, naivas, quickmart]);
  });

  it("sorts by the person's name", async () => {
    // #given
    const amina = await named("amina Hassan");
    const brian = await named("Brian Otieno");
    const byBrian = await seed("claim", { membershipId: brian });
    const byAmina = await seed("claim", { membershipId: amina });
    const byJane = await seed("claim");

    // #when
    const sorted = await everyPage("sort=person&dir=desc");

    // #then
    expect(sorted).toEqual([byJane, byBrian, byAmina]);
  });

  it("sorts by status, a failed payment first and recorded spending last", async () => {
    // #given
    const recorded = await seed("company");
    const paid = await seed("claim", { status: "paid" });
    const waiting = await seed("claim", { status: "submitted" });
    const failed = await seed("claim", { status: "payout_failed" });
    const rejected = await seed("claim", {
      status: "rejected",
      rejectedReason: "Not a work expense",
    });

    // #when
    const sorted = await everyPage("sort=status&dir=asc");

    // #then
    expect(sorted).toEqual([failed, waiting, rejected, paid, recorded]);
  });

  it("sorts by purchase date oldest first", async () => {
    // #given
    const october = await seed("claim", { spentOn: "2026-10-03" });
    const september = await seed("company", { spentOn: "2026-09-20" });
    const november = await seed("claim", { spentOn: "2026-11-01" });

    // #when
    const sorted = await everyPage("sort=date&dir=asc");

    // #then
    expect(sorted).toEqual([september, october, november]);
  });

  it("refuses a cursor from another sort", async () => {
    // #given
    await seed("claim", { merchant: "Artcaffe" });
    await seed("claim", { merchant: "Bolt" });
    const { nextCursor } = await listed("?sort=merchant&dir=asc&limit=1");

    // #when
    const statuses = await Promise.all(
      ["sort=amount", "sort=date", "sort=status"].map(async (sort) => {
        const response = await read(
          `?${sort}&limit=1&cursor=${encodeURIComponent(nextCursor ?? "")}`,
        );
        return response.status;
      }),
    );

    // #then
    expect(statuses).toEqual([400, 400, 400]);
  });
});

describe("GET /organizations/:id/expenses/summary", () => {
  async function summary(
    query = "",
    user: TestUser = admin(),
  ): Promise<ExpensesSummary> {
    return expensesSummarySchema.parse(
      await dataOf(await read(`/summary${query}`, user)),
    );
  }

  it("counts and totals every expense the filters match, however many pages", async () => {
    // #given
    const waiting = await seed("claim", {
      amountKes: 100_000n,
      etimsStatus: "attached",
      etimsInvoiceNumber: "INV1",
    });
    await attachPhoto(waiting);
    await seed("claim", { amountKes: 200_000n, etimsStatus: "none" });
    await seed("float", {
      amountKes: 50_000n,
      etimsStatus: "not_required",
    });
    await seed("company", { amountKes: 400_000n, etimsStatus: "none" });

    // #when
    const result = await summary();

    // #then
    expect(result).toEqual({
      count: 4,
      totalKes: "750000",
      waitingForApproval: { count: 2, totalKes: "300000" },
      withoutReceipt: { count: 3, totalKes: "650000" },
      withoutEtims: { count: 2, totalKes: "600000" },
      kinds: { claim: 2, petty_cash: 1, company: 1 },
    });
  });

  it("totals the kind asked for, and counts every kind's tab with the other filters", async () => {
    // #given
    await seed("claim", { amountKes: 100_000n });
    await seed("claim", { amountKes: 100_000n, categoryId: mealsId });
    await seed("float", { amountKes: 50_000n });
    await seed("company", { amountKes: 400_000n });

    // #when
    const result = await summary(`?kind=claim&categoryId=${officeId}`);

    // #then
    expect({
      count: result.count,
      totalKes: result.totalKes,
      kinds: result.kinds,
    }).toEqual({
      count: 1,
      totalKes: "100000",
      kinds: { claim: 1, petty_cash: 1, company: 1 },
    });
  });

  it("never counts the company spending a bill marked paid outside records", async () => {
    // #given
    const billId = await insertBill(db, company(), {
      payeeId: await insertPayee(db, company()),
      categoryId: officeId,
      dueOn: "2026-10-10",
      status: "due",
    });
    const marked = await sendJson(
      app,
      companyPath(`/bills/${billId}/mark-paid-outside`),
      admin(),
      { method: "POST", body: { paidOn: "2026-10-09" } },
    );
    expect(marked.status, await marked.clone().text()).toBe(200);

    // #when
    const result = await summary();

    // #then
    expect({ count: result.count, kinds: result.kinds }).toEqual({
      count: 0,
      kinds: { claim: 0, petty_cash: 0, company: 0 },
    });
  });

  it("shows an accountant what an admin sees, and refuses employees", async () => {
    // #given
    await seed("claim");
    await seed("company");

    // #when
    const asEmployee = await read("/summary", employee);

    // #then
    expect(await summary("", accountant)).toEqual(await summary());
    expect(asEmployee.status).toBe(403);
  });

  it.each(["kind=float", "noReceipt=yes", "status=late", "month=2026-1"])(
    "refuses the malformed filter %s",
    async (filter) => {
      // #when
      const response = await read(`/summary?${filter}`);

      // #then
      expect(response.status).toBe(400);
    },
  );

  it("keeps each company's totals to itself", async () => {
    // #given
    const other = await createCompany(db);

    // #then
    await expectRouteIsolation(
      app,
      { db, companyA: company(), companyB: other },
      (organizationId) => ({
        path: `/organizations/${organizationId}/expenses/summary`,
      }),
    );
  });
});

describe("GET /organizations/:id/expenses/:expenseId", () => {
  it("shows a claim's receipts as short-lived links, with its warnings", async () => {
    // #given
    const warning = {
      code: "older_than_60_days" as const,
      spentOn: "2026-06-01",
      ageDays: 136,
    };
    const claim = await seed("claim", { warnings: [warning] });
    const photo = await attachPhoto(claim);

    // #when
    const shown = await detail(claim, accountant);

    // #then
    expect({ warnings: shown.warnings, receipts: shown.receipts }).toEqual({
      warnings: [warning],
      receipts: [
        expect.objectContaining({
          id: photo.id,
          kind: "photo",
          billRole: null,
          url: expect.stringContaining(photo.key) as unknown,
        }),
      ],
    });
  });

  it("shows float spending with the receipts held on the claim it overspent into", async () => {
    // #given
    const floatId = await openFloat();
    const overspend = await seed("overspend", { floatId });
    const spending = await seed("float", {
      floatId,
      overspendClaimId: overspend,
    });
    const photo = await attachPhoto(overspend);

    // #when
    const shown = await detail(spending);

    // #then
    expect({
      receipts: shown.receipts.map((receipt) => receipt.id),
      receiptCount: shown.receiptCount,
      noReceipt: shown.noReceipt,
      overspendClaimId: shown.overspendClaimId,
    }).toEqual({
      receipts: [photo.id],
      receiptCount: 1,
      noReceipt: false,
      overspendClaimId: overspend,
    });
  });

  it("shows company spending from a bill with the bill's invoice", async () => {
    // #given
    const payeeId = await insertPayee(db, company());
    const billId = await insertBill(db, company(), {
      payeeId,
      categoryId: officeId,
    });
    const recorded = await seed("company", { billId });
    const key = `org/${company().organizationId}/bills/invoice.pdf`;
    await runInScope(db, asAdmin(), (tx) =>
      tx.insert(receiptFiles).values({
        organizationId: company().organizationId,
        billId,
        billRole: "invoice",
        uploadedBy: admin().id,
        kind: "pdf",
        storageKey: key,
        sha256: randomSha256(),
        byteSize: 90_000,
        contentType: "application/pdf",
      }),
    );

    // #when
    const shown = await detail(recorded);

    // #then
    expect(shown.receipts).toEqual([
      expect.objectContaining({
        kind: "pdf",
        billRole: "invoice",
        contentType: "application/pdf",
        url: expect.stringContaining(key) as unknown,
      }),
    ]);
  });

  it("flags spending saved without a receipt, with the reason", async () => {
    // #given
    const recorded = await seed("company", {
      noReceiptReason: "The supplier gave no receipt",
    });

    // #when
    const shown: Expense = await detail(recorded);

    // #then
    expect({
      noReceipt: shown.noReceipt,
      reason: shown.noReceiptReason,
      receipts: shown.receiptCount,
    }).toEqual({
      noReceipt: true,
      reason: "The supplier gave no receipt",
      receipts: 0,
    });
  });

  it("answers 404 for an expense that isn't the company's, or isn't an ID", async () => {
    // #given
    const other = await createCompany(db);
    const theirs = await addCategory(db, other, "Office").then((categoryId) =>
      seed("company", { categoryId }, other),
    );

    // #when
    const statuses = [
      (await read(`/${theirs}`)).status,
      (await read(`/${randomUUID()}`)).status,
      (await read("/not-an-id")).status,
    ];

    // #then
    expect(statuses).toEqual([404, 404, 404]);
  });
});
