import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AccountingSyncRow } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingConnections,
  accountingSyncs,
  expenses,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { enqueuePaidClaim } from "../../services/zoho/enqueue.js";
import { syncDueAccounting } from "../../services/zoho/sync.js";
import { addCategory } from "../helpers/claims.js";
import { createCompany } from "../helpers/db.js";
import { makeFakeZoho } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { connectZoho } from "../helpers/zoho.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: the job sweeps every company's queue, so files running alongside
// would have their syncs taken.

const zoho = makeFakeZoho();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let opsAdmin: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { zoho: zoho.layer },
    { ACCOUNTING_TOKEN_KEY: randomBytes(32).toString("base64") },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  opsAdmin = await createStaff(owner);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  zoho.state.reset();
  // Earlier tests' leftovers must not be due for this one.
  await runtime.runPromise(syncDueAccounting(200));
});

/** A connected company whose admin has `count` paid claims, queued. */
async function companyWithPaidClaims(
  count: number,
): Promise<{ company: TestCompany; claimIds: string[] }> {
  const company = await createCompany(db);
  const categoryId = await addCategory(db, company, "Meals");
  await connectZoho(app, opsAdmin, company, {
    categoryAccounts: { [categoryId]: "acc-meals" },
    paidThroughAccountId: "acc-wallet",
    defaultAccountId: "acc-fees",
  });
  const claimIds = Array.from({ length: count }, () => randomUUID());
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(expenses).values(
      claimIds.map((id, index) => ({
        id,
        organizationId: company.organizationId,
        membershipId: company.adminMembershipId,
        categoryId,
        kind: "claim" as const,
        status: "paid" as const,
        merchant: `Kiosk ${index}`,
        amountKes: 10_000n + BigInt(index),
        spentOn: "2026-10-20",
        overviewHeading: "petty_cash" as const,
        paidAt: new Date(),
      })),
    ),
  );
  await runtime.runPromise(
    withScope({ organizationId: company.organizationId }, (tx) =>
      Effect.forEach(claimIds, (claimId) =>
        enqueuePaidClaim(tx, company.organizationId, claimId),
      ),
    ),
  );
  return { company, claimIds };
}

async function syncsOf(company: TestCompany): Promise<AccountingSyncRow[]> {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.select().from(accountingSyncs).orderBy(accountingSyncs.createdAt),
  );
}

describe("the zoho-sync job", () => {
  it("posts due claims of active connections and leaves a paused company's queue alone", async () => {
    // #given
    const active = await companyWithPaidClaims(1);
    const paused = await companyWithPaidClaims(1);
    await runInScope(
      db,
      { organizationId: paused.company.organizationId },
      (tx) =>
        tx
          .update(accountingConnections)
          .set({ status: "needs_reconnect", refreshTokenEncrypted: null })
          .where(
            eq(
              accountingConnections.organizationId,
              paused.company.organizationId,
            ),
          ),
    );

    // #when
    const summary = await runtime.runPromise(syncDueAccounting());

    // #then
    expect(summary).toEqual({ considered: 1, outcomes: { synced: 1 } });
    expect(
      zoho.state.expenses.map(({ draft }) => draft.referenceNumber),
    ).toEqual(active.claimIds);
    expect(await syncsOf(paused.company)).toEqual([
      expect.objectContaining({ status: "pending", attempts: 0 }),
    ]);
  });

  it("leaves a company Zoho rate-limits for the rest of the run, without using up tries", async () => {
    // #given
    const { company } = await companyWithPaidClaims(2);
    zoho.state.failNext("findExpenses", "RATE_LIMITED");

    // #when
    const summary = await runtime.runPromise(syncDueAccounting());

    // #then
    expect(summary).toEqual({
      considered: 2,
      outcomes: { rate_limited: 1 },
    });
    expect(zoho.state.searches).toHaveLength(1);
    const syncs = await syncsOf(company);
    expect(syncs.map(({ status, attempts }) => [status, attempts])).toEqual([
      ["pending", 0],
      ["pending", 0],
    ]);
  });

  it("finds nothing to do once the queue is drained", async () => {
    // #given
    await companyWithPaidClaims(1);
    await runtime.runPromise(syncDueAccounting());

    // #when
    const summary = await runtime.runPromise(syncDueAccounting());

    // #then
    expect(summary).toEqual({ considered: 0, outcomes: {} });
  });
});
