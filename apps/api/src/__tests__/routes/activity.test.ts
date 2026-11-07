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
import { insertBill, insertPayee } from "../helpers/bills.js";
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
  readonly entityType?: string;
  readonly entityId?: string;
  readonly after?: Record<string, unknown>;
}

/** An entry written by the owner, e.g. at a set time or by a staff member. */
async function seedEntry(entry: SeededEntry): Promise<string> {
  const { rows } = await owner.query<{ id: string }>(
    `INSERT INTO audit_log
       (occurred_at, actor_type, actor_id, organization_id, action,
        entity_type, entity_id, after, request_id, ip, user_agent)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'req-1',
             '203.0.113.9', 'staff-browser')
     RETURNING id`,
    [
      entry.occurredAt,
      entry.actorType ?? "system",
      entry.actorId ?? "reconcile",
      entry.organizationId,
      entry.action ?? "payout.paid",
      entry.entityType ?? "payout",
      entry.entityId ?? randomUUID(),
      JSON.stringify(entry.after ?? { status: "paid" }),
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
        actor: { type: "user", id: company.admin.id, name: "Wanjiru Kamau" },
        action: "category.created",
      },
      {
        actor: { type: "staff", id: null, name: null },
        action: "payout.resolved",
      },
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

  it("filters by who acted: a person, Expendi's systems or its team", async () => {
    // #given
    const company = await createCompany(db);
    const colleague = await createUser(db);
    await addMember(db, company, colleague, { role: "admin" });
    const at = (hour: string) => `2026-10-01T${hour}:00:00Z`;
    const byAdmin = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: at("09"),
      actorType: "user",
      actorId: company.admin.id,
      action: "bill.updated",
    });
    const byColleague = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: at("10"),
      actorType: "user",
      actorId: colleague.id,
      action: "bill.updated",
    });
    const bySystem = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: at("11"),
    });
    const byStaff = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: at("12"),
      actorType: "staff",
      actorId: randomUUID(),
      action: "payout.resolved",
    });

    // #when
    const pages = await Promise.all(
      [company.admin.id, colleague.id, "system", "staff"].map((actor) =>
        activity(company, `?actor=${actor}`),
      ),
    );

    // #then
    expect(pages.map(ids)).toEqual([
      [byAdmin],
      [byColleague],
      [bySystem],
      [byStaff],
    ]);
    expect(pages[0]?.entries[0]?.actor.id).toBe(company.admin.id);
  });

  it("filters to one record, and to one kind of record", async () => {
    // #given
    const company = await createCompany(db);
    const billId = randomUUID();
    const forBill = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
      action: "bill.updated",
      entityType: "bill",
      entityId: billId,
    });
    const forOtherBill = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-01T10:00:00Z",
      action: "bill.updated",
      entityType: "bill",
    });
    await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-10-01T11:00:00Z",
    });

    // #when
    const oneBill = await activity(
      company,
      `?entityType=bill&entityId=${billId.toUpperCase()}`,
    );
    const allBills = await activity(company, "?entityType=bill");

    // #then
    expect(ids(oneBill)).toEqual([forBill]);
    expect(ids(allBills)).toEqual([forOtherBill, forBill]);
  });

  it("refuses a record ID without its type, and a person it can't read", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const answers = await Promise.all(
      [
        `?entityId=${randomUUID()}`,
        "?actor=someone",
        "?entityType=Bill;DROP",
      ].map(
        async (query) =>
          (await sendJson(app, activityPath(company, query), company.admin))
            .status,
      ),
    );

    // #then
    expect(answers).toEqual([400, 400, 400]);
  });

  it("finds a person's entries far back in the log, a page at a time", async () => {
    // #given one entry by the admin, under 450 by Expendi's systems
    const company = await createCompany(db);
    const theirs = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-01-01T09:00:00Z",
      actorType: "user",
      actorId: company.admin.id,
      action: "bill.updated",
    });
    await owner.query(
      `INSERT INTO audit_log
         (occurred_at, actor_type, actor_id, organization_id, action,
          entity_type, entity_id)
       SELECT '2026-02-01T00:00:00Z'::timestamptz + n * interval '1 minute',
              'system', 'reconcile', $1, 'payout.paid', 'payout',
              gen_random_uuid()::text
       FROM generate_series(1, 450) AS n`,
      [company.organizationId],
    );

    // #when
    const page = await activity(company, `?actor=${company.admin.id}`);

    // #then
    expect({ ids: ids(page), nextCursor: page.nextCursor }).toEqual({
      ids: [theirs],
      nextCursor: null,
    });
  });

  it("stops after a set number of reads with a cursor to carry on from", async () => {
    // #given 2,050 entries by Expendi's systems after the admin's one
    const company = await createCompany(db);
    const theirs = await seedEntry({
      organizationId: company.organizationId,
      occurredAt: "2026-01-01T09:00:00Z",
      actorType: "user",
      actorId: company.admin.id,
      action: "bill.updated",
    });
    await owner.query(
      `INSERT INTO audit_log
         (occurred_at, actor_type, actor_id, organization_id, action,
          entity_type, entity_id)
       SELECT '2026-02-01T00:00:00Z'::timestamptz + n * interval '1 minute',
              'system', 'reconcile', $1, 'payout.paid', 'payout',
              gen_random_uuid()::text
       FROM generate_series(1, 2050) AS n`,
      [company.organizationId],
    );

    // #when
    const first = await activity(company, `?actor=${company.admin.id}`);
    const second = await activity(
      company,
      `?actor=${company.admin.id}&cursor=${first.nextCursor ?? ""}`,
    );

    // #then
    expect({
      first: ids(first),
      carriesOn: first.nextCursor !== null,
      second: ids(second),
      end: second.nextCursor,
    }).toEqual({ first: [], carriesOn: true, second: [theirs], end: null });
  });

  it("names each record and ties payments approved together", async () => {
    // #given a category made through the API, and two bills paid with one passkey
    const company = await createCompany(db);
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    const categoryId = await addCategory(company, "Courier");
    const payeeId = await insertPayee(db, company, { name: "Twiga Foods" });
    const billIds = await Promise.all(
      [{ reference: "INV-4471" }, { reference: null, notes: "November" }].map(
        (values) => insertBill(db, company, { payeeId, categoryId, ...values }),
      ),
    );
    const approvalId = randomUUID();
    for (const [index, billId] of billIds.entries()) {
      await seedEntry({
        organizationId: company.organizationId,
        occurredAt: `2026-10-0${String(index + 1)}T09:00:00Z`,
        actorType: "user",
        actorId: company.admin.id,
        action: "bill.payment_approved",
        entityType: "bill",
        entityId: billId,
        after: { status: "paying", approvalId },
      });
    }

    // #when
    const asAdmin = await activity(company);
    const asAccountant = await activity(company, "", accountant);

    // #then
    const shown = (page: ActivityPage) =>
      page.entries.map(({ entity, approvalId: approval }) => ({
        label: entity.label,
        approval,
      }));
    expect(shown(asAdmin)).toEqual([
      { label: "Courier", approval: null },
      { label: "Twiga Foods, November", approval: approvalId },
      { label: "Twiga Foods, INV-4471", approval: approvalId },
    ]);
    expect(shown(asAccountant)).toEqual(shown(asAdmin));
  });

  it("names no record from another company", async () => {
    // #given an entry of A's that points at B's category
    const { companyA, companyB } = fixture;
    const categoryOfB = await addCategory(companyB, "Secret courier");
    const entry = await seedEntry({
      organizationId: companyA.organizationId,
      occurredAt: "2026-10-01T09:00:00Z",
      action: "category.updated",
      entityType: "category",
      entityId: categoryOfB,
    });

    // #when
    const page = await activity(
      companyA,
      `?entityType=category&entityId=${categoryOfB}`,
    );

    // #then
    expect(page.entries.map(({ id, entity }) => [id, entity.label])).toEqual([
      [entry, null],
    ]);
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
