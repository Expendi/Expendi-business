import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PaidFromAccount } from "@expendi-business/shared";
import {
  paidFromAccountSchema,
  paidFromAccountsResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { paidFromAccounts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

let company: TestCompany;
let employee: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  await addMember(db, company, employee);
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/paid-from-accounts`;

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

async function addAccount(
  name = "KCB current account",
  kind = "bank",
): Promise<PaidFromAccount> {
  const response = await send("POST", base(), { name, kind });
  if (response.status !== 201) {
    throw new Error(`add account answered ${response.status}`);
  }
  return dataOf(response, paidFromAccountSchema);
}

async function auditOf(accountId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    before: unknown;
    after: unknown;
  }>(
    "SELECT action, actor_id, before, after FROM audit_log WHERE entity_type = 'paid_from_account' AND entity_id = $1 ORDER BY occurred_at",
    [accountId],
  );
  return rows;
}

describe("paid-from accounts", () => {
  it("adds an account and lists the company's accounts by name", async () => {
    // #given
    await addAccount("Stanbic USD account", "bank");
    const card = await addAccount("Founder's Visa card", "card");

    // #when
    const response = await send("GET", base());

    // #then
    expect(card).toMatchObject({
      name: "Founder's Visa card",
      kind: "card",
      archived: false,
    });
    const listed = await dataOf(response, paidFromAccountsResponseSchema);
    expect(listed.map((account) => account.name)).toEqual([
      "Founder's Visa card",
      "Stanbic USD account",
    ]);
  });

  it("audits the new account as the admin's settings change", async () => {
    // #when
    const account = await addAccount("Petty cash box", "cash");

    // #then
    expect(await auditOf(account.id)).toEqual([
      expect.objectContaining({
        action: "paid_from_account.created",
        actor_id: company.admin.id,
        after: { name: "Petty cash box", kind: "cash" },
      }),
    ]);
  });

  it("refuses a second account with the same name, ignoring case", async () => {
    // #given
    await addAccount("KCB current account");

    // #when
    const response = await send("POST", base(), {
      name: "kcb CURRENT account",
      kind: "bank",
    });

    // #then
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already an account called");
  });

  it("renames an account and changes its kind, audited before and after", async () => {
    // #given
    const account = await addAccount("KCB", "bank");

    // #when
    const response = await send("PATCH", `${base()}/${account.id}`, {
      name: "M-Pesa till float",
      kind: "mobile_money",
    });

    // #then
    expect(await dataOf(response, paidFromAccountSchema)).toMatchObject({
      name: "M-Pesa till float",
      kind: "mobile_money",
    });
    expect((await auditOf(account.id)).at(-1)).toMatchObject({
      action: "paid_from_account.updated",
      before: { name: "KCB", kind: "bank" },
      after: { name: "M-Pesa till float", kind: "mobile_money" },
    });
  });

  it("archives an account: it leaves the list, shows under archived, and its name is free again", async () => {
    // #given
    const account = await addAccount("Old Equity account");

    // #when
    const archived = await send("POST", `${base()}/${account.id}/archive`);

    // #then
    expect((await dataOf(archived, paidFromAccountSchema)).archived).toBe(true);
    const active = await dataOf(
      await send("GET", base()),
      paidFromAccountsResponseSchema,
    );
    expect(active.map((row) => row.id)).not.toContain(account.id);
    const listedArchived = await dataOf(
      await send("GET", `${base()}?archived=true`),
      paidFromAccountsResponseSchema,
    );
    expect(listedArchived.map((row) => row.id)).toEqual([account.id]);
    expect(
      (await send("POST", base(), { name: "Old Equity account", kind: "bank" }))
        .status,
    ).toBe(201);
    expect((await auditOf(account.id)).at(-1)).toMatchObject({
      action: "paid_from_account.archived",
      after: { archived: true },
    });
  });

  it("won't rename an archived account", async () => {
    // #given
    const account = await addAccount();
    await send("POST", `${base()}/${account.id}/archive`);

    // #when
    const response = await send("PATCH", `${base()}/${account.id}`, {
      name: "Renamed",
    });

    // #then
    expect(response.status).toBe(409);
  });

  it("needs a name and a known kind", async () => {
    // #when
    const noName = await send("POST", base(), { name: "  ", kind: "bank" });
    const badKind = await send("POST", base(), { name: "KCB", kind: "crypto" });

    // #then
    expect(noName.status).toBe(400);
    expect(badKind.status).toBe(400);
  });

  it("answers 404 for another company's account", async () => {
    // #given
    const other = await createCompany(db);
    const [foreign] = await runInScope(
      db,
      { organizationId: other.organizationId },
      (tx) =>
        tx
          .insert(paidFromAccounts)
          .values({
            organizationId: other.organizationId,
            name: "Their bank",
            kind: "bank",
          })
          .returning({ id: paidFromAccounts.id }),
    );

    // #when
    const response = await send("PATCH", `${base()}/${foreign?.id ?? ""}`, {
      name: "Mine now",
    });

    // #then
    expect(response.status).toBe(404);
  });
});

describe("admins only", () => {
  it.each([
    ["GET", ""],
    ["POST", ""],
    ["PATCH", "/:id"],
    ["POST", "/:id/archive"],
  ] as const)("an employee gets 403 from %s %s", async (method, path) => {
    // #given
    const account = await addAccount();

    // #when
    const response = await send(
      method,
      `${base()}${path.replace(":id", account.id)}`,
      method === "GET" ? undefined : { name: "Employee's", kind: "cash" },
      employee,
    );

    // #then
    expect(response.status).toBe(403);
    const listed = await dataOf(
      await send("GET", base()),
      paidFromAccountsResponseSchema,
    );
    expect(listed).toEqual([account]);
  });
});

describe("company isolation", () => {
  async function accountIn(target: TestCompany): Promise<string> {
    const [row] = await runInScope(
      db,
      { organizationId: target.organizationId },
      (tx) =>
        tx
          .insert(paidFromAccounts)
          .values({
            organizationId: target.organizationId,
            name: `Account ${randomUUID()}`,
            kind: "bank",
          })
          .returning({ id: paidFromAccounts.id }),
    );
    if (!row) throw new Error("account insert returned no row");
    return row.id;
  }

  it("keeps each company's accounts to itself in the database", async () => {
    // #given
    await accountIn(fixture.companyA);
    await accountIn(fixture.companyB);

    // #then
    await expectTableIsolation(fixture, "paid_from_accounts");
  });

  it.each([
    ["GET", ""],
    ["POST", ""],
    ["PATCH", "/:id"],
    ["POST", "/:id/archive"],
  ] as const)("%s %s refuses another company", async (method, path) => {
    // #given
    const accountId = await accountIn(fixture.companyA);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/paid-from-accounts${path.replace(":id", accountId)}`,
      init: {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify({}) }),
      },
    }));
  });
});
