import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  controlsResponseSchema,
  pausePreparedSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { makeFakePaycrest } from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The platform-wide pause stops every company's payouts, so this runs
 * apart from the main suite (vitest.serial.config.ts).
 */
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;

const REASON = "Paycrest reported an incident on their status page.";

beforeAll(async () => {
  runtime = makeTestRuntime({ paycrest: paycrest.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  [admin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await owner.query("UPDATE platform_settings SET payouts_paused = false");
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  await owner.query("UPDATE platform_settings SET payouts_paused = false");
});

async function post(
  path: string,
  staff: TestStaff,
  body: unknown,
): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
      "user-agent": "ops-test",
    },
    body: JSON.stringify(body),
  });
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function toggle(action: "pause" | "unpause"): Promise<Response> {
  const prepared = await post(`/internal/controls/${action}/prepare`, admin, {
    scope: "platform",
    reason: REASON,
  });
  expect(prepared.status).toBe(201);
  const { token } = pausePreparedSchema.parse(await dataOf(prepared));
  return post(`/internal/controls/${action}/confirm`, admin, { token });
}

async function platformPaused(): Promise<boolean> {
  const response = await app.request("/internal/controls", {
    headers: bearer(viewer.privyUserId),
  });
  return controlsResponseSchema.parse(await dataOf(response))
    .platformPayoutsPaused;
}

describe("pausing every company's payouts", () => {
  it("refuses the next approval at any company, with no order", async () => {
    // #given
    const [first, second] = await Promise.all([
      createPayingCompany(runtime, db),
      createPayingCompany(runtime, db),
    ]);
    expect((await toggle("pause")).status).toBe(200);

    // #when
    const attempts = [
      payClaims(runtime, db, first, [claimRequest()]),
      payClaims(runtime, db, second, [claimRequest()]),
    ];

    // #then
    await Promise.all(
      attempts.map((attempt) =>
        expect(attempt).rejects.toThrow("Payouts are paused"),
      ),
    );
    expect(paycrest.state.created).toHaveLength(0);
  });

  it("is audited as the staff member, platform-wide, with the reason and request", async () => {
    // #when
    const response = await toggle("pause");

    // #then
    const { rows } = await owner.query<Record<string, unknown>>(
      `SELECT actor_type, actor_id, organization_id, entity_type, entity_id,
              before, after, request_id, user_agent
       FROM audit_log WHERE action = 'platform.payouts_paused' AND actor_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [admin.staffUserId],
    );
    expect(rows).toEqual([
      {
        actor_type: "staff",
        actor_id: admin.staffUserId,
        organization_id: null,
        entity_type: "platform_settings",
        entity_id: "1",
        before: { payoutsPaused: false },
        after: { payoutsPaused: true, reason: REASON },
        request_id: response.headers.get("x-request-id"),
        user_agent: "ops-test",
      },
    ]);
  });

  it("pays again once unpaused", async () => {
    // #given
    await toggle("pause");
    expect(await platformPaused()).toBe(true);

    // #when
    const response = await toggle("unpause");
    const paying = await createPayingCompany(runtime, db);
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);

    // #then
    expect(response.status).toBe(200);
    expect(await platformPaused()).toBe(false);
    expect(payout?.status).toBe("paying");
  });
});

describe("the platform pause in the database", () => {
  it("can't be written by the API's role directly", async () => {
    // #when
    const attempt = db.execute(
      sql`UPDATE platform_settings SET payouts_paused = true`,
    );

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await platformPaused()).toBe(false);
  });

  it.each([
    ["an ops viewer", "viewer", REASON],
    ["an ops admin without a reason", "admin", "   short "],
  ] as const)(
    "refuses %s even through its function",
    async (_label, who, reason) => {
      // #given
      const staff = who === "viewer" ? viewer : admin;

      // #when
      const attempt = db.execute(
        sql`SELECT set_platform_payouts_paused(true, ${staff.staffUserId}::uuid, ${reason}, null, null, null)`,
      );

      // #then
      await expect(attempt).rejects.toThrow();
      expect(await platformPaused()).toBe(false);
    },
  );
});
