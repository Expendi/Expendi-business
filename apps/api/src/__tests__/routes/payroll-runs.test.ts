import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  MembershipRole,
  PayrollRunDetail,
} from "@expendi-business/shared";
import {
  mySalaryPaymentsResponseSchema,
  payrollRunDetailSchema,
  payrollRunsResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { BillRow } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser, TestWallet } from "../helpers/db.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { insertPayee } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { randomKenyanMobile } from "../helpers/payees.js";
import {
  addEmployeePayee,
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
  setRunStatus,
  settlePayrollBill,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let company: TestCompany;
let wallet: TestWallet;
let categoryId: string;
let amina: PayrollPerson;
let brian: PayrollPerson;
let runId: string;

/** 23 Nov in Nairobi: 28 Nov's run is due. */
const NOV_23_MIDNIGHT_EAT = new Date("2026-11-22T21:00:00Z");

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

/** A company paying Amina KES 60,000 and Brian KES 40,000 on 28 Nov, drafted. */
async function seedPayroll(target: TestCompany): Promise<{
  readonly categoryId: string;
  readonly amina: PayrollPerson;
  readonly brian: PayrollPerson;
  readonly runId: string;
}> {
  const category = await addCategory(db, target, "Salaries");
  const first = await addEmployeePayee(db, target, "Amina");
  const second = await addEmployeePayee(db, target, "Brian");
  await insertSalary(db, target, {
    payeeId: first.payeeId,
    categoryId: category,
    amountKes: 6_000_000n,
  });
  await insertSalary(db, target, {
    payeeId: second.payeeId,
    categoryId: category,
    amountKes: 4_000_000n,
  });
  await runtime.runPromise(
    draftDuePayroll(target.organizationId, NOV_23_MIDNIGHT_EAT),
  );
  const [run] = await runsOf(db, target);
  if (!run) throw new Error("no run drafted");
  return { categoryId: category, amina: first, brian: second, runId: run.id };
}

beforeEach(async () => {
  company = await createCompany(db);
  wallet = await createActiveWallet(db, company);
  ({ categoryId, amina, brian, runId } = await seedPayroll(company));
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/payroll-runs`;

function send(
  method: string,
  path: string,
  body?: unknown,
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<Response> {
  return sendJson(app, path, user, { method, body });
}

async function dataOf<T>(
  response: Response,
  schema: { parse: (value: unknown) => T },
): Promise<T> {
  const { data } = (await response.json()) as { data: unknown };
  return schema.parse(data);
}

async function errorOf(response: Response): Promise<string> {
  const { error } = (await response.json()) as { error: { message: string } };
  return error.message;
}

async function billOf(person: PayrollPerson): Promise<BillRow> {
  const bill = (await billsOfRun(db, company, runId)).find(
    (row) => row.payeeId === person.payeeId,
  );
  if (!bill) throw new Error("no bill for that person");
  return bill;
}

async function detail(): Promise<PayrollRunDetail> {
  return dataOf(
    await send("GET", `${base()}/${runId}`),
    payrollRunDetailSchema,
  );
}

async function auditOf(action: string) {
  const { rows } = await owner.query<{
    actor_id: string;
    before: Record<string, unknown>;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_id, before, after FROM audit_log WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at",
    [company.organizationId, action],
  );
  return rows;
}

describe("GET /organizations/:id/payroll-runs", () => {
  it("lists runs with their totals, cap and head count", async () => {
    // #when
    const runs = await dataOf(
      await send("GET", base()),
      payrollRunsResponseSchema,
    );

    // #then
    expect(runs).toMatchObject([
      {
        id: runId,
        payDate: "2026-11-28",
        status: "draft",
        totalKes: "10000000",
        salariesKes: "10000000",
        capKes: "12000000",
        people: 2,
        leftOut: 0,
        adjusted: 0,
        oneOffs: 0,
        approvedAt: null,
      },
    ]);
  });

  it("counts changed pay and one-offs, leaving out the people left out", async () => {
    // #given Amina's pay changes, Brian gets a one-off, and Brian's changed salary is left out
    const aminaBill = await billOf(amina);
    const brianBill = await billOf(brian);
    const change = (billId: string) =>
      send("PATCH", `${base()}/${runId}/payments/${billId}`, {
        amountKes: "61,000",
        reason: "Overtime",
      });
    await change(aminaBill.id);
    await change(brianBill.id);
    await send("POST", `${base()}/${runId}/one-offs`, {
      payeeId: brian.payeeId,
      amountKes: "5,000",
      reason: "Bonus",
    });
    await send(
      "POST",
      `${base()}/${runId}/payments/${brianBill.id}/leave-out`,
      {
        reason: "Unpaid leave",
      },
    );

    // #when
    const [run] = await dataOf(
      await send("GET", base()),
      payrollRunsResponseSchema,
    );

    // #then
    expect(run).toMatchObject({
      people: 2,
      leftOut: 1,
      adjusted: 1,
      oneOffs: 1,
    });
  });

  it("shows the last 4 digits a person is paid to, but never an employee's own M-Pesa number", async () => {
    // #given a casual worker paid on M-Pesa, and another to a bank account
    const mpesaId = await insertPersonnelPayee(
      db,
      company,
      "Otieno",
      "+254712345678",
    );
    const bankId = await insertPayee(db, company, {
      kind: "personnel",
      name: "Wekesa",
      method: "bank",
      bankCode: "KCBLKENX",
      bankAccountNumber: "1100223344",
      accountName: "Wekesa",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });
    for (const payeeId of [mpesaId, bankId]) {
      await send("POST", `${base()}/${runId}/one-offs`, {
        payeeId,
        amountKes: "2,500",
        reason: "Stock take",
        categoryId,
      });
    }

    // #when
    const run = await detail();

    // #then
    expect(
      Object.fromEntries(
        run.payments.map(({ payee }) => [payee.name, payee.accountEnding]),
      ),
    ).toEqual({ Amina: null, Brian: null, Otieno: "5678", Wekesa: "3344" });
  });

  it("shows everyone in the run with their pay", async () => {
    // #when
    const run = await detail();

    // #then
    expect(
      run.payments.map((payment) => ({
        name: payment.payee.name,
        kind: payment.kind,
        amountKes: payment.amountKes,
        status: payment.status,
        leftOut: payment.leftOut,
      })),
    ).toEqual([
      {
        name: "Amina",
        kind: "salary",
        amountKes: "6000000",
        status: "upcoming",
        leftOut: null,
      },
      {
        name: "Brian",
        kind: "salary",
        amountKes: "4000000",
        status: "upcoming",
        leftOut: null,
      },
    ]);
  });
});

describe("changing one person's pay in a draft", () => {
  const adjust = (billId: string, body: unknown) =>
    send("PATCH", `${base()}/${runId}/payments/${billId}`, body);

  it("changes their pay for this run, keeps the reason and recomputes the total", async () => {
    // #given
    const bill = await billOf(amina);

    // #when
    const run = await dataOf(
      await adjust(bill.id, { amountKes: "65,000", reason: "Q4 bonus" }),
      payrollRunDetailSchema,
    );

    // #then
    expect({
      totalKes: run.totalKes,
      capKes: run.capKes,
      amina: run.payments.find((payment) => payment.billId === bill.id),
    }).toMatchObject({
      totalKes: "10500000",
      capKes: "12000000",
      amina: { amountKes: "6500000", adjustmentReason: "Q4 bonus" },
    });
  });

  it("needs a reason", async () => {
    // #given
    const bill = await billOf(amina);

    // #when
    const response = await adjust(bill.id, {
      amountKes: "65,000",
      reason: " ",
    });

    // #then
    expect({
      status: response.status,
      message: await errorOf(response),
    }).toEqual({
      status: 400,
      message: "Say why their pay changes this time.",
    });
  });

  it("audits who changed it, from what, to what and why", async () => {
    // #given
    const bill = await billOf(amina);

    // #when
    await adjust(bill.id, { amountKes: "30,000", reason: "Unpaid leave" });

    // #then
    expect((await auditOf("payroll_run.payment_adjusted"))[0]).toMatchObject({
      actor_id: company.admin.id,
      before: { billId: bill.id, amountKes: "6000000", totalKes: "10000000" },
      after: {
        billId: bill.id,
        amountKes: "3000000",
        reason: "Unpaid leave",
        totalKes: "7000000",
      },
    });
  });

  it("doesn't change their salary", async () => {
    // #given
    const bill = await billOf(amina);

    // #when
    await adjust(bill.id, { amountKes: "65,000", reason: "Q4 bonus" });

    // #then
    const salaries = await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        tx.execute<{ amount_kes: string }>(
          sql`SELECT amount_kes::text FROM recurring_items WHERE id = ${bill.recurringItemId}`,
        ),
    );
    expect(salaries.rows).toEqual([{ amount_kes: "6000000" }]);
  });

  it("refuses the amount it already is", async () => {
    // #given
    const bill = await billOf(amina);

    // #when
    const response = await adjust(bill.id, {
      amountKes: "60,000",
      reason: "No change",
    });

    // #then
    expect(response.status).toBe(400);
  });
});

describe("leaving someone out of a draft", () => {
  const leaveOut = (billId: string, body: unknown) =>
    send("POST", `${base()}/${runId}/payments/${billId}/leave-out`, body);

  it("leaves them out of this run with the reason, and takes them off the total", async () => {
    // #given
    const bill = await billOf(brian);

    // #when
    const run = await dataOf(
      await leaveOut(bill.id, { reason: "Left the company" }),
      payrollRunDetailSchema,
    );

    // #then
    expect({
      totalKes: run.totalKes,
      people: run.people,
      leftOut: run.leftOut,
      brian: run.payments.find((payment) => payment.billId === bill.id),
    }).toMatchObject({
      totalKes: "6000000",
      people: 1,
      leftOut: 1,
      brian: {
        status: "cancelled",
        leftOut: { reason: "Left the company" },
      },
    });
  });

  it("needs a reason", async () => {
    // #given
    const bill = await billOf(brian);

    // #when
    const response = await leaveOut(bill.id, {});

    // #then
    expect(response.status).toBe(400);
  });

  it("audits it", async () => {
    // #given
    const bill = await billOf(brian);

    // #when
    await leaveOut(bill.id, { reason: "Left the company" });

    // #then
    expect((await auditOf("payroll_run.payment_left_out"))[0]).toMatchObject({
      actor_id: company.admin.id,
      after: {
        billId: bill.id,
        status: "cancelled",
        reason: "Left the company",
        totalKes: "6000000",
      },
    });
  });

  it("can't leave them out twice, or change their pay once they're out", async () => {
    // #given
    const bill = await billOf(brian);
    await leaveOut(bill.id, { reason: "Left the company" });

    // #when
    const responses = await Promise.all([
      leaveOut(bill.id, { reason: "Again" }),
      send("PATCH", `${base()}/${runId}/payments/${bill.id}`, {
        amountKes: "1",
        reason: "Back pay",
      }),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([409, 409]);
  });
});

describe("adding a one-off payment to a draft", () => {
  const addOneOff = (body: unknown) =>
    send("POST", `${base()}/${runId}/one-offs`, body);

  it("adds it as its own payment with its reason, in their salary's category, and raises the total", async () => {
    // #when
    const response = await addOneOff({
      payeeId: brian.payeeId,
      amountKes: "5,000",
      reason: "Overtime in November",
    });

    // #then
    const run = await dataOf(response, payrollRunDetailSchema);
    expect({
      status: response.status,
      totalKes: run.totalKes,
      oneOff: run.payments.find((payment) => payment.kind === "one_off"),
    }).toMatchObject({
      status: 201,
      totalKes: "10500000",
      oneOff: {
        salaryId: null,
        payee: { id: brian.payeeId },
        category: { id: categoryId },
        amountKes: "500000",
        note: "Overtime in November",
        status: "upcoming",
      },
    });
  });

  it("pays someone not on payroll, with a category picked", async () => {
    // #given
    const casualId = await insertPersonnelPayee(db, company, "Otieno");
    const other = await addCategory(db, company, "Casual labour");

    // #when
    const response = await addOneOff({
      payeeId: casualId,
      amountKes: "2,500",
      reason: "Stock take",
      categoryId: other,
    });

    // #then
    expect(response.status).toBe(201);
  });

  it("needs a category for someone not on payroll", async () => {
    // #given
    const casualId = await insertPersonnelPayee(db, company, "Otieno");

    // #when
    const response = await addOneOff({
      payeeId: casualId,
      amountKes: "2,500",
      reason: "Stock take",
    });

    // #then
    expect({
      status: response.status,
      message: await errorOf(response),
    }).toEqual({ status: 400, message: "Pick a category for this payment." });
  });

  it("needs a reason", async () => {
    // #when
    const response = await addOneOff({
      payeeId: brian.payeeId,
      amountKes: "5,000",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("only pays employees and other personnel", async () => {
    // #given
    const supplierId = await insertPayee(db, company);

    // #when
    const response = await addOneOff({
      payeeId: supplierId,
      amountKes: "5,000",
      reason: "Not payroll",
      categoryId,
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("audits it", async () => {
    // #when
    await addOneOff({
      payeeId: brian.payeeId,
      amountKes: "5,000",
      reason: "Overtime in November",
    });

    // #then
    expect((await auditOf("payroll_run.one_off_added"))[0]).toMatchObject({
      actor_id: company.admin.id,
      after: {
        payeeId: brian.payeeId,
        amountKes: "500000",
        reason: "Overtime in November",
        totalKes: "10500000",
      },
    });
  });
});

describe("once a run isn't a draft", () => {
  it.each(["paying", "paid", "partly_failed"] as const)(
    "refuses every change while it's %s",
    async (status) => {
      // #given
      const bill = await billOf(amina);
      await setRunStatus(db, company, runId, status);

      // #when
      const responses = await Promise.all([
        send("PATCH", `${base()}/${runId}/payments/${bill.id}`, {
          amountKes: "1",
          reason: "Late change",
        }),
        send("POST", `${base()}/${runId}/payments/${bill.id}/leave-out`, {
          reason: "Late change",
        }),
        send("POST", `${base()}/${runId}/one-offs`, {
          payeeId: amina.payeeId,
          amountKes: "1",
          reason: "Late change",
        }),
      ]);

      // #then
      expect(responses.map((response) => response.status)).toEqual([
        409, 409, 409,
      ]);
    },
  );
});

it("doesn't change a payment through another run", async () => {
  // #given a second run, for December
  await insertSalary(db, company, {
    payeeId: (await addEmployeePayee(db, company)).payeeId,
    categoryId,
    nextDueOn: "2026-12-28",
  });
  await runtime.runPromise(
    draftDuePayroll(company.organizationId, new Date("2026-12-23T06:00:00Z")),
  );
  const december = (await runsOf(db, company)).find(
    (run) => run.payDate === "2026-12-28",
  );
  const [bill] = await billsOfRun(db, company, december?.id ?? "");
  if (!bill) throw new Error("December wasn't drafted");

  // #when
  const response = await send(
    "PATCH",
    `${base()}/${runId}/payments/${bill.id}`,
    { amountKes: "1", reason: "Wrong run" },
  );

  // #then
  expect(response.status).toBe(404);
});

describe("salaries are private", () => {
  const routes = [
    ["GET", ""],
    ["GET", "/:runId"],
    ["POST", "/:runId/one-offs"],
    ["PATCH", "/:runId/payments/:billId"],
    ["POST", "/:runId/payments/:billId/leave-out"],
  ] as const;

  it.each(routes)("an employee gets 403 from %s %s", async (method, path) => {
    // #given
    const bill = await billOf(brian);

    // #when
    const response = await send(
      method,
      `${base()}${path.replace(":runId", runId).replace(":billId", bill.id)}`,
      method === "GET"
        ? undefined
        : { amountKes: "1", reason: "Myself", payeeId: amina.payeeId },
      amina.user,
    );

    // #then
    expect(response.status).toBe(403);
  });

  it("refuses an employee on every salary and payroll route, including the bills and recurring payments that hold them", async () => {
    // #given
    const bill = await billOf(brian);
    const paths = [
      `/organizations/${company.organizationId}/salaries`,
      `/organizations/${company.organizationId}/salaries/${bill.recurringItemId}`,
      `/organizations/${company.organizationId}/bills`,
      `/organizations/${company.organizationId}/bills/${bill.id}`,
      `/organizations/${company.organizationId}/recurring-items`,
      `/organizations/${company.organizationId}/recurring-items/${bill.recurringItemId}`,
      base(),
      `${base()}/${runId}`,
    ];

    // #when
    const statuses = await Promise.all(
      paths.map(
        async (path) => (await send("GET", path, undefined, amina.user)).status,
      ),
    );

    // #then
    expect(statuses).toEqual(paths.map(() => 403));
  });
});

describe("GET /organizations/:id/me/salary-payments", () => {
  const mine = (user: Pick<TestUser, "privyUserId">) =>
    send(
      "GET",
      `/organizations/${company.organizationId}/me/salary-payments`,
      undefined,
      user,
    );

  it("shows nothing while the run is still a draft", async () => {
    // #when
    const payments = await dataOf(
      await mine(amina.user),
      mySalaryPaymentsResponseSchema,
    );

    // #then
    expect(payments).toEqual([]);
  });

  it("shows an employee only their own payments once they're being paid", async () => {
    // #given both are paid, and Amina gets a one-off that failed
    await setRunStatus(db, company, runId, "paying");
    const aminaBill = await billOf(amina);
    await settlePayrollBill(db, company, wallet.id, aminaBill, "paid");
    await settlePayrollBill(
      db,
      company,
      wallet.id,
      await billOf(brian),
      "paying",
    );

    // #when
    const payments = await dataOf(
      await mine(amina.user),
      mySalaryPaymentsResponseSchema,
    );

    // #then
    expect(payments).toEqual([
      {
        id: aminaBill.id,
        kind: "salary",
        payDate: "2026-11-28",
        amountKes: "6000000",
        status: "paid",
        paidOn: "2026-11-28",
      },
    ]);
  });

  it("shows an admin on payroll only their own payments too", async () => {
    // #given the admin is on payroll too, and everyone is paid
    const adminPayeeId = await insertPayee(db, company, {
      kind: "employee",
      name: "The Boss",
      membershipId: company.adminMembershipId,
      method: "mpesa_phone",
      accountName: "The Boss",
      detailsChangedAt: new Date(),
    });
    await insertSalary(db, company, { payeeId: adminPayeeId, categoryId });
    await runtime.runPromise(
      draftDuePayroll(company.organizationId, NOV_23_MIDNIGHT_EAT),
    );
    const bossBill = (await billsOfRun(db, company, runId)).find(
      (row) => row.payeeId === adminPayeeId,
    );
    if (!bossBill) throw new Error("the admin wasn't drafted");
    await setRunStatus(db, company, runId, "paying");
    for (const bill of await billsOfRun(db, company, runId)) {
      await settlePayrollBill(db, company, wallet.id, bill, "paid");
    }

    // #when
    const payments = await dataOf(
      await mine(company.admin),
      mySalaryPaymentsResponseSchema,
    );

    // #then
    expect(payments.map((payment) => payment.id)).toEqual([bossBill.id]);
  });

  it("is open to every member, for their own payments", async () => {
    // #given someone with no salary
    const colleague = await createUser(db);
    await addMember(db, company, colleague);
    await settlePayrollBill(
      db,
      company,
      wallet.id,
      await billOf(amina),
      "paid",
    );

    // #when
    const response = await mine(colleague);

    // #then
    expect(await dataOf(response, mySalaryPaymentsResponseSchema)).toEqual([]);
  });
});

describe("row-level security", () => {
  /** A deliberately unfiltered query as someone in the company. */
  function rawAs<T extends Record<string, unknown>>(
    query: ReturnType<typeof sql>,
    scope: { userId?: string; role?: MembershipRole },
  ) {
    return runInScope(
      db,
      { organizationId: company.organizationId, ...scope },
      (tx) => tx.execute<T>(query),
    ).then((result) => result.rows);
  }

  const asEmployee = (person: PayrollPerson) => ({
    userId: person.user.id,
    role: "employee" as const,
  });

  async function settleEveryone() {
    await setRunStatus(db, company, runId, "paying");
    const aminaBill = await billOf(amina);
    const brianBill = await billOf(brian);
    const aminaPayout = await settlePayrollBill(
      db,
      company,
      wallet.id,
      aminaBill,
      "paid",
    );
    const brianPayout = await settlePayrollBill(
      db,
      company,
      wallet.id,
      brianBill,
      "payout_failed",
    );
    return { aminaBill, brianBill, aminaPayout, brianPayout };
  }

  it("hides every salary and payroll run from an employee", async () => {
    // #when
    const seen = {
      salaries: await rawAs(
        sql`SELECT id FROM recurring_items`,
        asEmployee(amina),
      ),
      runs: await rawAs(sql`SELECT id FROM payroll_runs`, asEmployee(amina)),
    };

    // #then
    expect(seen).toEqual({ salaries: [], runs: [] });
  });

  it("hides draft payroll bills, even their own, from an employee", async () => {
    // #when
    const seen = await rawAs(sql`SELECT id FROM bills`, asEmployee(amina));

    // #then
    expect(seen).toEqual([]);
  });

  it("shows an employee their own salary payment's bill and payout, and nobody else's", async () => {
    // #given
    const { aminaBill, aminaPayout } = await settleEveryone();

    // #when
    const seen = {
      bills: await rawAs<{ id: string }>(
        sql`SELECT id FROM bills`,
        asEmployee(amina),
      ),
      payouts: await rawAs<{ id: string }>(
        sql`SELECT id FROM payouts WHERE payroll_run_id IS NOT NULL`,
        asEmployee(amina),
      ),
    };

    // #then
    expect(seen).toEqual({
      bills: [{ id: aminaBill.id }],
      payouts: [{ id: aminaPayout }],
    });
  });

  it("hides payroll payouts from an employee who isn't on payroll", async () => {
    // #given
    await settleEveryone();
    const colleague = await createUser(db);
    await addMember(db, company, colleague);

    // #when
    const seen = await rawAs(
      sql`SELECT id FROM payouts WHERE payroll_run_id IS NOT NULL`,
      { userId: colleague.id, role: "employee" },
    );

    // #then
    expect(seen).toEqual([]);
  });

  it("doesn't let an employee change someone's payroll payout", async () => {
    // #given
    const { brianPayout } = await settleEveryone();

    // #when
    const changed = await rawAs(
      sql`UPDATE payouts SET failure_reason = 'tampered' WHERE id = ${brianPayout} RETURNING id`,
      asEmployee(amina),
    );

    // #then
    expect(changed).toEqual([]);
  });

  it("shows admins, accountants and the payout engine every payroll payout", async () => {
    // #given
    const { aminaPayout, brianPayout } = await settleEveryone();
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    const query = sql`SELECT id FROM payouts WHERE payroll_run_id IS NOT NULL ORDER BY id`;

    // #when
    const seen = {
      admin: await rawAs<{ id: string }>(query, {
        userId: company.admin.id,
        role: "admin",
      }),
      accountant: await rawAs<{ id: string }>(query, {
        userId: accountant.id,
        role: "accountant",
      }),
      engine: await rawAs<{ id: string }>(query, {}),
    };

    // #then
    const all = [aminaPayout, brianPayout].sort().map((id) => ({ id }));
    expect(seen).toEqual({ admin: all, accountant: all, engine: all });
  });

  it("still shows an employee the company's other payouts, e.g. their claims", async () => {
    // #given a claim payout
    const claimPayoutId = randomUUID();
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx.insert(payouts).values({
        id: claimPayoutId,
        organizationId: company.organizationId,
        walletId: wallet.id,
        subjectType: "claim",
        subjectId: randomUUID(),
        idempotencyKey: `claim:${randomUUID()}:1`,
        method: "mpesa_phone",
        recipient: {
          method: "mpesa_phone",
          phone: randomKenyanMobile(),
          accountName: "Amina",
        },
        requestedKesCents: 10_000n,
        amountKes: 10_000n,
        quotedRate: "129.00",
        quotedUsdc: 1_000_000n,
        maxDebitUsdc: 1_500_000n,
        status: "failed",
      }),
    );

    // #when
    const seen = await rawAs(
      sql`SELECT id FROM payouts WHERE id = ${claimPayoutId}`,
      asEmployee(amina),
    );

    // #then
    expect(seen).toEqual([{ id: claimPayoutId }]);
  });
});

describe("company isolation", () => {
  it("keeps payroll runs to their company, for admins", async () => {
    // #given both companies have a run
    const fixture = await createIsolationFixture(db);
    await seedPayroll(fixture.companyA);
    await seedPayroll(fixture.companyB);

    // #then
    await expectTableIsolation(
      fixture,
      "payroll_runs",
      "organization_id",
      "admin",
    );
  });

  it.each([
    ["GET", "/payroll-runs"],
    ["GET", "/payroll-runs/00000000-0000-4000-8000-000000000000"],
    ["POST", "/payroll-runs/00000000-0000-4000-8000-000000000000/one-offs"],
    [
      "PATCH",
      "/payroll-runs/00000000-0000-4000-8000-000000000000/payments/00000000-0000-4000-8000-000000000000",
    ],
    [
      "POST",
      "/payroll-runs/00000000-0000-4000-8000-000000000000/payments/00000000-0000-4000-8000-000000000000/leave-out",
    ],
    ["GET", "/me/salary-payments"],
  ])("company A's admin can't use company B's %s %s", async (method, path) => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}${path}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      },
    }));
  });
});
