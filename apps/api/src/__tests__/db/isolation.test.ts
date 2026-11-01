import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Exit } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { assertRestrictedRole, DatabaseService } from "../../db/client.js";
import { runMigrations } from "../../db/migrate.js";
import * as schema from "../../db/schema/index.js";
import { memberships, organizations } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import {
  TEST_DATABASE_URL,
  TEST_DATABASE_URL_MIGRATE,
} from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("database role", () => {
  it("accepts the app role, which is neither owner nor superuser", async () => {
    // #given
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });

    // #when
    const exit = await Effect.runPromiseExit(assertRestrictedRole(pool));
    await pool.end();

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("refuses the owner role, which would bypass row-level security", async () => {
    // #given
    const pool = new pg.Pool({
      connectionString: TEST_DATABASE_URL_MIGRATE,
      max: 1,
    });

    // #when
    const exit = await Effect.runPromiseExit(assertRestrictedRole(pool));
    await pool.end();

    // #then
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { error: { _tag: "DatabaseError" } },
    });
  });
});

describe("row-level security", () => {
  it("isolates organizations with an unfiltered SELECT", async () => {
    await expectTableIsolation(fixture, "organizations", "id");
  });

  it("isolates memberships with an unfiltered SELECT", async () => {
    await expectTableIsolation(fixture, "memberships");
  });

  it("returns no memberships when no company is set", async () => {
    // #given a fresh connection with no app.org_id ever set
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });

    // #when
    const result = await pool.query("SELECT * FROM memberships");
    await pool.end();

    // #then
    expect(result.rows).toEqual([]);
  });

  it("does not leak a company's context to the next transaction on the same connection", async () => {
    // #given a single pooled connection that just ran as company A
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const singleConnection = drizzle(pool, { schema });
    await runInScope(
      singleConnection,
      {
        organizationId: fixture.companyA.organizationId,
        userId: fixture.companyA.admin.id,
      },
      (tx) => tx.select().from(memberships),
    );

    // #when
    const afterwards = await pool.query("SELECT * FROM memberships");
    await pool.end();

    // #then
    expect(afterwards.rows).toEqual([]);
  });

  it("rejects inserting a row for another company", async () => {
    // #given
    const { companyA, companyB } = fixture;
    const outsider = await createUser(db);

    // #when
    const attempt = runInScope(
      db,
      { organizationId: companyA.organizationId, userId: companyA.admin.id },
      (tx) =>
        tx.insert(memberships).values({
          organizationId: companyB.organizationId,
          userId: outsider.id,
          role: "admin",
          status: "active",
        }),
    );

    // #then
    await expect(attempt).rejects.toMatchObject({
      cause: {
        message: expect.stringContaining("row-level security") as unknown,
      },
    });
  });

  it("cannot update another company's rows", async () => {
    // #given
    const { companyA, companyB } = fixture;

    // #when
    const updated = await runInScope(
      db,
      { organizationId: companyA.organizationId, userId: companyA.admin.id },
      (tx) =>
        tx
          .update(organizations)
          .set({ name: "Hijacked" })
          .where(eq(organizations.id, companyB.organizationId))
          .returning({ id: organizations.id }),
    );

    // #then
    expect(updated).toEqual([]);
    const [companyBNow] = await runInScope(
      db,
      { organizationId: companyB.organizationId, userId: companyB.admin.id },
      (tx) => tx.select({ name: organizations.name }).from(organizations),
    );
    expect(companyBNow?.name).toBe(companyB.name);
  });

  it("lets a user see only their own memberships when no company is set", async () => {
    // #given a user in two companies, each with other members
    const first = await createCompany(db);
    const second = await createCompany(db);
    const user = await createUser(db);
    await addMember(db, first, user);
    await addMember(db, second, user);

    // #when
    const visible = await runInScope(db, { userId: user.id }, (tx) =>
      tx.execute<{ user_id: string; organization_id: string }>(
        sql`SELECT user_id::text, organization_id::text FROM memberships`,
      ),
    );

    // #then
    expect(visible.rows.map((row) => row.user_id)).toEqual([user.id, user.id]);
    expect(visible.rows.map((row) => row.organization_id).sort()).toEqual(
      [first.organizationId, second.organizationId].sort(),
    );
  });
});

describe("role context", () => {
  const currentRole = (tx: Pick<Database, "execute">) =>
    tx.execute<{ role: string | null }>(
      sql`SELECT app_current_role()::text AS role`,
    );

  it("exposes the caller's role to row-level security inside its transaction", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const result = await runInScope(
      db,
      {
        organizationId: companyA.organizationId,
        userId: companyA.admin.id,
        role: "employee",
      },
      currentRole,
    );

    // #then
    expect(result.rows).toEqual([{ role: "employee" }]);
  });

  it("has no role when the scope doesn't set one", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const result = await runInScope(
      db,
      { organizationId: companyA.organizationId, userId: companyA.admin.id },
      currentRole,
    );

    // #then
    expect(result.rows).toEqual([{ role: null }]);
  });

  it("does not leak the role to the next transaction on the same connection", async () => {
    // #given a single pooled connection that just ran as an admin
    const pool = new pg.Pool({ connectionString: TEST_DATABASE_URL, max: 1 });
    const singleConnection = drizzle(pool, { schema });
    await runInScope(
      singleConnection,
      {
        organizationId: fixture.companyA.organizationId,
        userId: fixture.companyA.admin.id,
        role: "admin",
      },
      currentRole,
    );

    // #when
    const afterwards = await pool.query<{ role: string | null }>(
      "SELECT app_current_role()::text AS role",
    );
    await pool.end();

    // #then
    expect(afterwards.rows).toEqual([{ role: null }]);
  });
});

describe("migrations", () => {
  it("change nothing when run again", async () => {
    // #given
    const owner = new pg.Pool({
      connectionString: TEST_DATABASE_URL_MIGRATE,
      max: 1,
    });
    const count = async () =>
      (
        await owner.query<{ n: number }>(
          "SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations",
        )
      ).rows[0]?.n;
    const before = await count();

    // #when
    await runMigrations(TEST_DATABASE_URL_MIGRATE);

    // #then
    expect(await count()).toBe(before);
    await owner.end();
  });
});
