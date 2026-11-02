import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { ActivityPage } from "@expendi-business/shared";
import { activityPageSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE });
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await owner.end();
  await runtime.dispose();
});

const activityPath = (company: TestCompany, query = "") =>
  `/organizations/${company.organizationId}/activity${query}`;

async function dataOf(response: Response): Promise<unknown> {
  const { data } = (await response.json()) as { data: unknown };
  return data;
}

async function activity(
  company: TestCompany,
  query = "",
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<ActivityPage> {
  const response = await sendJson(app, activityPath(company, query), user);
  if (response.status !== 200) {
    throw new Error(`answered ${response.status}: ${await response.text()}`);
  }
  return activityPageSchema.parse(await dataOf(response));
}

/** An audited change made through the API, the way an admin makes one. */
async function addCategory(
  company: TestCompany,
  name: string,
): Promise<string> {
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/categories`,
    company.admin,
    { method: "POST", body: { name } },
  );
  if (response.status !== 201) {
    throw new Error(`answered ${response.status}: ${await response.text()}`);
  }
  return ((await dataOf(response)) as { readonly id: string }).id;
}

interface SeededEntry {
  readonly organizationId: string;
  readonly occurredAt: string;
  readonly actorType?: "user" | "staff" | "system";
  readonly actorId?: string;
  readonly action?: string;
}

/** An entry written by the owner, e.g. at a set time or by a staff member. */
async function seedEntry(entry: SeededEntry): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO audit_log
       (occurred_at, actor_type, actor_id, organization_id, action,
        entity_type, entity_id, after, request_id, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, 'payout', $6, '{"status":"paid"}', 'req-1',
             '203.0.113.9', 'staff-browser')
     RETURNING id`,
    [
      entry.occurredAt,
      entry.actorType ?? "system",
      entry.actorId ?? "reconcile",
      entry.organizationId,
      entry.action ?? "payout.paid",
      randomUUID(),
    ],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("audit insert returned no row");
  return id;
}

const ids = (page: ActivityPage) => page.entries.map((entry) => entry.id);
const entityIds = (page: ActivityPage) =>
  page.entries.map((entry) => entry.entity.id);

describe("GET /organizations/:organizationId/activity", () => {
  it("shows admins and accountants their own company's activity, and only theirs", async () => {
    // #given each company makes changes, and A has an accountant
    const [companyA, companyB] = await Promise.all([
      createCompany(db),
      createCompany(db),
    ]);
    const accountant = await createUser(db);
    await addMember(db, companyA, accountant, { role: "accountant" });
    const categoryOfA = await addCategory(companyA, "Courier");
    const categoryOfB = await addCategory(companyB, "Courier");

    // #when
    const asAdminA = await activity(companyA);
    const asAccountantA = await activity(companyA, "", accountant);
    const asAdminB = await activity(companyB);

    // #then
    expect(entityIds(asAdminA)).toContain(categoryOfA);
    expect(entityIds(asAdminA)).not.toContain(categoryOfB);
    expect(asAccountantA).toEqual(asAdminA);
    expect(entityIds(asAdminB)).toEqual([categoryOfB]);
  });

  it("refuses employees", async () => {
    // #given
    const company = await createCompany(db);
    const employee = await createUser(db);
    await addMember(db, company, employee);
    await addCategory(company, "Courier");

    // #when
    const response = await sendJson(app, activityPath(company), employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("names the person who acted, and neither staff nor systems", async () => {
    // #given
    const company = await createCompany(db);
    await db
      .update(users)
      .set({ fullName: "Wanjiru Kamau" })
      .where(sql`${users.id} = ${company.admin.id}`);
    await addCategory(company, "Courier");
    await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
      actorType: "staff",
      actorId: randomUUID(),
      action: "payout.resolved",
    });

    // #when
    const page = await activity(company);

    // #then
    expect(
      page.entries.map(({ actor, action }) => ({ actor, action })),
    ).toEqual([
      {
        actor: { type: "user", name: "Wanjiru Kamau" },
        action: "category.created",
      },
      { actor: { type: "staff", name: null }, action: "payout.resolved" },
    ]);
  });

  it("leaves out the request ID, IP and device", async () => {
    // #given
    const company = await createCompany(db);
    await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
    });

    // #when
    const response = await sendJson(app, activityPath(company), company.admin);

    // #then
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("payout.paid");
    expect(text).not.toContain("203.0.113.9");
    expect(text).not.toContain("staff-browser");
    expect(text).not.toContain("req-1");
  });

  it("pages newest first, without gaps or repeats", async () => {
    // #given
    const company = await createCompany(db);
    const seeded = [];
    for (const day of ["01", "02", "03", "04", "05"]) {
      seeded.push(
        await seedEntry({
          organizationId: company.organizationId,
          occurredAt: `2026-10-${day}T09:00:00Z`,
        }),
      );
    }

    // #when
    const first = await activity(company, "?limit=2");
    const second = await activity(
      company,
      `?limit=2&cursor=${first.nextCursor ?? ""}`,
    );
    const third = await activity(
      company,
      `?limit=2&cursor=${second.nextCursor ?? ""}`,
    );

    // #then
    expect([...ids(first), ...ids(second), ...ids(third)]).toEqual(
      seeded.reverse(),
    );
    expect(first.nextCursor).not.toBeNull();
    expect(third.nextCursor).toBeNull();
  });

  it("filters by the start of the action and by Nairobi dates", async () => {
    // #given 00:30 on 1 Nov in Nairobi is still 31 Oct in UTC
    const company = await createCompany(db);
    const lateOctober = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-31T20:30:00Z",
      action: "payout.paid",
    });
    const firstOfNovember = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-31T21:30:00Z",
      action: "payout.paid",
    });
    const membership = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-11-01T08:00:00Z",
      action: "membership.invited",
    });

    // #when
    const payouts = await activity(company, "?actionPrefix=payout.");
    const november = await activity(company, "?from=2026-11-01&to=2026-11-01");
    const october = await activity(company, "?to=2026-10-31");

    // #then
    expect(ids(payouts)).toEqual([firstOfNovember, lateOctober]);
    expect(ids(november)).toEqual([membership, firstOfNovember]);
    expect(ids(october)).toEqual([lateOctober]);
  });

  it("refuses dates the wrong way round and a cursor it didn't make", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const answers = await Promise.all(
      ["?from=2026-11-02&to=2026-11-01", "?cursor=not-a-cursor"].map(
        async (query) =>
          (await sendJson(app, activityPath(company, query), company.admin))
            .status,
      ),
    );

    // #then
    expect(answers).toEqual([400, 400]);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/activity`,
    }));
  });
});

describe("company_activity_log()", () => {
  const readAll = (scope: Parameters<typeof runInScope>[1]) =>
    runInScope(db, scope, (tx) =>
      tx.execute<{ id: string }>(
        sql`SELECT id FROM company_activity_log(NULL, NULL, NULL, NULL, NULL, 200)`,
      ),
    ).then(({ rows }) => rows.map(({ id }) => id));

  it("returns only the company in context, and only to admins and accountants", async () => {
    // #given
    const { companyA, companyB } = fixture;
    const entryOfA = await seedEntry({
      organizationId: companyA.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
    });
    const entryOfB = await seedEntry({
      organizationId: companyB.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
    });
    const asA = { organizationId: companyA.organizationId };

    // #when
    const seen = {
      admin: await readAll({ ...asA, role: "admin" }),
      accountant: await readAll({ ...asA, role: "accountant" }),
      employee: await readAll({ ...asA, role: "employee" }),
      noRole: await readAll(asA),
      noCompany: await readAll({ role: "admin" }),
    };

    // #then
    expect(seen.admin).toContain(entryOfA);
    expect(seen.admin).not.toContain(entryOfB);
    expect(seen.accountant).toEqual(seen.admin);
    expect([seen.employee, seen.noRole, seen.noCompany]).toEqual([[], [], []]);
  });

  it("is the app's only way in: it still can't read audit_log itself", async () => {
    // #given
    const scope = {
      organizationId: fixture.companyA.organizationId,
      role: "admin" as const,
    };

    // #when
    const direct = runInScope(db, scope, (tx) =>
      tx.execute(sql`SELECT id FROM audit_log LIMIT 1`),
    );

    // #then
    await expect(direct).rejects.toMatchObject({
      cause: { code: "42501" },
    });
  });
});
