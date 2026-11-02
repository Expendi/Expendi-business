import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CreateSalaryRequest,
  Salary,
  SalaryAmountChallenge,
} from "@expendi-business/shared";
import { salariesResponseSchema, salarySchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { nairobiDate } from "../../services/bills/status.js";
import { insertPayee, shiftDays } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import { makeFakeEmailSender, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { createPayingCompany } from "../helpers/payouts.js";
import {
  addEmployeePayee,
  insertPersonnelPayee,
  insertSalary,
  readSalary,
  runsOf,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let paying: PayingCompany;
let company: TestCompany;
let person: PayrollPerson;
let categoryId: string;
let today: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ emailSender: email.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paying = await createPayingCompany(runtime, db);
  company = paying.company;
  person = await addEmployeePayee(db, company, "Amina Wanjiru");
  categoryId = await addCategory(db, company, "Salaries");
  today = nairobiDate(new Date());
  email.state.reset();
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/salaries`;

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

/** Starts in 40 days, so no payroll run is due yet. */
function salaryRequest(
  overrides: Partial<CreateSalaryRequest> = {},
): CreateSalaryRequest {
  return {
    payeeId: person.payeeId,
    amountKes: "50,000",
    payDay: 28,
    startsOn: shiftDays(today, 40),
    categoryId,
    ...overrides,
  };
}

async function createSalary(
  overrides: Partial<CreateSalaryRequest> = {},
): Promise<Salary> {
  const response = await send("POST", base(), salaryRequest(overrides));
  if (response.status !== 201) {
    throw new Error(
      `create salary answered ${response.status}: ${await response.text()}`,
    );
  }
  return dataOf(response, salarySchema);
}

async function auditOf(action: string) {
  const { rows } = await owner.query<{
    actor_id: string;
    entity_id: string;
    before: unknown;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_id, entity_id, before, after FROM audit_log WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at",
    [company.organizationId, action],
  );
  return rows;
}

/** The first pay day on or after `startsOn`, the 28th. */
function firstPayDate(startsOn: string, payDay = 28): string {
  const sameMonth = `${startsOn.slice(0, 8)}${String(payDay).padStart(2, "0")}`;
  if (sameMonth >= startsOn) return sameMonth;
  const [year = 0, month = 1] = startsOn.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, payDay));
  return next.toISOString().slice(0, 10);
}

describe("POST /organizations/:id/salaries", () => {
  it("puts an employee on payroll, first paid on the pay day after the start", async () => {
    // #when
    const salary = await createSalary();

    // #then
    const startsOn = shiftDays(today, 40);
    expect(salary).toMatchObject({
      state: "active",
      payee: {
        id: person.payeeId,
        name: "Amina Wanjiru",
        kind: "employee",
        method: "mpesa_phone",
        payoutPhoneConfirmed: false,
      },
      category: { id: categoryId, name: "Salaries" },
      amountKes: "5000000",
      payDay: 28,
      startsOn,
      endsOn: null,
      nextPayDate: firstPayDate(startsOn),
    });
  });

  it("puts personnel without an app login on payroll", async () => {
    // #given
    const casualId = await insertPersonnelPayee(db, company, "Otieno");

    // #when
    const response = await send(
      "POST",
      base(),
      salaryRequest({ payeeId: casualId }),
    );

    // #then
    expect(response.status).toBe(201);
  });

  it("pays a 31st on the last day of a shorter month", async () => {
    // #given a start on 1 Feb 2027, before which nothing is due
    const startsOn = "2027-02-01";

    // #when
    const salary = await createSalary({ payDay: 31, startsOn });

    // #then
    expect(salary.nextPayDate).toBe("2027-02-28");
  });

  it("audits who set it up and what", async () => {
    // #when
    const salary = await createSalary();

    // #then
    const [entry] = await auditOf("salary.created");
    expect(entry).toMatchObject({
      actor_id: company.admin.id,
      entity_id: salary.id,
      after: {
        payeeId: person.payeeId,
        amountKes: "5000000",
        scheduleDay: 28,
        overviewHeading: "salaries",
      },
    });
  });

  it("drafts the payroll run at once when the first pay date is 5 days away or less", async () => {
    // #given a start date that makes the first pay date today
    const payDay = Number(today.slice(8, 10));

    // #when
    await createSalary({ startsOn: today, payDay });

    // #then
    expect(await runsOf(db, company)).toMatchObject([
      { payDate: today, status: "draft", totalKes: 5_000_000n },
    ]);
  });

  it.each([
    {
      case: "a supplier",
      payee: () => insertPayee(db, company),
      message: "Only employees and other personnel are paid through payroll.",
    },
    {
      case: "someone with no payment details",
      payee: () =>
        insertPayee(db, company, { kind: "personnel", name: "No Details" }),
      message:
        "Give No Details an M-Pesa number or a bank account first: pay goes to one of those.",
    },
    {
      case: "someone paid outside Expendi",
      payee: () =>
        insertPayee(db, company, {
          kind: "personnel",
          name: "Cash Only",
          method: "outside",
        }),
      message:
        "Give Cash Only an M-Pesa number or a bank account first: pay goes to one of those.",
    },
  ])("refuses $case", async ({ payee, message }) => {
    // #given
    const payeeId = await payee();

    // #when
    const response = await send("POST", base(), salaryRequest({ payeeId }));

    // #then
    expect({
      status: response.status,
      message: await errorOf(response),
    }).toEqual({ status: 400, message });
  });

  it("refuses a second salary for the same person", async () => {
    // #given
    await createSalary();

    // #when
    const response = await send("POST", base(), salaryRequest());

    // #then
    expect({
      status: response.status,
      message: await errorOf(response),
    }).toEqual({
      status: 409,
      message: "Amina Wanjiru already has a salary. Change that one instead.",
    });
  });

  it("refuses a start date in the past", async () => {
    // #when
    const response = await send(
      "POST",
      base(),
      salaryRequest({ startsOn: shiftDays(today, -1) }),
    );

    // #then
    expect(response.status).toBe(400);
  });

  it.each([0, 32])("refuses pay day %s", async (payDay) => {
    // #when
    const response = await send("POST", base(), salaryRequest({ payDay }));

    // #then
    expect(response.status).toBe(400);
  });
});

describe("GET /organizations/:id/salaries", () => {
  it("lists current salaries by name, ended ones last", async () => {
    // #given
    const zawadi = await addEmployeePayee(db, company, "Zawadi");
    const bakari = await addEmployeePayee(db, company, "Bakari");
    await createSalary();
    const ended = await createSalary({ payeeId: bakari.payeeId });
    await send("POST", `${base()}/${ended.id}/end`);
    await createSalary({ payeeId: zawadi.payeeId });

    // #when
    const salaries = await dataOf(
      await send("GET", base()),
      salariesResponseSchema,
    );

    // #then
    expect(salaries.map((salary) => [salary.payee.name, salary.state])).toEqual(
      [
        ["Amina Wanjiru", "active"],
        ["Zawadi", "active"],
        ["Bakari", "ended"],
      ],
    );
  });

  it("doesn't find another company's salary", async () => {
    // #given
    const other = await createPayingCompany(runtime, db);
    const theirs = await addEmployeePayee(db, other.company);
    const theirCategory = await addCategory(db, other.company, "Pay");
    const salaryId = await insertSalary(db, other.company, {
      payeeId: theirs.payeeId,
      categoryId: theirCategory,
    });

    // #when
    const response = await send("GET", `${base()}/${salaryId}`);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("PATCH /organizations/:id/salaries/:salaryId", () => {
  it("moves the next pay date to the new pay day in the same month", async () => {
    // #given
    const salary = await createSalary({ payDay: 10 });

    // #when
    const updated = await dataOf(
      await send("PATCH", `${base()}/${salary.id}`, { payDay: 25 }),
      salarySchema,
    );

    // #then
    expect([updated.payDay, updated.nextPayDate]).toEqual([
      25,
      `${salary.nextPayDate?.slice(0, 8)}25`,
    ]);
  });

  it("audits a new pay day", async () => {
    // #given
    const salary = await createSalary({ payDay: 10 });

    // #when
    await send("PATCH", `${base()}/${salary.id}`, { payDay: 25 });

    // #then
    expect((await auditOf("salary.updated"))[0]).toMatchObject({
      before: { scheduleDay: 10 },
      after: { scheduleDay: 25 },
    });
  });

  it("never changes net pay without the passkey", async () => {
    // #given
    const salary = await createSalary();

    // #when
    const response = await send("PATCH", `${base()}/${salary.id}`, {
      amountKes: "90,000",
    });

    // #then
    expect({
      status: response.status,
      amountKes: (await readSalary(db, company, salary.id)).amountKes,
    }).toEqual({ status: 400, amountKes: 5_000_000n });
  });
});

describe("changing net pay", () => {
  async function requestChange(
    salaryId: string,
    amountKes: string,
  ): Promise<SalaryAmountChallenge> {
    const response = await send("POST", `${base()}/${salaryId}/amount`, {
      amountKes,
    });
    const { data } = (await response.json()) as {
      data: SalaryAmountChallenge;
    };
    return data;
  }

  function confirm(
    challenge: SalaryAmountChallenge,
    change: unknown = challenge.change,
  ): Promise<Response> {
    return send(
      "POST",
      `${base()}/amount-changes/${challenge.challengeId}/confirm`,
      {
        change,
        response: paying.passkey.sign(challenge.options, TEST_ORIGIN),
      },
    );
  }

  it("asks for the admin's passkey and changes nothing until it's confirmed", async () => {
    // #given
    const salary = await createSalary();

    // #when
    const challenge = await requestChange(salary.id, "65,000");

    // #then
    expect({
      challenge,
      amountKes: (await readSalary(db, company, salary.id)).amountKes,
    }).toMatchObject({
      challenge: {
        status: "confirmation_required",
        change: { salaryId: salary.id, amountKesCents: "6500000" },
      },
      amountKes: 5_000_000n,
    });
  });

  it("changes net pay once the passkey confirms it", async () => {
    // #given
    const salary = await createSalary();
    const challenge = await requestChange(salary.id, "65,000");

    // #when
    const updated = await dataOf(await confirm(challenge), salarySchema);

    // #then
    expect(updated.amountKes).toBe("6500000");
  });

  it("audits the change with the approval", async () => {
    // #given
    const salary = await createSalary();
    const challenge = await requestChange(salary.id, "65,000");

    // #when
    await confirm(challenge);

    // #then
    expect((await auditOf("salary.amount_changed"))[0]).toMatchObject({
      actor_id: company.admin.id,
      entity_id: salary.id,
      before: { amountKes: "5000000" },
      after: { amountKes: "6500000", approvalId: challenge.challengeId },
    });
  });

  it("emails every active admin, and nobody else", async () => {
    // #given another active admin, an invited admin and an employee
    const secondAdmin = await createUser(db);
    await addMember(db, company, secondAdmin, { role: "admin" });
    const invitedAdmin = await createUser(db);
    await addMember(db, company, invitedAdmin, {
      role: "admin",
      status: "invited",
    });
    const salary = await createSalary();
    const challenge = await requestChange(salary.id, "65,000");

    // #when
    await confirm(challenge);

    // #then
    expect(
      email.state.sent.map((message) => [message.to, message.subject]).sort(),
    ).toEqual(
      [
        [company.admin.email, "Salary changed for Amina Wanjiru"],
        [secondAdmin.email, "Salary changed for Amina Wanjiru"],
      ].sort(),
    );
  });

  it("says what it was and what it is in the email", async () => {
    // #given
    const salary = await createSalary();

    // #when
    await confirm(await requestChange(salary.id, "65,000.50"));

    // #then
    expect(email.state.sent[0]?.text).toContain(
      "It was KES 50,000.00 and is now KES 65,000.50.",
    );
  });

  it("refuses a change other than the one the passkey confirmed", async () => {
    // #given
    const salary = await createSalary();
    const challenge = await requestChange(salary.id, "65,000");

    // #when
    const response = await confirm(challenge, {
      salaryId: salary.id,
      amountKesCents: "99900000",
    });

    // #then
    expect({
      status: response.status,
      amountKes: (await readSalary(db, company, salary.id)).amountKes,
      emails: email.state.sent.length,
    }).toEqual({ status: 403, amountKes: 5_000_000n, emails: 0 });
  });

  it("uses each confirmation once", async () => {
    // #given
    const salary = await createSalary();
    const challenge = await requestChange(salary.id, "65,000");
    await confirm(challenge);

    // #when
    const again = await confirm(challenge);

    // #then
    expect(again.status).toBe(403);
  });

  it("refuses the amount it already is", async () => {
    // #given
    const salary = await createSalary();

    // #when
    const response = await send("POST", `${base()}/${salary.id}/amount`, {
      amountKes: "50,000",
    });

    // #then
    expect(response.status).toBe(400);
  });
});

describe("POST /organizations/:id/salaries/:salaryId/end", () => {
  it("takes them off payroll for good", async () => {
    // #given
    const salary = await createSalary();

    // #when
    const ended = await dataOf(
      await send("POST", `${base()}/${salary.id}/end`),
      salarySchema,
    );

    // #then
    expect([ended.state, ended.nextPayDate]).toEqual(["ended", null]);
  });

  it("can't change or end an ended salary", async () => {
    // #given
    const salary = await createSalary();
    await send("POST", `${base()}/${salary.id}/end`);

    // #when
    const responses = await Promise.all([
      send("POST", `${base()}/${salary.id}/end`),
      send("PATCH", `${base()}/${salary.id}`, { payDay: 3 }),
      send("POST", `${base()}/${salary.id}/amount`, { amountKes: "1" }),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      409, 409, 409,
    ]);
  });

  it("lets them be put on payroll again afterwards", async () => {
    // #given
    const salary = await createSalary();
    await send("POST", `${base()}/${salary.id}/end`);

    // #when
    const response = await send("POST", base(), salaryRequest());

    // #then
    expect(response.status).toBe(201);
  });
});

describe("salaries are for admins only", () => {
  const routes = [
    ["GET", "/"],
    ["GET", "/00000000-0000-4000-8000-000000000000"],
    ["POST", "/"],
    ["PATCH", "/00000000-0000-4000-8000-000000000000"],
    ["POST", "/00000000-0000-4000-8000-000000000000/amount"],
    ["POST", "/amount-changes/00000000-0000-4000-8000-000000000000/confirm"],
    ["POST", "/00000000-0000-4000-8000-000000000000/end"],
  ] as const;

  it.each(routes)("an employee gets 403 from %s %s", async (method, path) => {
    // #given the employee who is on payroll
    await createSalary();

    // #when
    const response = await send(
      method,
      `${base()}${path === "/" ? "" : path}`,
      method === "GET" ? undefined : salaryRequest(),
      person.user,
    );

    // #then
    expect(response.status).toBe(403);
  });
});

describe("company isolation", () => {
  it.each([
    ["GET", ""],
    ["GET", "/00000000-0000-4000-8000-000000000000"],
    ["POST", ""],
    ["PATCH", "/00000000-0000-4000-8000-000000000000"],
    ["POST", "/00000000-0000-4000-8000-000000000000/amount"],
    ["POST", "/amount-changes/00000000-0000-4000-8000-000000000000/confirm"],
    ["POST", "/00000000-0000-4000-8000-000000000000/end"],
  ])("company A's admin can't use company B's %s %s", async (method, path) => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/salaries${path}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: "{}" }),
      },
    }));
  });
});
