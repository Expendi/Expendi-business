import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { CompanyZohoResponse } from "@expendi-business/shared";
import { companyZohoResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingConnections,
  accountingSyncs,
  expenses,
  payrollRuns,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertBill, insertPayee } from "../helpers/bills.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { asAdmin, nameUser } from "../helpers/exports.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(() => runtime.dispose());

const SEALED_TOKEN = "sealed-refresh-token-never-shown";
const CONNECT_HASH_PREFIX = "connect-hash-never-shown-";

const zohoPath = (company: TestCompany) =>
  `/organizations/${company.organizationId}/settings/zoho`;

async function zohoStatus(
  company: TestCompany,
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<CompanyZohoResponse> {
  const response = await sendJson(app, zohoPath(company), user);
  if (response.status !== 200) {
    throw new Error(`answered ${response.status}: ${await response.text()}`);
  }
  const { data } = (await response.json()) as { data: unknown };
  return companyZohoResponseSchema.parse(data);
}

function connect(
  company: TestCompany,
  values: Partial<typeof accountingConnections.$inferInsert> = {},
) {
  return runInScope(db, asAdmin(company), (tx) =>
    tx.insert(accountingConnections).values({
      organizationId: company.organizationId,
      status: "active",
      externalOrganizationId: "60001",
      externalOrganizationName: "Mwangaza Logistics Ltd",
      accountsServer: "https://accounts.zoho.eu",
      apiDomain: "https://www.zohoapis.eu",
      refreshTokenEncrypted: SEALED_TOKEN,
      connectTokenHash: `${CONNECT_HASH_PREFIX}${randomUUID()}`,
      connectTokenExpiresAt: new Date("2026-12-01T00:00:00Z"),
      connectedAt: new Date("2026-10-12T12:40:00Z"),
      ...values,
    }),
  );
}

type NewAccountingSync = typeof accountingSyncs.$inferInsert;

function sync(
  company: TestCompany,
  values: Partial<NewAccountingSync> &
    Pick<NewAccountingSync, "subjectType" | "subjectId">,
) {
  return runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(accountingSyncs)
      .values({ organizationId: company.organizationId, ...values })
      .returning({ id: accountingSyncs.id }),
  ).then(([row]) => {
    if (!row) throw new Error("sync insert returned no row");
    return row.id;
  });
}

/** A paid reimbursement, a bill and a payroll run for syncs to point at. */
async function seedSubjects(company: TestCompany) {
  await nameUser(db, company.admin, "Jane Wanjiku");
  const categoryId = await addCategory(db, company, "Office");
  const payeeId = await insertPayee(db, company, { name: "Kenya Power" });
  const billId = await insertBill(db, company, {
    payeeId,
    categoryId,
    reference: "INV-1",
  });
  const [expense] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(expenses)
      .values({
        organizationId: company.organizationId,
        membershipId: company.adminMembershipId,
        categoryId,
        kind: "claim",
        overviewHeading: "transactions",
        merchant: "Java House",
        amountKes: 150_000n,
        spentOn: "2026-10-03",
        status: "paid",
        paidAt: new Date("2026-10-04T08:00:00Z"),
      })
      .returning({ id: expenses.id }),
  );
  const [run] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(payrollRuns)
      .values({
        organizationId: company.organizationId,
        payDate: "2026-10-28",
        totalKes: 60_000n,
        salariesKes: 60_000n,
        capKes: 72_000n,
      })
      .returning({ id: payrollRuns.id }),
  );
  if (!expense || !run) throw new Error("seed insert returned no row");
  return { billId, expenseId: expense.id, runId: run.id };
}

describe("GET /organizations/:organizationId/settings/zoho", () => {
  it("says a company without a connection isn't connected", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const status = await zohoStatus(company);

    // #then
    expect(status).toEqual({
      status: "not_connected",
      organizationName: null,
      connectedAt: null,
      lastSyncedAt: null,
      counts: { pending: 0, synced: 0, failed: 0 },
      failed: [],
    });
  });

  it("shows admins and accountants the connection, the last sync and what failed, with why", async () => {
    // #given
    const company = await createCompany(db);
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    await connect(company);
    const { billId, expenseId, runId } = await seedSubjects(company);
    await sync(company, {
      subjectType: "expense",
      subjectId: randomUUID(),
      status: "synced",
      externalId: "z-1",
      syncedAt: new Date("2026-11-01T09:00:00Z"),
    });
    await sync(company, {
      subjectType: "expense",
      subjectId: randomUUID(),
      status: "synced",
      externalId: "z-2",
      syncedAt: new Date("2026-11-05T09:00:00Z"),
    });
    await sync(company, { subjectType: "bill", subjectId: randomUUID() });
    const older = await sync(company, {
      subjectType: "expense",
      subjectId: expenseId,
      status: "failed",
      attempts: 5,
      lastError: "Zoho didn't answer in time.",
      updatedAt: new Date("2026-11-02T09:00:00Z"),
    });
    const newer = await sync(company, {
      subjectType: "bill",
      subjectId: billId,
      status: "failed",
      attempts: 5,
      lastError: "The account for this category was deleted in Zoho.",
      updatedAt: new Date("2026-11-04T09:00:00Z"),
    });
    const payroll = await sync(company, {
      subjectType: "payroll_run",
      subjectId: runId,
      status: "failed",
      attempts: 5,
      lastError: "The salaries account isn't mapped.",
      updatedAt: new Date("2026-11-03T09:00:00Z"),
    });

    // #when
    const asAdmin = await zohoStatus(company);
    const asAccountant = await zohoStatus(company, accountant);

    // #then
    expect(asAdmin).toEqual({
      status: "active",
      organizationName: "Mwangaza Logistics Ltd",
      connectedAt: "2026-10-12T12:40:00.000Z",
      lastSyncedAt: "2026-11-05T09:00:00.000Z",
      counts: { pending: 1, synced: 2, failed: 3 },
      failed: [
        {
          id: newer,
          subjectType: "bill",
          subjectId: billId,
          label: "Kenya Power, INV-1",
          reason: "The account for this category was deleted in Zoho.",
          failedAt: "2026-11-04T09:00:00.000Z",
        },
        {
          id: payroll,
          subjectType: "payroll_run",
          subjectId: runId,
          label: "Payroll for October 2026",
          reason: "The salaries account isn't mapped.",
          failedAt: "2026-11-03T09:00:00.000Z",
        },
        {
          id: older,
          subjectType: "expense",
          subjectId: expenseId,
          label: "Java House, Jane Wanjiku",
          reason: "Zoho didn't answer in time.",
          failedAt: "2026-11-02T09:00:00.000Z",
        },
      ],
    });
    expect(asAccountant).toEqual(asAdmin);
  });

  it("says when the connection needs reconnecting, and never shows a token or link", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company, { status: "needs_reconnect" });

    // #when
    const response = await sendJson(app, zohoPath(company), company.admin);

    // #then
    const text = await response.text();
    expect(text).not.toContain(SEALED_TOKEN);
    expect(text).not.toContain(CONNECT_HASH_PREFIX);
    expect(text).not.toContain("zohoapis");
    expect(
      companyZohoResponseSchema.parse(
        (JSON.parse(text) as { data: unknown }).data,
      ).status,
    ).toBe("needs_reconnect");
  });

  it("refuses employees", async () => {
    // #given
    const company = await createCompany(db);
    const employee = await createUser(db);
    await addMember(db, company, employee);

    // #when
    const response = await sendJson(app, zohoPath(company), employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("is isolated between companies", async () => {
    const fixture = await createIsolationFixture(db);
    await connect(fixture.companyB);
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/settings/zoho`,
    }));
  });
});
