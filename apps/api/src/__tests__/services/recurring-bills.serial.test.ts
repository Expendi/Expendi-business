import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewRecurringItem } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { withScope } from "../../db/scope.js";
import {
  createNextRecurringBill,
  createOwedRecurringBills,
  onRecurringBillSettled,
} from "../../services/recurring/next-bill.js";
import { insertBill, insertBillPayout, insertPayee } from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  billsOfItem,
  insertRecurringItem,
  outstandingBillsOfItem,
  readRecurringItem,
} from "../helpers/recurring.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The recurring-bills job gives every company's items their bills, so it
 * runs on its own after the main suite, like the bill status job.
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

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  acme = await seedCompany();
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

/** Monthly on the 15th, next due 15 Mar 2026, with no bill yet. */
function itemOwedABill(
  values: Partial<NewRecurringItem> = {},
  seeded: Seeded = acme,
): Promise<string> {
  return insertRecurringItem(db, seeded.company, {
    payeeId: seeded.payeeId,
    categoryId: seeded.categoryId,
    ...values,
  });
}

/** 10 Mar 2026, mid-morning in Nairobi. */
const MARCH_10 = new Date("2026-03-10T06:00:00Z");

const runJob = (now: Date = MARCH_10) =>
  runtime.runPromise(createOwedRecurringBills(now));

/** One step of the job for one item, as a second instance would run it. */
const createNext = (itemId: string, seeded: Seeded = acme) =>
  runtime.runPromise(
    withScope(
      { organizationId: seeded.company.organizationId, role: "admin" },
      (tx) =>
        createNextRecurringBill(
          tx,
          seeded.company.organizationId,
          itemId,
          "2026-03-10",
        ),
    ),
  );

const outstanding = (itemId: string, seeded: Seeded = acme) =>
  outstandingBillsOfItem(db, seeded.company, itemId);

describe("createOwedRecurringBills", () => {
  it("creates the next bill for an item with none, and moves its next due date on", async () => {
    // #given
    const itemId = await itemOwedABill();

    // #when
    const run = await runJob();

    // #then
    expect(run).toMatchObject({ today: "2026-03-10", failed: 0 });
    expect(await billsOfItem(db, acme.company, itemId)).toMatchObject([
      {
        dueOn: "2026-03-15",
        status: "upcoming",
        amountKes: 250_000n,
        variable: false,
        payeeId: acme.payeeId,
        categoryId: acme.categoryId,
        overviewHeading: "transactions",
      },
    ]);
    expect((await readRecurringItem(db, acme.company, itemId)).nextDueOn).toBe(
      "2026-04-15",
    );
  });

  it("gives a variable item's bill no amount", async () => {
    // #given
    const itemId = await itemOwedABill({ amountKes: null });

    // #when
    await runJob();

    // #then
    const [bill] = await billsOfItem(db, acme.company, itemId);
    expect([bill?.variable, bill?.amountKes]).toEqual([true, null]);
  });

  it("sets the bill's status from its due date against today in Nairobi", async () => {
    // #given
    const dueToday = await itemOwedABill({ nextDueOn: "2026-03-10" });
    const pastDue = await itemOwedABill({ nextDueOn: "2026-03-01" });

    // #when 23:30 on 9 Mar UTC is already 10 Mar in Nairobi
    await runJob(new Date("2026-03-09T21:30:00Z"));

    // #then
    const [today] = await billsOfItem(db, acme.company, dueToday);
    const [past] = await billsOfItem(db, acme.company, pastDue);
    expect([today?.status, past?.status]).toEqual(["due", "overdue"]);
  });

  it("audits each new bill as the system", async () => {
    // #given
    const itemId = await itemOwedABill();

    // #when
    await runJob();

    // #then
    const [bill] = await billsOfItem(db, acme.company, itemId);
    const { rows } = await owner.query(
      "SELECT actor_type, actor_id, organization_id, after FROM audit_log WHERE entity_type = 'bill' AND entity_id = $1 AND action = 'bill.created'",
      [bill?.id],
    );
    expect(rows).toMatchObject([
      {
        actor_type: "system",
        actor_id: "recurring-bills",
        organization_id: acme.company.organizationId,
        after: { recurringItemId: itemId, dueOn: "2026-03-15" },
      },
    ]);
  });

  it("run twice, still leaves one bill", async () => {
    // #given
    const itemId = await itemOwedABill();

    // #when
    await runJob();
    await runJob();

    // #then
    expect(await billsOfItem(db, acme.company, itemId)).toHaveLength(1);
  });

  it("run in two places at once, still leaves one bill", async () => {
    // #given
    const itemId = await itemOwedABill();

    // #when
    await Promise.all([runJob(), runJob(), runJob()]);

    // #then
    expect(await billsOfItem(db, acme.company, itemId)).toHaveLength(1);
  });

  it("leaves an item with a bill still owed alone", async () => {
    // #given
    const itemId = await itemOwedABill();
    await insertBill(db, acme.company, {
      payeeId: acme.payeeId,
      categoryId: acme.categoryId,
      recurringItemId: itemId,
      dueOn: "2026-02-15",
      status: "overdue",
    });

    // #when
    await runJob();

    // #then
    expect(
      (await billsOfItem(db, acme.company, itemId)).map((bill) => bill.dueOn),
    ).toEqual(["2026-02-15"]);
  });

  it("creates nothing for a paused item, and its bills stay", async () => {
    // #given
    const itemId = await itemOwedABill({ active: false });
    const kept = await insertBill(db, acme.company, {
      payeeId: acme.payeeId,
      categoryId: acme.categoryId,
      recurringItemId: itemId,
      dueOn: "2026-02-15",
      status: "cancelled",
      cancelledReason: "Not needed",
      cancelledBy: acme.company.admin.id,
      cancelledAt: new Date("2026-02-10T08:00:00Z"),
    });

    // #when
    await runJob();

    // #then
    expect(
      (await billsOfItem(db, acme.company, itemId)).map((bill) => bill.id),
    ).toEqual([kept]);
  });

  it("creates nothing for an item whose end date has passed", async () => {
    // #given
    const itemId = await itemOwedABill({
      endsOn: "2026-02-28",
      nextDueOn: null,
    });

    // #when
    await runJob();

    // #then
    expect(await billsOfItem(db, acme.company, itemId)).toEqual([]);
  });

  it("creates the last bill on the end date, then ends the item", async () => {
    // #given
    const itemId = await itemOwedABill({ endsOn: "2026-03-15" });

    // #when
    await runJob();

    // #then
    expect(await billsOfItem(db, acme.company, itemId)).toHaveLength(1);
    expect((await readRecurringItem(db, acme.company, itemId)).nextDueOn).toBe(
      null,
    );
  });

  it("creates nothing for an archived payee or a salary", async () => {
    // #given
    const archivedPayee = await insertPayee(db, acme.company, {
      archived: true,
    });
    const archived = await itemOwedABill({ payeeId: archivedPayee });
    const salary = await itemOwedABill({ overviewHeading: "salaries" });

    // #when
    await runJob();

    // #then
    expect([
      await billsOfItem(db, acme.company, archived),
      await billsOfItem(db, acme.company, salary),
    ]).toEqual([[], []]);
  });

  it("covers every company in one run", async () => {
    // #given
    const other = await seedCompany();
    const ours = await itemOwedABill();
    const theirs = await itemOwedABill({}, other);

    // #when
    await runJob();

    // #then
    expect([
      (await outstanding(ours)).length,
      (await outstanding(theirs, other)).length,
    ]).toEqual([1, 1]);
  });
});

describe("createNextRecurringBill", () => {
  it("a second attempt that saw no bill finds the first one through the unique index", async () => {
    // #given
    const itemId = await itemOwedABill();

    // #when
    const first = await createNext(itemId);
    const second = await createNext(itemId);

    // #then
    expect([first.kind, second.kind]).toEqual(["created", "already_there"]);
    expect(await billsOfItem(db, acme.company, itemId)).toHaveLength(1);
    expect((await readRecurringItem(db, acme.company, itemId)).nextDueOn).toBe(
      "2026-04-15",
    );
  });

  it("creates nothing for a paused item", async () => {
    // #given
    const itemId = await itemOwedABill({ active: false });

    // #when
    const outcome = await createNext(itemId);

    // #then
    expect(outcome.kind).toBe("paused");
    expect(await billsOfItem(db, acme.company, itemId)).toEqual([]);
  });

  it("a bill held by a payment in flight counts as still owed", async () => {
    // #given
    const itemId = await itemOwedABill();
    const { id: walletId } = await createActiveWallet(db, acme.company);
    await insertBill(db, acme.company, {
      payeeId: acme.payeeId,
      categoryId: acme.categoryId,
      recurringItemId: itemId,
      dueOn: "2026-02-15",
      status: "paying",
      payoutId: await insertBillPayout(db, acme.company, walletId),
    });

    // #when
    const outcome = await createNext(itemId);

    // #then
    expect(outcome.kind).toBe("already_there");
  });
});

describe("onRecurringBillSettled", () => {
  it("creates the next bill once when a settlement is retried", async () => {
    // #given
    const itemId = await itemOwedABill();
    const settled = {
      organizationId: acme.company.organizationId,
      recurringItemId: itemId,
    };
    const settle = () =>
      runtime.runPromise(
        withScope(
          { organizationId: acme.company.organizationId, role: "admin" },
          (tx) => onRecurringBillSettled(tx, settled, MARCH_10),
        ),
      );

    // #when
    const outcomes = [await settle(), await settle()];

    // #then
    expect(outcomes.map((outcome) => outcome?.kind)).toEqual([
      "created",
      "already_there",
    ]);
    expect(await outstanding(itemId)).toHaveLength(1);
  });

  it("does nothing for a one-off bill", async () => {
    // #when
    const outcome = await runtime.runPromise(
      withScope(
        { organizationId: acme.company.organizationId, role: "admin" },
        (tx) =>
          onRecurringBillSettled(
            tx,
            {
              organizationId: acme.company.organizationId,
              recurringItemId: null,
            },
            MARCH_10,
          ),
      ),
    );

    // #then
    expect(outcome).toBeNull();
  });
});
