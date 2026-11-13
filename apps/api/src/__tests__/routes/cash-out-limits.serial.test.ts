import { eq, sql } from "drizzle-orm";
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

import type {
  CreateBillRequest,
  CreateRecurringItemRequest,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  walletResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { bills } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import { createNextRecurringBill } from "../../services/recurring/next-bill.js";
import { insertPayee, shiftDays } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  makeFakePaycrest,
  makeFakePretium,
  randomAddress,
} from "../helpers/fakes.js";
import { allowlistAddress, createPayingCompany } from "../helpers/payouts.js";
import {
  billsOfRun,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { billsOfItem, insertRecurringItem } from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * A KES amount one cash-out couldn't send is refused when it's saved, for
 * the cash-out provider active then, and the wallet states the range.
 * Changes the platform-wide setting, so it runs on its own
 * (vitest.serial.config.ts).
 */
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let staff: TestStaff;
let paying: PayingCompany;
let categoryId: string;
let tillPayeeId: string;
let today: string;

const NEUTRAL = /paycrest|pretium/i;
const BELOW_20 = "The smallest amount that can be sent is KES 20.";
const ABOVE_250K =
  "A single payment can send at most KES 250,000.00. Split it into smaller payments.";
const ABOVE_300K =
  "A single payment can send at most KES 300,000.00. Split it into smaller payments.";
const OLD_CHANGE = new Date("2026-01-01T00:00:00Z");
/** 23 Nov in Nairobi: 28 Nov's payroll run is drafted. */
const NOV_23_EAT = new Date("2026-11-22T21:00:00Z");

/** Every customer-facing body this file saw, checked for provider names. */
const seen: string[] = [];

beforeAll(async () => {
  runtime = makeTestRuntime({
    paycrest: paycrest.layer,
    pretium: pretium.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  staff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await setProvider("paycrest");
  await Promise.all([runtime.dispose(), owner.end()]);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.filter((body) => NEUTRAL.test(body))).toEqual([]);
});

beforeEach(async () => {
  paycrest.state.reset();
  pretium.state.reset();
  await setProvider("pretium");
  paying = await createPayingCompany(runtime, db);
  categoryId = await addCategory(db, paying.company, "Utilities");
  tillPayeeId = await insertPayee(db, paying.company, {
    name: "Kenya Power",
    method: "mpesa_till",
    tillNumber: "123456",
    accountName: "Kenya Power",
    detailsChangedAt: OLD_CHANGE,
  });
  today = nairobiDate(new Date());
});

afterEach(async () => {
  await setProvider("paycrest");
});

async function setProvider(provider: "paycrest" | "pretium"): Promise<void> {
  await db.execute(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staff.staffUserId}::uuid, 'Limits test', 'req-limits', '203.0.113.9', 'limits-test')`,
  );
}

interface Answer {
  readonly status: number;
  readonly data?: unknown;
  readonly error?: { message: string; details?: unknown };
}

async function send(
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  const response = await sendJson(
    app,
    `/organizations/${paying.company.organizationId}${path}`,
    paying.company.admin,
    { method, body },
  );
  const text = await response.text();
  seen.push(text);
  return { status: response.status, ...(JSON.parse(text) as object) };
}

async function walletLimits() {
  const answer = await send("GET", "/wallet");
  const wallet = walletResponseSchema.parse(answer.data);
  if (wallet.status !== "active") throw new Error("wallet isn't active");
  return wallet.cashOutLimits;
}

const createBill = (overrides: Partial<CreateBillRequest> = {}) =>
  send("POST", "/bills", {
    payeeId: tillPayeeId,
    amountKes: "1,500",
    dueOn: shiftDays(today, 10),
    categoryId,
    ...overrides,
  } satisfies CreateBillRequest);

async function billId(overrides: Partial<CreateBillRequest> = {}) {
  const answer = await createBill(overrides);
  if (answer.status !== 201) {
    throw new Error(`create bill answered ${answer.status}`);
  }
  return billDetailSchema.parse(answer.data).id;
}

const outcome = ({ status, error }: Answer) => ({
  status,
  message: error?.message,
  details: error?.details,
});

const refused = (message: string) => ({
  status: 400,
  message,
  details: { field: "amountKes" },
});

const saved = (status = 201) => ({
  status,
  message: undefined,
  details: undefined,
});

const asAdmin = () => ({
  organizationId: paying.company.organizationId,
  userId: paying.company.admin.id,
  role: "admin" as const,
});

async function billCount(): Promise<number> {
  const rows = await runInScope(db, asAdmin(), (tx) =>
    tx
      .select({ id: bills.id })
      .from(bills)
      .where(eq(bills.organizationId, paying.company.organizationId)),
  );
  return rows.length;
}

describe("while one provider is active", () => {
  it("states its range on the wallet", async () => {
    expect(await walletLimits()).toEqual({
      minKesCents: "2000",
      maxKesCents: "25000000",
    });
  });

  it("refuses a KES 19 bill to a cash-out payee, and saves nothing", async () => {
    // #when
    const answer = await createBill({ amountKes: "19" });

    // #then
    expect({ ...outcome(answer), bills: await billCount() }).toEqual({
      ...refused(BELOW_20),
      bills: 0,
    });
  });

  it.each([
    ["KES 20", "20"],
    ["KES 250,000", "250,000"],
  ])("saves %s", async (_name, amountKes) => {
    expect(outcome(await createBill({ amountKes }))).toEqual(saved());
  });

  it("refuses KES 250,000.01", async () => {
    expect(outcome(await createBill({ amountKes: "250,000.01" }))).toEqual(
      refused(ABOVE_250K),
    );
  });
});

describe("bills that aren't sent as a cash-out", () => {
  it("doesn't limit a USDC payee", async () => {
    // #given
    const address = randomAddress().toLowerCase();
    await allowlistAddress(runtime, paying, address, "Vercel");
    const payeeId = await insertPayee(db, paying.company, {
      name: "Vercel Inc",
      method: "usdc",
      usdcChain: "base",
      usdcAddress: address,
      detailsChangedAt: OLD_CHANGE,
    });

    // #when
    const answer = await createBill({
      payeeId,
      amountKes: undefined,
      amountUsd: "0.10",
    });

    // #then
    expect(outcome(answer)).toEqual(saved());
  });

  it("doesn't limit a payee paid outside Expendi", async () => {
    // #given
    const payeeId = await insertPayee(db, paying.company, {
      method: "outside",
    });

    // #then
    expect(outcome(await createBill({ payeeId, amountKes: "19" }))).toEqual(
      saved(),
    );
  });

  it("doesn't limit a payee with no payment details yet", async () => {
    // #given
    const payeeId = await insertPayee(db, paying.company);

    // #then
    expect(outcome(await createBill({ payeeId, amountKes: "1" }))).toEqual(
      saved(),
    );
  });

  it("saves a variable bill with no amount yet", async () => {
    expect(
      outcome(await createBill({ variable: true, amountKes: undefined })),
    ).toEqual(saved());
  });
});

describe("changing a bill", () => {
  it("refuses changing a fixed amount to KES 19", async () => {
    // #given
    const id = await billId();

    // #when
    const answer = await send("PATCH", `/bills/${id}`, {
      amountKes: "19",
      adjustmentReason: "Credit note",
    });

    // #then
    expect(outcome(answer)).toEqual(refused(BELOW_20));
  });

  it("refuses entering KES 19 on a variable bill, and takes KES 20", async () => {
    // #given
    const id = await billId({ variable: true, amountKes: undefined });

    // #when
    const low = await send("PATCH", `/bills/${id}`, { amountKes: "19" });
    const enough = await send("PATCH", `/bills/${id}`, { amountKes: "20" });

    // #then
    expect([outcome(low), outcome(enough)]).toEqual([
      refused(BELOW_20),
      saved(200),
    ]);
  });

  it("refuses moving a KES 19 bill to a cash-out payee", async () => {
    // #given
    const unset = await insertPayee(db, paying.company);
    const id = await billId({ payeeId: unset, amountKes: "19" });

    // #when
    const answer = await send("PATCH", `/bills/${id}`, {
      payeeId: tillPayeeId,
    });

    // #then
    expect(outcome(answer)).toEqual(refused(BELOW_20));
  });

  it("still changes other fields of a bill saved before the limits", async () => {
    // #given a KES 19 bill saved while it was in range
    const unset = await insertPayee(db, paying.company);
    const id = await billId({ payeeId: unset, amountKes: "19" });
    await runInScope(db, asAdmin(), (tx) =>
      tx.update(bills).set({ payeeId: tillPayeeId }).where(eq(bills.id, id)),
    );

    // #when
    const answer = await send("PATCH", `/bills/${id}`, { notes: "Paid late" });

    // #then
    expect(outcome(answer)).toEqual(saved(200));
  });
});

describe("recurring payments", () => {
  const recurring = (overrides: Partial<CreateRecurringItemRequest> = {}) =>
    send("POST", "/recurring-items", {
      payeeId: tillPayeeId,
      amountKes: "1,500",
      schedule: "monthly",
      scheduleDay: 15,
      startsOn: shiftDays(today, 1),
      categoryId,
      ...overrides,
    } satisfies CreateRecurringItemRequest);

  it("refuses setting one up at KES 19", async () => {
    expect(outcome(await recurring({ amountKes: "19" }))).toEqual(
      refused(BELOW_20),
    );
  });

  it("refuses changing one to KES 250,000.01", async () => {
    // #given
    const created = await recurring();
    const { id } = created.data as { id: string };

    // #when
    const answer = await send("PATCH", `/recurring-items/${id}`, {
      amountKes: "250,000.01",
    });

    // #then
    expect([created.status, outcome(answer)]).toEqual([
      201,
      refused(ABOVE_250K),
    ]);
  });

  it("still creates its scheduled bill when the amount is out of range", async () => {
    // #given
    const itemId = await insertRecurringItem(db, paying.company, {
      payeeId: tillPayeeId,
      categoryId,
      amountKes: 1_900n,
    });

    // #when
    await runtime.runPromise(
      withScope(
        { organizationId: paying.company.organizationId, role: "admin" },
        (tx) =>
          createNextRecurringBill(
            tx,
            paying.company.organizationId,
            itemId,
            today,
          ),
      ),
    );

    // #then
    const created = await billsOfItem(db, paying.company, itemId);
    expect(created.map((bill) => bill.amountKes)).toEqual([1_900n]);
  });
});

describe("salaries", () => {
  it("still drafts salary bills outside the range", async () => {
    // #given
    const salaries = await addCategory(db, paying.company, "Salaries");
    for (const amountKes of [1_900n, 40_000_000n]) {
      const payeeId = await insertPersonnelPayee(db, paying.company);
      await insertSalary(db, paying.company, {
        payeeId,
        categoryId: salaries,
        amountKes,
      });
    }

    // #when
    await runtime.runPromise(
      draftDuePayroll(paying.company.organizationId, NOV_23_EAT),
    );

    // #then
    const [run] = await runsOf(db, paying.company);
    const drafted = run ? await billsOfRun(db, paying.company, run.id) : [];
    expect(drafted.map((bill) => bill.amountKes)).toEqual([
      1_900n,
      40_000_000n,
    ]);
  });
});

describe("while the other provider is active", () => {
  beforeEach(async () => {
    await setProvider("paycrest");
    paycrest.state.rateFor = () => "127.75";
  });

  it("states a minimum of 0.5 USDC at its rate, rounded up", async () => {
    expect(await walletLimits()).toEqual({
      minKesCents: "6400",
      maxKesCents: "30000000",
    });
  });

  it("refuses a shilling under that minimum, and saves it", async () => {
    // #when
    const low = await createBill({ amountKes: "63" });
    const enough = await createBill({ amountKes: "64" });

    // #then
    expect([outcome(low), outcome(enough)]).toEqual([
      refused("The smallest amount that can be sent is KES 64."),
      saved(),
    ]);
  });

  it("refuses KES 300,000.01", async () => {
    expect(outcome(await createBill({ amountKes: "300,000.01" }))).toEqual(
      refused(ABOVE_300K),
    );
  });

  it("saves any amount up to the maximum while its rate is unavailable", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const limits = await walletLimits();
    const answer = await createBill({ amountKes: "1" });

    // #then
    expect({ limits, saved: outcome(answer) }).toEqual({
      limits: { minKesCents: null, maxKesCents: "30000000" },
      saved: saved(),
    });
  });
});

describe("switching the active provider", () => {
  it("changes both the stated range and what is refused", async () => {
    // #given
    paycrest.state.rateFor = () => "127.75";

    // #when
    const underPretium = {
      limits: await walletLimits(),
      kes30: outcome(await createBill({ amountKes: "30" })),
    };
    await setProvider("paycrest");
    const underPaycrest = {
      limits: await walletLimits(),
      kes30: outcome(await createBill({ amountKes: "30" })),
    };

    // #then
    expect({ underPretium, underPaycrest }).toEqual({
      underPretium: {
        limits: { minKesCents: "2000", maxKesCents: "25000000" },
        kes30: saved(),
      },
      underPaycrest: {
        limits: { minKesCents: "6400", maxKesCents: "30000000" },
        kes30: refused("The smallest amount that can be sent is KES 64."),
      },
    });
  });
});
