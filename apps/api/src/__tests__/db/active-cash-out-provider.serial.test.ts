import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StaffRole, StaffStatus } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { DatabaseService } from "../../db/client.js";
import { activeCashOutProvider } from "../../services/cash-out/active-provider.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The active cash-out provider is one setting for every company, so this
 * runs apart from the main suite (vitest.serial.config.ts).
 */
let runtime: AppRuntime;
let db: Database;
let owner: pg.Pool;
let admin: string;

const REASON = "Paycrest's KES liquidity has run dry for the day.";

/** Inserted as the owner role: the API's role can't write `staff_users`. */
async function staffUser(
  role: StaffRole,
  status: StaffStatus = "active",
): Promise<string> {
  const {
    rows: [row],
  } = await owner.query<{ id: string }>(
    "INSERT INTO staff_users (email, role, status) VALUES ($1, $2, $3) RETURNING id",
    [`staff-${randomUUID()}@expendi.test`, role, status],
  );
  if (!row) throw new Error("staff insert returned no row");
  return row.id;
}

function setProvider(
  provider: string,
  staffUserId: string,
  reason: string = REASON,
) {
  return db.execute<{ previous: string }>(
    sql`SELECT set_active_cash_out_provider(${provider}::cash_out_provider, ${staffUserId}::uuid, ${reason}, 'req-provider-test', '203.0.113.7', 'ops-test') AS previous`,
  );
}

function active(): Promise<string> {
  return db.transaction((tx) => Effect.runPromise(activeCashOutProvider(tx)));
}

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  admin = await staffUser("ops_admin");
});

afterAll(async () => {
  await owner.query(
    "UPDATE platform_settings SET active_cash_out_provider = 'paycrest'",
  );
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  await owner.query(
    "UPDATE platform_settings SET active_cash_out_provider = 'paycrest'",
  );
});

describe("the active cash-out provider", () => {
  it("is Paycrest until staff change it", async () => {
    expect(await active()).toBe("paycrest");
  });

  it("is Pretium once an ops admin switches to it", async () => {
    // #when
    const result = await setProvider("pretium", admin);

    // #then
    expect(result.rows).toEqual([{ previous: "paycrest" }]);
    expect(await active()).toBe("pretium");
  });

  it("is audited as the staff member, platform-wide, with the reason and request", async () => {
    // #when
    await setProvider("pretium", admin, `  ${REASON}  `);

    // #then
    const { rows } = await owner.query<Record<string, unknown>>(
      `SELECT actor_type, actor_id, organization_id, entity_type, entity_id,
              before, after, request_id, ip, user_agent
       FROM audit_log
       WHERE action = 'platform.cash_out_provider_changed' AND actor_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [admin],
    );
    expect(rows).toEqual([
      {
        actor_type: "staff",
        actor_id: admin,
        organization_id: null,
        entity_type: "platform_settings",
        entity_id: "1",
        before: { activeCashOutProvider: "paycrest" },
        after: { activeCashOutProvider: "pretium", reason: REASON },
        request_id: "req-provider-test",
        ip: "203.0.113.7",
        user_agent: "ops-test",
      },
    ]);
  });

  it("records the update on the settings row", async () => {
    // #when
    await setProvider("pretium", admin);

    // #then
    const { rows } = await owner.query<{ updated_by: string }>(
      "SELECT updated_by FROM platform_settings WHERE id = 1",
    );
    expect(rows).toEqual([{ updated_by: `staff:${admin}` }]);
  });

  it("can be set to the provider already active, and still audits it", async () => {
    // #given
    await setProvider("pretium", admin);

    // #when
    const result = await setProvider("pretium", admin);

    // #then
    expect(result.rows).toEqual([{ previous: "pretium" }]);
    expect(await active()).toBe("pretium");
    const { rows } = await owner.query<{ before: unknown }>(
      `SELECT before FROM audit_log
       WHERE action = 'platform.cash_out_provider_changed' AND actor_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [admin],
    );
    expect(rows).toEqual([{ before: { activeCashOutProvider: "pretium" } }]);
  });

  it("can't be written by the API's role directly", async () => {
    // #when
    const attempt = db.execute(
      sql`UPDATE platform_settings SET active_cash_out_provider = 'pretium'`,
    );

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await active()).toBe("paycrest");
  });

  it.each([
    ["an ops viewer", "ops_viewer", "active"],
    ["a disabled ops admin", "ops_admin", "disabled"],
  ] as const)("refuses %s", async (_label, role, status) => {
    // #given
    const staff = await staffUser(role, status);

    // #when
    const attempt = setProvider("pretium", staff);

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await active()).toBe("paycrest");
  });

  it("refuses an unknown staff member", async () => {
    // #when
    const attempt = setProvider("pretium", randomUUID());

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await active()).toBe("paycrest");
  });

  it("needs a written reason", async () => {
    // #when
    const attempt = setProvider("pretium", admin, "   too short   ");

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "23514" } });
    expect(await active()).toBe("paycrest");
  });

  it.each(["onchain", "mpesa"])("can't be %s", async (provider) => {
    // #when
    const attempt = setProvider(provider, admin);

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "22P02" } });
    expect(await active()).toBe("paycrest");
  });
});
