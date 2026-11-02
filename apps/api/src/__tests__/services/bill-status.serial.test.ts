import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BillStatus } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { advanceBillStatuses } from "../../services/bills/status.js";
import {
  insertBill,
  insertBillPayout,
  insertPayee,
  readBill,
} from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The status job moves every company's bills, so it runs on its own after
 * the main suite: a run here would move bills other test files rely on.
 */

let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;

interface Seeded {
  readonly company: TestCompany;
  readonly payeeId: string;
  readonly categoryId: string;
}

async function seedCompany(): Promise<Seeded> {
  const company = await createCompany(db);
  return {
    company,
    payeeId: await insertPayee(db, company),
    categoryId: await addCategory(db, company, "Rent"),
  };
}

let acme: Seeded;
let acmeWalletId: string;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  acme = await seedCompany();
  acmeWalletId = (await createActiveWallet(db, acme.company)).id;
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

function billDue(
  dueOn: string,
  status: BillStatus = "upcoming",
  seeded: Seeded = acme,
): Promise<string> {
  return insertBill(db, seeded.company, {
    payeeId: seeded.payeeId,
    categoryId: seeded.categoryId,
    dueOn,
    status,
  });
}

const statusOf = async (billId: string, seeded: Seeded = acme) =>
  (await readBill(db, seeded.company, billId)).status;

const runAt = (instant: string) =>
  runtime.runPromise(advanceBillStatuses(new Date(instant)));

describe("advanceBillStatuses around Nairobi midnight", () => {
  it("at 23:59 in Nairobi (20:59 UTC) a bill due that day is due, and tomorrow's is still upcoming", async () => {
    // #given
    const dueToday = await billDue("2026-03-31");
    const dueTomorrow = await billDue("2026-04-01");

    // #when
    const run = await runAt("2026-03-31T20:59:59Z");

    // #then
    expect(run.today).toBe("2026-03-31");
    expect([await statusOf(dueToday), await statusOf(dueTomorrow)]).toEqual([
      "due",
      "upcoming",
    ]);
  });

  it("at 00:00 in Nairobi (21:00 UTC) yesterday's bill is overdue and today's is due", async () => {
    // #given
    const dueYesterday = await billDue("2026-05-12", "due");
    const dueToday = await billDue("2026-05-13");

    // #when
    const run = await runAt("2026-05-12T21:00:00Z");

    // #then
    expect(run.today).toBe("2026-05-13");
    expect([await statusOf(dueYesterday), await statusOf(dueToday)]).toEqual([
      "overdue",
      "due",
    ]);
  });
});

describe("advanceBillStatuses at month and year ends", () => {
  it.each([
    ["2026-01-31", "2026-02-01", "2026-01-31T21:00:00Z"],
    ["2026-02-28", "2026-03-01", "2026-02-28T21:00:00Z"],
    ["2028-02-29", "2028-03-01", "2028-02-29T21:00:00Z"],
    ["2026-04-30", "2026-05-01", "2026-04-30T21:00:00Z"],
    ["2026-12-31", "2027-01-01", "2026-12-31T21:00:00Z"],
  ])(
    "after %s comes %s at Nairobi midnight",
    async (lastDay, firstDay, midnight) => {
      // #given
      const endOfMonth = await billDue(lastDay, "due");
      const startOfMonth = await billDue(firstDay);

      // #when
      await runAt(midnight);

      // #then
      expect([
        await statusOf(endOfMonth),
        await statusOf(startOfMonth),
      ]).toEqual(["overdue", "due"]);
    },
  );
});

describe("advanceBillStatuses is safe to repeat", () => {
  it("moves nothing the second time", async () => {
    // #given
    const upcoming = await billDue("2026-07-10");
    const due = await billDue("2026-07-09", "due");
    await runAt("2026-07-10T09:00:00Z");

    // #when
    const second = await runAt("2026-07-10T09:00:00Z");

    // #then
    expect(second).toEqual({ today: "2026-07-10", due: 0, overdue: 0 });
    expect([await statusOf(upcoming), await statusOf(due)]).toEqual([
      "due",
      "overdue",
    ]);
  });

  it("catches up on missed days, straight from upcoming to overdue", async () => {
    // #given
    const missed = await billDue("2026-08-01");

    // #when
    await runAt("2026-08-05T09:00:00Z");

    // #then
    expect(await statusOf(missed)).toBe("overdue");
  });

  it("never moves a bill back", async () => {
    // #given
    const overdue = await billDue("2026-09-01", "overdue");

    // #when
    await runAt("2026-08-01T09:00:00Z");

    // #then
    expect(await statusOf(overdue)).toBe("overdue");
  });
});

describe("advanceBillStatuses leaves settled and in-flight bills alone", () => {
  it.each([
    "paying",
    "paid",
    "payout_failed",
    "paid_outside",
    "cancelled",
  ] as const)("a %s bill past its due date stays as it is", async (status) => {
    // #given
    const { company } = acme;
    const settled = await insertBill(db, company, {
      payeeId: acme.payeeId,
      categoryId: acme.categoryId,
      dueOn: "2026-06-01",
      status,
      ...(status === "paying" || status === "paid" || status === "payout_failed"
        ? { payoutId: await insertBillPayout(db, company, acmeWalletId) }
        : {}),
      ...(status === "paid" || status === "paid_outside"
        ? { paidOn: "2026-06-01", paidAt: new Date("2026-06-01T08:00:00Z") }
        : {}),
      ...(status === "paid_outside" ? { markedPaidBy: company.admin.id } : {}),
      ...(status === "cancelled"
        ? {
            cancelledReason: "Duplicate",
            cancelledBy: company.admin.id,
            cancelledAt: new Date("2026-05-20T08:00:00Z"),
          }
        : {}),
    });

    // #when
    await runAt("2026-06-20T09:00:00Z");

    // #then
    expect(await statusOf(settled)).toBe(status);
  });
});

describe("advanceBillStatuses across companies", () => {
  it("moves every company's bills in one run", async () => {
    // #given
    const other = await seedCompany();
    const ours = await billDue("2026-10-01");
    const theirs = await billDue("2026-10-01", "upcoming", other);

    // #when
    await runAt("2026-10-01T06:00:00Z");

    // #then
    expect([await statusOf(ours), await statusOf(theirs, other)]).toEqual([
      "due",
      "due",
    ]);
  });

  it("writes no audit entry: a status tick follows from the due date alone", async () => {
    // #given
    const bill = await billDue("2026-10-20");

    // #when
    await runAt("2026-10-20T06:00:00Z");

    // #then
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_log WHERE entity_type = 'bill' AND entity_id = $1",
      [bill],
    );
    expect(rows).toEqual([]);
  });
});
