import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  PayrollRunDetail,
  PayrollRunPayment,
} from "@expendi-business/shared";
import {
  payeeChangeHoldSchema,
  payrollMarginChallengeSchema,
  payrollMarginSchema,
  payrollRunDetailSchema,
  payrollRunPaymentSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { organizations, payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeEmailSender,
  makeFakePaycrest,
  makeFakePrivyWallets,
  signPaycrestBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { ageDetailsChange } from "../helpers/payees.js";
import { createPayingCompany, readPayout, USDC } from "../helpers/payouts.js";
import {
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let paying: PayingCompany;
let categoryId: string;
let runId: string;

/** 23 Nov in Nairobi: 28 Nov's run is drafted. */
const NOV_23_EAT = new Date("2026-11-22T21:00:00Z");

/** KES 60,000 + 40,000 + 50,000: a cap of KES 180,000 at the default 20%. */
const PEOPLE = [
  ["Amina Wanjiru", 6_000_000n],
  ["Brian Otieno", 4_000_000n],
  ["Chao Mutua", 5_000_000n],
] as const;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    emailSender: email.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

/** A company with these people on payroll, its 28 Nov run drafted. */
async function seedPayroll(
  people: readonly (readonly [string, bigint])[] = PEOPLE,
): Promise<void> {
  paying = await createPayingCompany(runtime, db, 20_000n * USDC);
  categoryId = await addCategory(db, paying.company, "Salaries");
  for (const [name, amountKes] of people) {
    const payeeId = await insertPersonnelPayee(db, paying.company, name);
    await insertSalary(db, paying.company, {
      payeeId,
      categoryId,
      amountKes,
    });
  }
  await runtime.runPromise(
    draftDuePayroll(paying.company.organizationId, NOV_23_EAT),
  );
  const [run] = await runsOf(db, paying.company);
  if (!run) throw new Error("no run drafted");
  runId = run.id;
}

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  email.state.reset();
  await seedPayroll();
});

const admin = () => paying.company.admin;
const runPath = (company: TestCompany = paying.company, id = runId) =>
  `/organizations/${company.organizationId}/payroll-runs/${id}`;

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { message: string; details?: Record<string, unknown> };
  };
  return body.error;
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Payment extends Omit<PayrollRunPayment, "options"> {
  readonly options: SignOptions;
}

async function parsePayment(response: Response): Promise<Payment> {
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    ...payrollRunPaymentSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

function prepare(body?: unknown, user: TestUser = admin()): Promise<Response> {
  return sendJson(app, `${runPath()}/payment`, user, { method: "POST", body });
}

function retry(
  billId: string,
  body?: unknown,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, `${runPath()}/payments/${billId}/retry`, user, {
    method: "POST",
    body,
  });
}

function confirm(payment: Payment, user: TestUser = admin()) {
  return sendJson(
    app,
    `${runPath()}/payment/${payment.challengeId}/confirm`,
    user,
    {
      method: "POST",
      body: { response: paying.passkey.sign(payment.options, TEST_ORIGIN) },
    },
  );
}

async function paid(payment: Payment): Promise<PayrollRunDetail> {
  const response = await confirm(payment);
  expect(response.status).toBe(200);
  return payrollRunDetailSchema.parse(await dataOf(response));
}

async function readRun(): Promise<PayrollRunDetail> {
  const response = await sendJson(app, runPath(), admin());
  return payrollRunDetailSchema.parse(await dataOf(response));
}

async function payoutsOf(billId: string): Promise<Payout[]> {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select()
        .from(payouts)
        .where(
          and(eq(payouts.subjectType, "bill"), eq(payouts.subjectId, billId)),
        )
        .orderBy(asc(payouts.subjectPart), asc(payouts.createdAt)),
  );
}

const billIds = async () =>
  (await billsOfRun(db, paying.company, runId)).map((bill) => bill.id);

const moneyMoved = () => ({
  orders: paycrest.state.created.length,
  sends: privy.state.sends.length,
});

async function settle(payout: Payout, status = "settled"): Promise<void> {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, {
    ...order,
    status,
    paymentReference: null,
  });
  const body = JSON.stringify({
    event: "payment_order.settled",
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

/** Settles every payout of the run still being paid. */
async function settleAll(): Promise<void> {
  for (const billId of await billIds()) {
    for (const payout of await payoutsOf(billId)) {
      if (payout.status === "paying") await settle(payout);
    }
  }
}

describe("POST /organizations/:id/payroll-runs/:runId/payment", () => {
  it("previews each person, the total and the cap, with one passkey challenge", async () => {
    // #when
    const payment = await parsePayment(await prepare());

    // #then
    const ids = await billIds();
    const keys = (
      await Promise.all(ids.map(async (id) => (await payoutsOf(id))[0]))
    ).map((payout) => [
      payout?.idempotencyKey,
      payout?.payrollRunId,
      payout?.status,
    ]);
    expect({
      people: payment.people
        .map((person) => [person.payeeName, person.amountKes, person.orders])
        .sort(),
      total: payment.totals.receivesKes,
      cap: payment.cap,
      keys: keys.sort(),
      ...moneyMoved(),
    }).toEqual({
      people: [
        ["Amina Wanjiru", "6000000", 1],
        ["Brian Otieno", "4000000", 1],
        ["Chao Mutua", "5000000", 1],
      ],
      total: "15000000",
      cap: { capKes: "18000000", committedKes: "0", withinCap: true },
      keys: ids
        .map((id) => [`payroll:${id}:1`, runId, "awaiting_approval"])
        .sort(),
      orders: 0,
      sends: 0,
    });
  });

  it("pays each of 3 people once under one passkey, and the run follows them", async () => {
    // #given
    const payment = await parsePayment(await prepare());

    // #when
    const afterApproval = await paid(payment);
    await settleAll();

    // #then
    const run = await readRun();
    expect({
      afterApproval: [afterApproval.status, afterApproval.progress],
      ...moneyMoved(),
      settled: [run.status, run.progress],
      payoutsEach: await Promise.all(
        (await billIds()).map(async (id) => (await payoutsOf(id)).length),
      ),
      approvedBy: (await runsOf(db, paying.company))[0]?.approvedBy,
    }).toEqual({
      afterApproval: ["paying", { paid: 0, paying: 3, failed: 0 }],
      orders: 3,
      sends: 3,
      settled: ["paid", { paid: 3, paying: 0, failed: 0 }],
      payoutsEach: [1, 1, 1],
      approvedBy: admin().id,
    });
  });

  it("retries one failed person without paying anyone else again", async () => {
    // #given one of the three fails
    privy.state.nextSends("sent", "refused", "sent");
    await paid(await parsePayment(await prepare()));
    await settleAll();
    const failed = (await billsOfRun(db, paying.company, runId)).find(
      (bill) => bill.status === "payout_failed",
    );
    if (!failed) throw new Error("nobody failed");
    const partly = await readRun();

    // #when
    const again = await parsePayment(await retry(failed.id));
    await paid(again);
    await settleAll();

    // #then
    const run = await readRun();
    expect({
      partly: [partly.status, partly.progress],
      retried: again.people.map((person) => person.billId),
      ...moneyMoved(),
      run: [run.status, run.progress],
      failedPayouts: (await payoutsOf(failed.id)).map((payout) => [
        payout.status,
        payout.idempotencyKey,
      ]),
      othersPaidOnce: await Promise.all(
        (await billIds())
          .filter((id) => id !== failed.id)
          .map(async (id) => (await payoutsOf(id)).length),
      ),
    }).toEqual({
      partly: ["partly_failed", { paid: 2, paying: 0, failed: 1 }],
      retried: [failed.id],
      orders: 4,
      sends: 3,
      run: ["paid", { paid: 3, paying: 0, failed: 0 }],
      failedPayouts: [
        ["failed", `payroll:${failed.id}:1`],
        ["paid", `payroll:${failed.id}:2`],
      ],
      othersPaidOnce: [1, 1],
    });
  });

  it("refuses a run over its cap, sending nothing", async () => {
    // #given a KES 40,000 bonus: KES 190,000 against a KES 180,000 cap
    const [someone] = await billsOfRun(db, paying.company, runId);
    const bonus = await sendJson(app, `${runPath()}/one-offs`, admin(), {
      method: "POST",
      body: {
        payeeId: someone?.payeeId,
        amountKes: "40,000",
        reason: "Year-end bonus",
      },
    });
    expect(bonus.status).toBe(201);
    const payment = await parsePayment(await prepare());

    // #when
    const response = await confirm(payment);

    // #then
    expect({
      withinCap: payment.cap.withinCap,
      status: response.status,
      message: (await errorOf(response)).message,
      ...moneyMoved(),
      run: (await readRun()).status,
    }).toEqual({
      withinCap: false,
      status: 409,
      message:
        "This payroll run is over its cap: the active salaries plus the margin.",
      orders: 0,
      sends: 0,
      run: "draft",
    });
  });

  it("asks for a second confirmation for someone whose details just changed", async () => {
    // #given
    const [someone] = await billsOfRun(db, paying.company, runId);
    if (!someone) throw new Error("no payment");
    await ageDetailsChange(db, paying.company, someone.payeeId, 1);

    // #when
    const held = await prepare();
    const confirmed = await prepare({ secondConfirmation: true });

    // #then
    expect(held.status).toBe(409);
    expect(
      payeeChangeHoldSchema.parse((await errorOf(held)).details).payees,
    ).toMatchObject([{ payeeId: someone.payeeId }]);
    expect(confirmed.status).toBe(201);
  });

  it("refuses a run that's already approved", async () => {
    // #given
    await paid(await parsePayment(await prepare()));

    // #when
    const response = await prepare();

    // #then
    expect({ status: response.status, ...moneyMoved() }).toEqual({
      status: 409,
      orders: 3,
      sends: 3,
    });
  });

  it("prepares again after a change to the draft, discarding the stale payout", async () => {
    // #given
    const first = await parsePayment(await prepare());
    const [someone] = await billsOfRun(db, paying.company, runId);
    if (!someone) throw new Error("no payment");
    const adjusted = await sendJson(
      app,
      `${runPath()}/payments/${someone.id}`,
      admin(),
      {
        method: "PATCH",
        body: { amountKes: "45,000", reason: "Unpaid leave" },
      },
    );
    expect(adjusted.status).toBe(200);

    // #when
    const stale = await confirm(first);
    const fresh = await parsePayment(await prepare());
    await paid(fresh);

    // #then
    expect({
      stale: stale.status,
      payouts: (await payoutsOf(someone.id)).map((payout) => [
        payout.status,
        payout.requestedKesCents,
        payout.idempotencyKey,
      ]),
    }).toEqual({
      stale: 409,
      payouts: [
        ["failed", someone.amountKes, `payroll:${someone.id}:1`],
        ["paying", 4_500_000n, `payroll:${someone.id}:2`],
      ],
    });
  });
});

describe("retrying one person", () => {
  it("refuses someone whose payment hasn't failed", async () => {
    // #given
    await paid(await parsePayment(await prepare()));
    const [someone] = await billIds();

    // #when
    const response = await retry(someone ?? "");

    // #then
    expect({ status: response.status, ...moneyMoved() }).toEqual({
      status: 409,
      orders: 3,
      sends: 3,
    });
  });
});

describe("a salary above Paycrest's largest order (spec §7.5)", () => {
  /** KES 500,000.50: two orders, KES 250,001 and KES 249,999.50. */
  const BIG = 50_000_050n;

  beforeEach(async () => {
    await seedPayroll([["Dana Kimani", BIG]]);
  });

  it("is paid as two orders under one approval, and is paid once both are", async () => {
    // #given
    const [billId = ""] = await billIds();
    const payment = await parsePayment(await prepare());

    // #when
    await paid(payment);
    const [first, second] = await payoutsOf(billId);
    if (!first || !second) throw new Error("not split");
    await settle(first);
    const afterOne = (await billsOfRun(db, paying.company, runId))[0]?.status;
    await settle(second);

    // #then
    const run = await readRun();
    expect({
      person: [payment.people[0]?.orders, payment.people[0]?.amountKes],
      parts: [first, second].map((payout) => [
        payout.subjectPart,
        payout.requestedKesCents,
        payout.idempotencyKey,
      ]),
      ...moneyMoved(),
      afterOne,
      run: [run.status, run.payments[0]?.status],
    }).toEqual({
      person: [2, BIG.toString()],
      parts: [
        [1, 25_000_100n, `payroll:${billId}:1:part1`],
        [2, 24_999_950n, `payroll:${billId}:1:part2`],
      ],
      orders: 2,
      sends: 2,
      afterOne: "paying",
      run: ["paid", "paid"],
    });
  });

  it("retries only the part that failed", async () => {
    // #given the second part fails
    const [billId = ""] = await billIds();
    privy.state.nextSends("sent", "refused");
    await paid(await parsePayment(await prepare()));
    await settleAll();
    const failedRun = await readRun();

    // #when
    const again = await parsePayment(await retry(billId));
    await paid(again);
    await settleAll();

    // #then
    const payoutsNow = await payoutsOf(billId);
    expect({
      failedRun: [failedRun.status, failedRun.payments[0]?.status],
      retried: [again.people[0]?.orders, again.people[0]?.amountKes],
      ...moneyMoved(),
      paidParts: payoutsNow
        .filter((payout) => payout.status === "paid")
        .map((payout) => payout.subjectPart)
        .sort(),
      run: (await readRun()).status,
    }).toEqual({
      failedRun: ["partly_failed", "payout_failed"],
      retried: [
        1,
        payoutsNow
          .find((p) => p.status === "failed")
          ?.requestedKesCents.toString(),
      ],
      orders: 3,
      sends: 2,
      paidParts: [1, 2],
      run: "paid",
    });
  });
});

describe("the payroll margin (spec §7.4)", () => {
  const marginPath = (company: TestCompany = paying.company) =>
    `/organizations/${company.organizationId}/settings/payroll-margin`;

  async function requestMargin(marginPct: number) {
    const response = await sendJson(app, marginPath(), admin(), {
      method: "POST",
      body: { marginPct },
    });
    expect(response.status).toBe(200);
    const data = await dataOf(response);
    return {
      ...payrollMarginChallengeSchema.parse(data),
      options: (data as { options: SignOptions }).options,
    };
  }

  const confirmMargin = (
    challenge: Awaited<ReturnType<typeof requestMargin>>,
    change: { marginPct: number } = challenge.change,
    signer: SoftwarePasskey = paying.passkey,
  ) =>
    sendJson(app, `${marginPath()}/${challenge.challengeId}/confirm`, admin(), {
      method: "POST",
      body: {
        change,
        response: signer.sign(challenge.options, TEST_ORIGIN),
      },
    });

  const storedMargin = async () => {
    const [company] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ marginPct: organizations.payrollCapMarginPct })
          .from(organizations)
          .where(eq(organizations.id, paying.company.organizationId)),
    );
    return company?.marginPct;
  };

  it("changes only once the passkey confirms it, re-caps the draft run, is audited and emails every admin", async () => {
    // #given another admin
    const second = await createUser(db);
    await addMember(db, paying.company, second, { role: "admin" });
    const challenge = await requestMargin(30);
    const pending = await storedMargin();

    // #when
    const response = await confirmMargin(challenge);

    // #then
    const { rows } = await owner.query<{ before: unknown; after: unknown }>(
      "SELECT before, after FROM audit_log WHERE entity_id = $1 AND action = 'organization.payroll_margin_changed'",
      [paying.company.organizationId],
    );
    expect({
      status: response.status,
      body: payrollMarginSchema.parse(await dataOf(response)),
      pending,
      stored: await storedMargin(),
      cap: (await readRun()).capKes,
      audited: rows.map((row) => [row.before, row.after]),
      emails: email.state.sent.map((message) => message.to).sort(),
    }).toEqual({
      status: 200,
      body: { marginPct: 30 },
      pending: 20,
      stored: 30,
      cap: "19500000",
      audited: [
        [
          { payrollCapMarginPct: 20 },
          { payrollCapMarginPct: 30, approvalId: challenge.challengeId },
        ],
      ],
      emails: [admin().email, second.email].sort(),
    });
  });

  it("refuses a margin other than the one the passkey confirmed", async () => {
    // #given
    const challenge = await requestMargin(30);

    // #when
    const response = await confirmMargin(challenge, { marginPct: 100 });

    // #then
    expect({
      status: response.status,
      stored: await storedMargin(),
      emails: email.state.sent.length,
    }).toEqual({ status: 403, stored: 20, emails: 0 });
  });

  it("refuses a confirmation not signed by the admin's passkey", async () => {
    // #given
    const challenge = await requestMargin(30);
    const stranger = (await createPayingCompany(runtime, db)).passkey;

    // #when
    const response = await confirmMargin(challenge, challenge.change, stranger);

    // #then
    expect({ status: response.status, stored: await storedMargin() }).toEqual({
      status: 403,
      stored: 20,
    });
  });

  it("lets a raised margin pay a run that was over its cap", async () => {
    // #given a KES 40,000 bonus over the KES 180,000 cap, then a 30% margin
    const [someone] = await billsOfRun(db, paying.company, runId);
    await sendJson(app, `${runPath()}/one-offs`, admin(), {
      method: "POST",
      body: {
        payeeId: someone?.payeeId,
        amountKes: "40,000",
        reason: "Year-end bonus",
      },
    });
    await confirmMargin(await requestMargin(30));

    // #when
    const response = await confirm(await parsePayment(await prepare()));

    // #then
    expect({ status: response.status, ...moneyMoved() }).toEqual({
      status: 200,
      orders: 4,
      sends: 4,
    });
  });

  it("shows the current margin to admins", async () => {
    // #when
    const response = await sendJson(app, marginPath(), admin());

    // #then
    expect(payrollMarginSchema.parse(await dataOf(response))).toEqual({
      marginPct: 20,
    });
  });
});

describe("who can", () => {
  async function employee(): Promise<TestUser> {
    const user = await createUser(db);
    await addMember(db, paying.company, user);
    return user;
  }

  it("refuses employees every payroll payment and margin route", async () => {
    // #given
    const payment = await parsePayment(await prepare());
    const staff = await employee();
    const [someone = ""] = await billIds();
    const settings = `/organizations/${paying.company.organizationId}/settings/payroll-margin`;

    // #when
    const responses = await Promise.all([
      prepare(undefined, staff),
      confirm(payment, staff),
      retry(someone, undefined, staff),
      sendJson(app, settings, staff),
      sendJson(app, settings, staff, {
        method: "POST",
        body: { marginPct: 50 },
      }),
      sendJson(app, `${settings}/${randomUUID()}/confirm`, staff, {
        method: "POST",
        body: { change: { marginPct: 50 }, response: {} },
      }),
    ]);

    // #then
    expect({
      statuses: responses.map((response) => response.status),
      ...moneyMoved(),
    }).toEqual({
      statuses: [403, 403, 403, 403, 403, 403],
      orders: 0,
      sends: 0,
    });
  });

  it("answers 404 for another company's run and an unknown approval", async () => {
    // #given
    const ours = { runId, paying };
    await seedPayroll();
    const theirs = runId;
    ({ runId, paying } = ours);
    const payment = await parsePayment(await prepare());

    // #when
    const responses = await Promise.all([
      sendJson(app, `${runPath(paying.company, theirs)}/payment`, admin(), {
        method: "POST",
      }),
      confirm({ ...payment, challengeId: randomUUID() }),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([404, 404]);
  });

  it("keeps every route to its own company", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    const post = (payload: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    const id = randomUUID();

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/payroll-runs/${id}/payment`,
      init: post({}),
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/payroll-runs/${id}/payment/${randomUUID()}/confirm`,
      init: post({ response: {} }),
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/payroll-runs/${id}/payments/${randomUUID()}/retry`,
      init: post({}),
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/settings/payroll-margin`,
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/settings/payroll-margin`,
      init: post({}),
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/settings/payroll-margin/${randomUUID()}/confirm`,
      init: post({}),
    }));
  });
});

describe("salary privacy", () => {
  it("hides the run's payouts from employees, and shows each person only their own", async () => {
    // #given
    await paid(await parsePayment(await prepare()));
    const [first] = await billIds();
    const payout = (await payoutsOf(first ?? ""))[0];
    if (!payout) throw new Error("no payout");
    const staff = await createUser(db);
    await addMember(db, paying.company, staff);

    // #when
    const seen = await runInScope(
      db,
      {
        organizationId: paying.company.organizationId,
        userId: staff.id,
        role: "employee",
      },
      (tx) =>
        tx
          .select({ id: payouts.id })
          .from(payouts)
          .where(eq(payouts.payrollRunId, runId)),
    );

    // #then
    expect({
      seen,
      payoutStillThere: (await readPayout(db, paying.company, payout.id)).id,
    }).toEqual({ seen: [], payoutStillThere: payout.id });
  });
});
