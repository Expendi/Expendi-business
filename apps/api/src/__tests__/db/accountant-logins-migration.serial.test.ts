import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { createCompany, createUser, randomEmail } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * Replays the accountant-logins migrations (T46) against memberships in the
 * shape they had before them: an accountant as an email and a name with no
 * user. Each case runs in a transaction that is rolled back, and it alters
 * `memberships`, so this runs apart from the main suite
 * (vitest.serial.config.ts).
 */
const DRIZZLE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../drizzle",
);

function migrationStatements(name: string): string[] {
  const file = readdirSync(DRIZZLE_DIR).find((entry) =>
    entry.endsWith(`_${name}.sql`),
  );
  if (!file) throw new Error(`no migration named ${name}`);
  return readFileSync(path.join(DRIZZLE_DIR, file), "utf8")
    .split("--> statement-breakpoint")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Puts back what `memberships_require_user` removes. The checks skip rows
 * already there, which follow today's rules.
 */
const BEFORE_ACCOUNTANT_LOGINS = [
  `ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY`,
  `ALTER TABLE memberships
     ALTER COLUMN user_id DROP NOT NULL,
     ADD COLUMN email text,
     ADD COLUMN full_name text,
     ADD CONSTRAINT memberships_email_lowercase
       CHECK (email = lower(email)) NOT VALID,
     ADD CONSTRAINT memberships_identity_check
       CHECK ((role = 'accountant' AND email IS NOT NULL) OR (role <> 'accountant' AND user_id IS NOT NULL)) NOT VALID`,
  `CREATE UNIQUE INDEX memberships_organization_email_unique
     ON memberships (organization_id, email) WHERE email IS NOT NULL`,
];

let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let companyA: TestCompany;
let companyB: TestCompany;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  [companyA, companyB] = await Promise.all([
    createCompany(db),
    createCompany(db),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

interface Client {
  query: pg.PoolClient["query"];
}

/** Runs `work` on the old shape, then rolls everything back. */
async function onTheOldShape<T>(
  work: (client: Client) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    for (const statement of BEFORE_ACCOUNTANT_LOGINS) {
      await client.query(statement);
    }
    return await work(client);
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
}

async function addEmailOnlyAccountant(
  client: Client,
  company: TestCompany,
  email: string,
  fullName: string,
  status: "active" | "removed" = "active",
): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO memberships (organization_id, role, status, email, full_name, invited_by, invited_at)
     VALUES ($1, 'accountant', $2, $3, $4, $5, now()) RETURNING id`,
    [company.organizationId, status, email, fullName, company.admin.id],
  );
  const [row] = rows;
  if (!row) throw new Error("membership insert returned no row");
  return row.id;
}

async function migrate(client: Client): Promise<void> {
  for (const statement of [
    ...migrationStatements("accountant_logins"),
    ...migrationStatements("memberships_require_user"),
  ]) {
    await client.query(statement);
  }
  await client.query("ALTER TABLE memberships NO FORCE ROW LEVEL SECURITY");
}

async function membership(client: Client, id: string) {
  const { rows } = await client.query<{
    user_id: string;
    role: string;
    status: string;
    email: string;
    privy_user_id: string | null;
    full_name: string | null;
  }>(
    `SELECT m.user_id, m.role, m.status, u.email, u.privy_user_id, u.full_name
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.id = $1`,
    [id],
  );
  return rows[0];
}

describe("accountant logins migration", () => {
  it("links an email-only accountant to a new user with their name, keeping their status", async () => {
    // #given
    const email = randomEmail();

    // #when
    const result = await onTheOldShape(async (client) => {
      const id = await addEmailOnlyAccountant(client, companyA, email, "Grace");
      await migrate(client);
      const { rows: audit } = await client.query<{
        action: string;
        actor_id: string;
        after: unknown;
      }>(
        `SELECT action, actor_id, after FROM audit_log
         WHERE entity_type = 'membership' AND entity_id = $1`,
        [id],
      );
      return { linked: await membership(client, id), audit };
    });

    // #then
    expect(result.linked).toEqual({
      user_id: expect.any(String) as string,
      role: "accountant",
      status: "active",
      email,
      privy_user_id: null,
      full_name: "Grace",
    });
    expect(result.audit).toEqual([
      {
        action: "membership.linked",
        actor_id: "accountant-logins-migration",
        after: {
          userId: result.linked?.user_id,
          email,
          role: "accountant",
          status: "active",
        },
      },
    ]);
  });

  it("links to the user who already signs in with that email, and keeps their name", async () => {
    // #given
    const existing: TestUser = await createUser(db);
    await owner.query(`UPDATE users SET full_name = 'Grace W.' WHERE id = $1`, [
      existing.id,
    ]);

    // #when
    const linked = await onTheOldShape(async (client) => {
      const id = await addEmailOnlyAccountant(
        client,
        companyA,
        existing.email,
        "G.",
        "removed",
      );
      await migrate(client);
      return membership(client, id);
    });

    // #then
    expect(linked).toMatchObject({
      user_id: existing.id,
      status: "removed",
      privy_user_id: existing.privyUserId,
      full_name: "Grace W.",
    });
  });

  it("gives an accountant of several companies one user", async () => {
    // #given
    const email = randomEmail();

    // #when
    const users = await onTheOldShape(async (client) => {
      const inA = await addEmailOnlyAccountant(
        client,
        companyA,
        email,
        "Grace",
      );
      const inB = await addEmailOnlyAccountant(
        client,
        companyB,
        email,
        "Grace",
      );
      await migrate(client);
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE email = $1`,
        [email],
      );
      return {
        a: (await membership(client, inA))?.user_id,
        b: (await membership(client, inB))?.user_id,
        rows,
      };
    });

    // #then
    expect(users.rows).toHaveLength(1);
    expect([users.a, users.b]).toEqual([users.rows[0]?.id, users.rows[0]?.id]);
  });

  it("stops the deploy when the accountant's email already has a membership in that company", async () => {
    // #when the company's own admin was also added as its accountant
    const migrating = onTheOldShape(async (client) => {
      await addEmailOnlyAccountant(
        client,
        companyB,
        companyB.admin.email,
        "Owner",
        "removed",
      );
      await migrate(client);
    });

    // #then
    await expect(migrating).rejects.toThrow(
      "an accountant's email already has a membership in the same company",
    );
  });
});
