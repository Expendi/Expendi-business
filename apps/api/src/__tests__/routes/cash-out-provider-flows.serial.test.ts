import { and, asc, eq, sql } from "drizzle-orm";
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

import type { PayrollRunPayment } from "@expendi-business/shared";
import {
  billPaymentSchema,
  claimApprovalSchema,
  payrollRunPaymentSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { MAX_KES_PER_ORDER_CENTS } from "../../services/payroll/split.js";
import { insertBill, insertPayee, readBill } from "../helpers/bills.js";
import { claimFlow } from "../helpers/claim-flow.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePretium,
  makeFakePrivyWallets,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import { createPayingCompany, readPayout, USDC } from "../helpers/payouts.js";
import {
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Each way of paying asks for approval again after a cash-out provider
 * change refused one: the next request prepares under the provider now
 * active instead of handing back the payment it refused. Changes the
 * platform-wide setting, so it runs on its own (vitest.serial.config.ts).
 */
const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let staff: TestStaff;
let paying: PayingCompany;

const NEUTRAL = /paycrest|pretium/i;
const CASH_OUT_UNAVAILABLE =
  "Some of these payments can't be sent the way they were prepared any more. Nothing was sent. Start again to prepare them afresh.";

/** 23 Nov in Nairobi: 28 Nov's run is drafted. */
const NOV_23_EAT = new Date("2026-11-22T21:00:00Z");

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    pretium: pretium.layer,
    fileStorage: storage.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  staff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await setProvider("paycrest");
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  pretium.state.reset();
  await setProvider("paycrest");
  paying = await createPayingCompany(runtime, db, 20_000n * USDC);
});

afterEach(async () => {
  await setProvider("paycrest");
});

async function setProvider(provider: "paycrest" | "pretium"): Promise<void> {
  await db.execute(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staff.staffUserId}::uuid, 'Provider test', 'req-e2-flows', '203.0.113.9', 'e2-test')`,
  );
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

async function bodyOf(response: Response) {
  return (await response.json()) as {
    data?: unknown;
    error?: { message: string };
  };
}

const moneyMoved = () => ({
  orders: paycrest.state.created.length,
  pretium: pretium.state.payRequests.length,
  sends: privy.state.sends.length,
});

describe("a claim refused at approval by a provider change", () => {
  it("is prepared again under the active provider when the admin asks again", async () => {
    // #given a KES 260,000 claim, prepared while Paycrest was active
    const flow = claimFlow({ app, db, storage, paycrest }, paying);
    const { user } = await flow.employee();
    const claim = await flow.submit(user, "260,000");
    const first = await sendJson(
      app,
      `${flow.claimsPath}/approval`,
      paying.company.admin,
      { method: "POST", body: { claimIds: [claim.id] } },
    );
    expect(first.status).toBe(201);
    const data = (await bodyOf(first)).data;
    const approval = claimApprovalSchema.parse(data);
    const options = (data as { options: SignOptions }).options;
    const stale = approval.claims[0]?.payoutId ?? "";
    await setProvider("pretium");

    // #when the admin confirms, then asks again
    const confirmed = await sendJson(
      app,
      `${flow.claimsPath}/approval/${approval.challengeId}/confirm`,
      paying.company.admin,
      {
        method: "POST",
        body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
      },
    );
    const refusal = await bodyOf(confirmed);
    const again = await sendJson(
      app,
      `${flow.claimsPath}/approval`,
      paying.company.admin,
      { method: "POST", body: { claimIds: [claim.id] } },
    );
    const second = await bodyOf(again);

    // #then the stale payment is withdrawn, and the new request is priced
    // under Pretium, which can't send KES 260,000 at once
    expect({
      confirmed: confirmed.status,
      again: again.status,
      stale: (await readPayout(db, paying.company, stale)).status,
      ...moneyMoved(),
    }).toEqual({
      confirmed: 409,
      again: 400,
      stale: "failed",
      orders: 0,
      pretium: 0,
      sends: 0,
    });
    expect(refusal.error?.message).not.toMatch(NEUTRAL);
    expect(second.error?.message).toBe(
      "A single payment can send at most KES 250,000.00. Split it into smaller payments.",
    );
  });
});

describe("a bill and the active provider", () => {
  async function bankBill(bankCode: string): Promise<string> {
    const payeeId = await insertPayee(db, paying.company, {
      name: "Acme Supplies Ltd",
      method: "bank",
      bankCode,
      bankAccountNumber: "0123456789",
      accountName: "Acme Supplies Ltd",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });
    return insertBill(db, paying.company, {
      payeeId,
      categoryId: await addCategory(db, paying.company, "Supplies"),
      amountKes: 250_000n,
      dueOn: "2026-11-13",
      status: "due",
    });
  }

  const billsPath = () =>
    `/organizations/${paying.company.organizationId}/bills`;

  async function prepareBill(billId: string) {
    const response = await sendJson(
      app,
      `${billsPath()}/payment`,
      paying.company.admin,
      { method: "POST", body: { billIds: [billId] } },
    );
    const body = await bodyOf(response);
    return { status: response.status, body };
  }

  it("hands back the same Pretium payment when asked again under Pretium", async () => {
    // #given
    await setProvider("pretium");
    const billId = await bankBill("EQBLKENA");

    // #when
    const first = await prepareBill(billId);
    const second = await prepareBill(billId);

    // #then
    const payoutIdOf = (body: { data?: unknown }) =>
      billPaymentSchema.parse(body.data).bills[0]?.payoutId;
    expect([first.status, second.status]).toEqual([201, 201]);
    expect(payoutIdOf(second.body)).toBe(payoutIdOf(first.body));
  });

  it("is refused at approval for a bank Pretium can't pay, then refused again when asked for under Pretium", async () => {
    // #given a Prime Bank bill prepared while Paycrest was active
    const billId = await bankBill("PRIEKENX");
    const first = await prepareBill(billId);
    expect(first.status).toBe(201);
    const data = first.body.data;
    const payment = billPaymentSchema.parse(data);
    const options = (data as { options: SignOptions }).options;
    await setProvider("pretium");

    // #when
    const confirmed = await sendJson(
      app,
      `${billsPath()}/payment/${payment.challengeId}/confirm`,
      paying.company.admin,
      {
        method: "POST",
        body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
      },
    );
    const again = await prepareBill(billId);

    // #then
    expect({
      confirmed: confirmed.status,
      again: again.status,
      message: again.body.error?.message,
      stale: (
        await readPayout(db, paying.company, payment.bills[0]?.payoutId ?? "")
      ).status,
      bill: (await readBill(db, paying.company, billId)).status,
      ...moneyMoved(),
    }).toEqual({
      confirmed: 409,
      again: 400,
      message:
        "That bank can't be paid right now. Choose another bank or another way to pay.",
      stale: "failed",
      bill: "due",
      orders: 0,
      pretium: 0,
      sends: 0,
    });
  });
});

describe("payroll and the active provider", () => {
  let runId: string;

  async function seedPayroll(amountKes: bigint): Promise<string> {
    const categoryId = await addCategory(db, paying.company, "Salaries");
    const payeeId = await insertPersonnelPayee(
      db,
      paying.company,
      "Dana Kimani",
    );
    await insertSalary(db, paying.company, { payeeId, categoryId, amountKes });
    await runtime.runPromise(
      draftDuePayroll(paying.company.organizationId, NOV_23_EAT),
    );
    const [run] = await runsOf(db, paying.company);
    if (!run) throw new Error("no run drafted");
    runId = run.id;
    const [bill] = await billsOfRun(db, paying.company, runId);
    if (!bill) throw new Error("no bill in the run");
    return bill.id;
  }

  const admin = (): TestUser => paying.company.admin;
  const runPath = () =>
    `/organizations/${paying.company.organizationId}/payroll-runs/${runId}`;

  async function prepare(): Promise<
    Omit<PayrollRunPayment, "options"> & { options: SignOptions }
  > {
    const response = await sendJson(app, `${runPath()}/payment`, admin(), {
      method: "POST",
    });
    expect(response.status).toBe(201);
    const data = (await bodyOf(response)).data;
    return {
      ...payrollRunPaymentSchema.parse(data),
      options: (data as { options: SignOptions }).options,
    };
  }

  const payoutsOf = (billId: string): Promise<Payout[]> =>
    runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
      tx
        .select()
        .from(payouts)
        .where(
          and(eq(payouts.subjectType, "bill"), eq(payouts.subjectId, billId)),
        )
        .orderBy(asc(payouts.subjectPart), asc(payouts.createdAt)),
    );

  it.each([
    ["Paycrest", "paycrest", 28_000_000n, [28_000_000n]],
    ["Pretium", "pretium", 28_000_000n, [14_000_000n, 14_000_000n]],
    [
      "Paycrest",
      "paycrest",
      60_000_000n,
      [MAX_KES_PER_ORDER_CENTS, MAX_KES_PER_ORDER_CENTS],
    ],
    [
      "Pretium",
      "pretium",
      60_000_000n,
      [20_000_000n, 20_000_000n, 20_000_000n],
    ],
  ] as const)(
    "splits a salary by %s's largest cash-out (%s, %s KES cents)",
    async (_name, provider, salary, parts) => {
      // #given
      const billId = await seedPayroll(salary);
      await setProvider(provider);

      // #when
      const payment = await prepare();

      // #then
      expect({
        orders: payment.people[0]?.orders,
        parts: (await payoutsOf(billId)).map((payout) => [
          payout.requestedKesCents,
          payout.provider,
        ]),
      }).toEqual({
        orders: parts.length,
        parts: parts.map((part) => [part, provider]),
      });
    },
  );

  it("approves a salary as Pretium split it, with the bill following", async () => {
    // #given KES 280,000 as two Pretium cash-outs
    await setProvider("pretium");
    const billId = await seedPayroll(28_000_000n);
    const payment = await prepare();

    // #when approved, stopping short of funding
    const approved = await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: admin().id,
        challengeId: payment.challengeId,
        response: paying.passkey.sign(payment.options, TEST_ORIGIN),
      }),
    );

    // #then
    expect({
      approved: approved.map((payout) => [
        payout.subjectPart,
        payout.provider,
        payout.status,
      ]),
      bill: (await readBill(db, paying.company, billId)).status,
    }).toEqual({
      approved: [
        [1, "pretium", "approved"],
        [2, "pretium", "approved"],
      ],
      bill: "paying",
    });
  });

  it("prepares a split salary again instead of moving its parts to another provider", async () => {
    // #given KES 600,000 as three Pretium cash-outs, then Paycrest is active
    await setProvider("pretium");
    const billId = await seedPayroll(60_000_000n);
    const payment = await prepare();
    await setProvider("paycrest");

    // #when the admin confirms, then asks again
    const confirmed = await sendJson(
      app,
      `${runPath()}/payment/${payment.challengeId}/confirm`,
      admin(),
      {
        method: "POST",
        body: {
          response: paying.passkey.sign(payment.options, TEST_ORIGIN),
        },
      },
    );
    const refusal = await bodyOf(confirmed);
    const again = await prepare();

    // #then
    expect({
      confirmed: confirmed.status,
      message: refusal.error?.message,
      parts: again.people[0]?.orders,
      awaiting: (await payoutsOf(billId))
        .filter((payout) => payout.status === "awaiting_approval")
        .map((payout) => [payout.requestedKesCents, payout.provider]),
      failed: (await payoutsOf(billId)).filter(
        (payout) => payout.status === "failed",
      ).length,
      ...moneyMoved(),
    }).toEqual({
      confirmed: 409,
      message: CASH_OUT_UNAVAILABLE,
      parts: 2,
      awaiting: [
        [MAX_KES_PER_ORDER_CENTS, "paycrest"],
        [MAX_KES_PER_ORDER_CENTS, "paycrest"],
      ],
      failed: 3,
      orders: 0,
      pretium: 0,
      sends: 0,
    });
  });

  it("prepares a salary again, split for Pretium, after Pretium refused Paycrest's single cash-out", async () => {
    // #given KES 280,000 as one Paycrest cash-out, then Pretium is active
    const billId = await seedPayroll(28_000_000n);
    const payment = await prepare();
    await setProvider("pretium");

    // #when the admin confirms, then asks again
    const confirmed = await sendJson(
      app,
      `${runPath()}/payment/${payment.challengeId}/confirm`,
      admin(),
      {
        method: "POST",
        body: {
          response: paying.passkey.sign(payment.options, TEST_ORIGIN),
        },
      },
    );
    const again = await prepare();

    // #then
    expect({
      confirmed: confirmed.status,
      parts: again.people[0]?.orders,
      payouts: (await payoutsOf(billId)).map((payout) => [
        payout.subjectPart,
        payout.status,
        payout.provider,
      ]),
      ...moneyMoved(),
    }).toEqual({
      confirmed: 409,
      parts: 2,
      payouts: [
        [1, "failed", "paycrest"],
        [1, "awaiting_approval", "pretium"],
        [2, "awaiting_approval", "pretium"],
      ],
      orders: 0,
      pretium: 0,
      sends: 0,
    });
  });
});
