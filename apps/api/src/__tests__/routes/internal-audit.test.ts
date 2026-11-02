import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { AuditEntry, AuditSearchQuery } from "@expendi-business/shared";
import { auditSearchResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { createCompany } from "../helpers/db.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createNonStaffLogin, createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [admin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

interface SeedEntry {
  readonly occurredAt?: string;
  readonly actorType?: "user" | "staff" | "system";
  readonly actorId?: string;
  readonly organizationId?: string | null;
  readonly action?: string;
  readonly entityType?: string;
  readonly entityId?: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
}

/** Entries written as the owner, the way only a migration or ops could. */
async function seed(entries: readonly SeedEntry[]): Promise<string[]> {
  const ids: string[] = [];
  for (const entry of entries) {
    const {
      rows: [row],
    } = await owner.query<{ id: string }>(
      `INSERT INTO audit_log
         (occurred_at, actor_type, actor_id, organization_id, action,
          entity_type, entity_id, before, after)
       VALUES (coalesce($1::timestamptz, now()), $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        entry.occurredAt ?? null,
        entry.actorType ?? "system",
        entry.actorId ?? "t27-test",
        entry.organizationId ?? null,
        entry.action ?? "test.seeded",
        entry.entityType ?? "test",
        entry.entityId ?? null,
        entry.before === undefined ? null : JSON.stringify(entry.before),
        entry.after === undefined ? null : JSON.stringify(entry.after),
      ],
    );
    if (!row) throw new Error("audit insert returned no row");
    ids.push(row.id);
  }
  return ids;
}

/** A value no other test uses, to keep each search to its own entries. */
const marker = (): string => `t27-${randomUUID()}`;

/** A raw query string's values, so a test can also send what the type forbids. */
type RawQuery = Readonly<Record<string, string | number | undefined>>;

async function search(
  params: AuditSearchQuery | RawQuery,
  staff: TestStaff = admin,
): Promise<Response> {
  const query = new URLSearchParams(
    Object.entries(params).flatMap(([key, value]): [string, string][] =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  );
  return app.request(`/internal/audit?${query.toString()}`, {
    headers: bearer(staff.privyUserId),
  });
}

async function page(
  params: AuditSearchQuery,
  staff: TestStaff = admin,
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const response = await search(params, staff);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return auditSearchResponseSchema.parse(body.data);
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { _tag: string; message: string };
  };
  return body.error;
}

describe("GET /internal/audit access", () => {
  it("returns 401 without a token", async () => {
    // #when
    const response = await app.request("/internal/audit");

    // #then
    expect(response.status).toBe(401);
  });

  it("returns 403 to an email that isn't on the staff list", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const response = await app.request("/internal/audit", {
      headers: bearer(login.privyUserId),
    });

    // #then
    expect(response.status).toBe(403);
  });

  it("returns 403 to a company admin who isn't staff", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const response = await app.request("/internal/audit", {
      headers: bearer(company.admin.privyUserId),
    });

    // #then
    expect(response.status).toBe(403);
  });

  it("lets an ops viewer search", async () => {
    // #given
    const entityType = marker();
    await seed([{ entityType }]);

    // #when
    const result = await page({ entityType }, viewer);

    // #then
    expect(result.entries).toHaveLength(1);
  });

  it("refuses every way of writing to the audit log", async () => {
    // #when
    const statuses = await Promise.all(
      ["POST", "PUT", "PATCH", "DELETE"].map(
        async (method) =>
          (
            await app.request("/internal/audit", {
              method,
              headers: {
                ...bearer(admin.privyUserId),
                "content-type": "application/json",
              },
              body: method === "DELETE" ? undefined : "{}",
            })
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual([404, 404, 404, 404]);
  });
});

describe("GET /internal/audit filters", () => {
  let companyA: TestCompany;
  let companyB: TestCompany;

  beforeAll(async () => {
    [companyA, companyB] = await Promise.all([
      createCompany(db),
      createCompany(db),
    ]);
  });

  it("finds a company's entries, with the company's name", async () => {
    // #given
    const action = marker();
    const [inA] = await seed([
      { organizationId: companyA.organizationId, action },
      { organizationId: companyB.organizationId, action },
      { organizationId: null, action },
    ]);

    // #when
    const result = await page({
      organizationId: companyA.organizationId,
      action,
    });

    // #then
    expect(result.entries.map((entry) => entry.id)).toEqual([inA]);
    expect(result.entries[0]?.organization).toEqual({
      id: companyA.organizationId,
      name: companyA.name,
    });
  });

  it("finds an actor's entries by type and ID, with their email", async () => {
    // #given
    const entityType = marker();
    const other = await createStaff(owner);
    const [byAdmin, , byUser] = await seed([
      { actorType: "staff", actorId: admin.staffUserId, entityType },
      { actorType: "staff", actorId: other.staffUserId, entityType },
      { actorType: "user", actorId: companyA.admin.id, entityType },
      { actorType: "system", actorId: "paycrest-sync", entityType },
    ]);

    // #when
    const staffEntries = await page({
      entityType,
      actorType: "staff",
      actorId: admin.staffUserId,
    });
    const userEntries = await page({
      entityType,
      actorType: "user",
      actorId: companyA.admin.id,
    });
    const systemEntries = await page({ entityType, actorType: "system" });

    // #then
    expect(staffEntries.entries.map((entry) => entry.id)).toEqual([byAdmin]);
    expect(staffEntries.entries[0]?.actor).toEqual({
      type: "staff",
      id: admin.staffUserId,
      email: admin.email,
    });
    expect(userEntries.entries.map((entry) => entry.id)).toEqual([byUser]);
    expect(userEntries.entries[0]?.actor.email).toBe(companyA.admin.email);
    expect(systemEntries.entries.map((entry) => entry.actor)).toEqual([
      { type: "system", id: "paycrest-sync", email: null },
    ]);
  });

  it("still names a disabled staff member", async () => {
    // #given
    const entityType = marker();
    const former = await createStaff(owner, { status: "disabled" });
    await seed([
      { actorType: "staff", actorId: former.staffUserId, entityType },
    ]);

    // #when
    const result = await page({ entityType });

    // #then
    expect(result.entries[0]?.actor.email).toBe(former.email);
  });

  it("matches an exact action, or an action prefix taken literally", async () => {
    // #given
    const tag = randomUUID().slice(0, 8);
    const [paid, paidLate, underscored] = await seed([
      { action: `t27${tag}.paid` },
      { action: `t27${tag}.paid_late` },
      { action: `t27_${tag}.paid` },
      { action: `t27x${tag}.paid` },
    ]);

    // #when
    const exact = await page({ action: `t27${tag}.paid` });
    const prefix = await page({ actionPrefix: `t27${tag}.` });
    const literalUnderscore = await page({ actionPrefix: `t27_${tag}.` });

    // #then
    expect(exact.entries.map((entry) => entry.id)).toEqual([paid]);
    expect(new Set(prefix.entries.map((entry) => entry.id))).toEqual(
      new Set([paid, paidLate]),
    );
    expect(literalUnderscore.entries.map((entry) => entry.id)).toEqual([
      underscored,
    ]);
  });

  it("finds an entity's entries by type and ID", async () => {
    // #given
    const entityType = marker();
    const entityId = randomUUID();
    const [match] = await seed([
      { entityType, entityId },
      { entityType, entityId: randomUUID() },
      { entityType: marker(), entityId },
    ]);

    // #when
    const result = await page({ entityType, entityId });

    // #then
    expect(result.entries.map((entry) => entry.id)).toEqual([match]);
  });

  it("combines filters", async () => {
    // #given
    const action = marker();
    const [match] = await seed([
      {
        action,
        organizationId: companyB.organizationId,
        actorType: "staff",
        actorId: admin.staffUserId,
      },
      { action, organizationId: companyB.organizationId },
      { action, actorType: "staff", actorId: admin.staffUserId },
    ]);

    // #when
    const result = await page({
      action,
      organizationId: companyB.organizationId,
      actorType: "staff",
      actorId: admin.staffUserId,
    });

    // #then
    expect(result.entries.map((entry) => entry.id)).toEqual([match]);
  });

  it("returns before and after exactly as stored", async () => {
    // #given
    const entityType = marker();
    const before = {
      status: "needs_review",
      amounts: ["1500", 2],
      nested: { a: null },
    };
    const after = { status: "paid", note: "Settled — M-Pesa QX12", flag: true };
    await seed([{ entityType, before, after }]);

    // #when
    const result = await page({ entityType });

    // #then
    expect(result.entries[0]).toMatchObject({ before, after });
  });

  it.each<[string, RawQuery, string]>([
    [
      "an exact action and a prefix together",
      { action: "payout.paid", actionPrefix: "payout." },
      "Search by an exact action or an action prefix, not both.",
    ],
    [
      "a start date after the end date",
      { from: "2026-11-02", to: "2026-11-01" },
      "The start date is after the end date.",
    ],
    [
      "a date that isn't a calendar date",
      { from: "02/11/2026" },
      "Use a date like 2026-11-02.",
    ],
    [
      "an unreadable cursor",
      { cursor: "not-a-cursor" },
      "This page of results is out of date. Search again.",
    ],
    ["an unknown actor type", { actorType: "robot" }, "Invalid option"],
  ])("refuses %s", async (_label, params, message) => {
    // #when
    const response = await search(params);

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain(message);
  });
});

describe("GET /internal/audit dates, in Nairobi time", () => {
  it("counts a day from Nairobi midnight to Nairobi midnight, both ends inclusive", async () => {
    // #given Nairobi is UTC+3: 1 November there is 31 Oct 21:00Z to 1 Nov 21:00Z.
    const entityType = marker();
    const [, firstMoment, lastMoment] = await seed([
      { entityType, occurredAt: "2026-10-31T20:59:59.999999Z" },
      { entityType, occurredAt: "2026-10-31T21:00:00.000000Z" },
      { entityType, occurredAt: "2026-11-01T20:59:59.999999Z" },
      { entityType, occurredAt: "2026-11-01T21:00:00.000000Z" },
    ]);

    // #when
    const oneDay = await page({
      entityType,
      from: "2026-11-01",
      to: "2026-11-01",
    });

    // #then
    expect(oneDay.entries.map((entry) => entry.id)).toEqual([
      lastMoment,
      firstMoment,
    ]);
  });

  it("applies an open-ended range from either side", async () => {
    // #given
    const entityType = marker();
    const [early, late] = await seed([
      { entityType, occurredAt: "2026-10-31T20:59:59Z" },
      { entityType, occurredAt: "2026-10-31T21:00:00Z" },
    ]);

    // #when
    const fromNovember = await page({ entityType, from: "2026-11-01" });
    const untilOctober = await page({ entityType, to: "2026-10-31" });

    // #then
    expect(fromNovember.entries.map((entry) => entry.id)).toEqual([late]);
    expect(untilOctober.entries.map((entry) => entry.id)).toEqual([early]);
  });
});

describe("GET /internal/audit pages", () => {
  async function allPages(
    params: AuditSearchQuery,
    between: () => Promise<void> = () => Promise.resolve(),
  ): Promise<AuditEntry[][]> {
    const pages: AuditEntry[][] = [];
    let cursor: string | undefined;
    do {
      const result = await page({ ...params, cursor });
      pages.push(result.entries);
      cursor = result.nextCursor ?? undefined;
      await between();
    } while (cursor);
    return pages;
  }

  it("walks newest first without skipping or repeating, ties and microseconds included", async () => {
    // #given seven entries, four sharing one timestamp and two a microsecond apart
    const entityType = marker();
    const ids = await seed([
      { entityType, occurredAt: "2026-11-02T08:00:00.000001Z" },
      { entityType, occurredAt: "2026-11-02T08:00:00.000002Z" },
      { entityType, occurredAt: "2026-11-02T09:00:00Z" },
      { entityType, occurredAt: "2026-11-02T09:00:00Z" },
      { entityType, occurredAt: "2026-11-02T09:00:00Z" },
      { entityType, occurredAt: "2026-11-02T09:00:00Z" },
      { entityType, occurredAt: "2026-11-02T10:00:00Z" },
    ]);
    const { rows: expected } = await owner.query<{ id: string }>(
      "SELECT id FROM audit_log WHERE entity_type = $1 ORDER BY occurred_at DESC, id DESC",
      [entityType],
    );

    // #when
    const pages = await allPages({ entityType, limit: 3 });

    // #then
    expect(pages.map((entries) => entries.length)).toEqual([3, 3, 1]);
    expect(pages.flat().map((entry) => entry.id)).toEqual(
      expected.map((row) => row.id),
    );
    expect(new Set(pages.flat().map((entry) => entry.id))).toEqual(
      new Set(ids),
    );
  });

  it("keeps later pages stable while new entries arrive", async () => {
    // #given
    const entityType = marker();
    await seed(
      Array.from({ length: 5 }, (_, index) => ({
        entityType,
        occurredAt: `2026-11-02T0${index}:00:00Z`,
      })),
    );
    const before = (await allPages({ entityType, limit: 2 })).flat();

    // #when a newer entry lands after every page is read
    const during = (
      await allPages({ entityType, limit: 2 }, async () => {
        await seed([{ entityType, occurredAt: "2027-01-01T00:00:00Z" }]);
      })
    ).flat();

    // #then
    expect(during.map((entry) => entry.id)).toEqual(
      before.map((entry) => entry.id),
    );
  });

  it("ends with no cursor on an exactly full last page", async () => {
    // #given
    const entityType = marker();
    await seed([{ entityType }, { entityType }]);

    // #when
    const result = await page({ entityType, limit: 2 });

    // #then
    expect(result.entries).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });
});
