import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { CashOutProvider } from "@expendi-business/shared";
import {
  cashOutProviderConfirmedSchema,
  cashOutProviderControlSchema,
  cashOutProviderPreparedSchema,
  pausePreparedSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import { makeFakePaycrest, makeFakePretium } from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The active cash-out provider is one setting for every company, so this
 * runs apart from the main suite (vitest.serial.config.ts).
 */
const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let otherAdmin: TestStaff;
let viewer: TestStaff;
let testStartedAt: string;

const REASON = "Paycrest's KES liquidity has run dry for the day.";
const PATH = "/internal/controls/cash-out-provider";

async function resetPlatform(): Promise<void> {
  await owner.query(
    "UPDATE platform_settings SET active_cash_out_provider = 'paycrest', payouts_paused = false",
  );
}

beforeAll(async () => {
  runtime = makeTestRuntime({
    paycrest: paycrest.layer,
    pretium: pretium.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  [admin, otherAdmin, viewer] = await Promise.all([
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_admin" }),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await resetPlatform();
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  pretium.state.reset();
  await resetPlatform();
  const { rows } = await owner.query<{ now: string }>(
    "SELECT clock_timestamp()::text AS now",
  );
  testStartedAt = rows[0]?.now ?? "";
});

afterEach(() => {
  vi.useRealTimers();
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

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { _tag: string; message: string; details?: unknown };
  };
  return body.error;
}

const prepare = (
  provider = "pretium",
  staff: TestStaff = admin,
  reason: string = REASON,
) => post(`${PATH}/prepare`, staff, { provider, reason });

async function prepared(provider: CashOutProvider = "pretium") {
  const response = await prepare(provider);
  expect(response.status).toBe(201);
  return cashOutProviderPreparedSchema.parse(await dataOf(response));
}

const confirm = (token: string, staff: TestStaff = admin) =>
  post(`${PATH}/confirm`, staff, { token });

async function active(): Promise<string> {
  const { rows } = await owner.query<{ provider: string }>(
    "SELECT active_cash_out_provider AS provider FROM platform_settings",
  );
  return rows[0]?.provider ?? "missing";
}

async function changes() {
  const { rows } = await owner.query<Record<string, unknown>>(
    `SELECT actor_type, actor_id, organization_id, entity_type, entity_id,
            before, after, request_id, user_agent
     FROM audit_log
     WHERE action = 'platform.cash_out_provider_changed'
       AND actor_id = ANY($1) AND occurred_at >= $2::timestamptz
     ORDER BY occurred_at`,
    [[admin.staffUserId, otherAdmin.staffUserId], testStartedAt],
  );
  return rows;
}

async function spent(token: string): Promise<boolean> {
  const { rows } = await owner.query<{ used: boolean }>(
    "SELECT used_at IS NOT NULL AS used FROM staff_confirmations WHERE token_hash = $1",
    [createHash("sha256").update(token).digest("hex")],
  );
  return rows[0]?.used ?? false;
}

async function state() {
  const response = await app.request(PATH, {
    headers: bearer(viewer.privyUserId),
  });
  expect(response.status).toBe(200);
  return cashOutProviderControlSchema.parse(await dataOf(response));
}

describe("reading the active cash-out provider", () => {
  it("shows both providers' readiness to a viewer", async () => {
    // #given
    pretium.state.signingKeyConfigured = false;

    // #when
    const control = await state();

    // #then
    expect(control).toMatchObject({
      activeProvider: "paycrest",
      providers: [
        { provider: "paycrest", active: true, ready: true, problems: [] },
        {
          provider: "pretium",
          active: false,
          ready: false,
          problems: [
            "Pretium's webhook signing key (PRETIUM_WEBHOOK_SIGNING_KEY) isn't set, so its callbacks can't be trusted.",
          ],
        },
      ],
    });
  });

  it("reports Paycrest not answering", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const control = await state();

    // #then
    expect(control.providers[0]).toEqual({
      provider: "paycrest",
      active: true,
      ready: false,
      problems: ["Paycrest didn't answer a request for its rate."],
    });
  });

  it("says when staff last changed it", async () => {
    // #given
    const { token } = await prepared("pretium");
    await confirm(token);

    // #when
    const control = await state();

    // #then
    expect(control.activeProvider).toBe("pretium");
    expect(control.changedAt).not.toBeNull();
    expect(
      Math.abs(Date.parse(control.changedAt ?? "") - Date.now()),
    ).toBeLessThan(60_000);
  });
});

describe("preparing a change of cash-out provider", () => {
  it("changes nothing, and says what will happen", async () => {
    // #when
    const step = await prepared("pretium");

    // #then
    expect(step).toMatchObject({
      provider: "pretium",
      currentProvider: "paycrest",
      reason: REASON,
    });
    const said = step.consequences.join(" ");
    expect(said).toContain("go through Pretium");
    expect(said).toContain(
      "20 of the 40 banks in Expendi's catalogue can't be paid through Pretium",
    );
    expect(said).toContain("Audited under your name, with your reason.");
    expect(await active()).toBe("paycrest");
    expect(await changes()).toEqual([]);
  });

  it("counts the cash-outs waiting for approval and those already on their way", async () => {
    // #given
    const before = await prepared("pretium");
    const company = await createPayingCompany(runtime, db);
    await runtime.runPromise(
      preparePayouts({
        organizationId: company.company.organizationId,
        actor: { type: "user", id: company.company.admin.id },
        requests: [claimRequest()],
      }),
    );
    await payClaims(runtime, db, company, [claimRequest()]);

    // #when
    const after = await prepared("pretium");

    // #then
    expect({
      waiting: after.waitingForApproval - before.waitingForApproval,
      paycrest: after.inFlight.paycrest - before.inFlight.paycrest,
      pretium: after.inFlight.pretium - before.inFlight.pretium,
    }).toEqual({ waiting: 1, paycrest: 1, pretium: 0 });
    const said = after.consequences.join(" ");
    expect(said).toContain(
      `${after.waitingForApproval} cash-out${after.waitingForApproval === 1 ? "" : "s"} waiting for approval`,
    );
  });

  it("doesn't mention Pretium's banks when switching back to Paycrest", async () => {
    // #given
    const { token } = await prepared("pretium");
    await confirm(token);

    // #when
    const step = await prepared("paycrest");

    // #then
    expect(step.currentProvider).toBe("pretium");
    expect(step.consequences.join(" ")).not.toContain("banks");
  });

  it("refuses the provider that's already active", async () => {
    // #when
    const response = await prepare("paycrest");

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "Paycrest is already the active cash-out provider.",
    );
  });

  it.each<[string, (fake: typeof pretium.state) => void, string[]]>([
    [
      "isn't configured",
      (fake) => {
        fake.configured = false;
      },
      ["Pretium's API key (PRETIUM_API_KEY) isn't set."],
    ],
    [
      "settles to another address",
      (fake) => {
        fake.settlementAddress = "0x1111111111111111111111111111111111111111";
      },
      [expect.stringContaining("Pretium's Base USDC settlement address is")],
    ],
    [
      "isn't answering for its rate",
      (fake) => {
        fake.failRate = true;
      },
      ["Pretium didn't answer a request for its rate."],
    ],
  ])(
    "refuses Pretium while it %s, with the problems, and issues no token",
    async (_label, breakIt, problems) => {
      // #given
      breakIt(pretium.state);
      const { rows: tokens } = await owner.query<{ count: string }>(
        "SELECT count(*) FROM staff_confirmations WHERE staff_user_id = $1",
        [admin.staffUserId],
      );

      // #when
      const response = await prepare("pretium");

      // #then
      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.message).toMatch(/^Pretium isn't ready to take cash-outs/);
      expect(error.details).toEqual({ problems });
      const { rows: after } = await owner.query<{ count: string }>(
        "SELECT count(*) FROM staff_confirmations WHERE staff_user_id = $1",
        [admin.staffUserId],
      );
      expect(after).toEqual(tokens);
    },
  );

  it.each<[string, unknown, string]>([
    [
      "a reason",
      { provider: "pretium", reason: "because" },
      "Write why, in at least 10 characters.",
    ],
    [
      "a known provider",
      { provider: "mpesa", reason: REASON },
      "Choose Paycrest or Pretium.",
    ],
  ])("needs %s", async (_label, body, message) => {
    // #when
    const response = await post(`${PATH}/prepare`, admin, body);

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(message);
  });
});

describe("confirming a change of cash-out provider", () => {
  it("changes the setting, audited as the staff member with the reason and request", async () => {
    // #given
    const { token } = await prepared("pretium");

    // #when
    const response = await confirm(token);

    // #then
    expect(response.status).toBe(200);
    expect(
      cashOutProviderConfirmedSchema.parse(await dataOf(response)),
    ).toEqual({ activeProvider: "pretium", previousProvider: "paycrest" });
    expect(await active()).toBe("pretium");
    expect(await changes()).toEqual([
      {
        actor_type: "staff",
        actor_id: admin.staffUserId,
        organization_id: null,
        entity_type: "platform_settings",
        entity_id: "1",
        before: { activeCashOutProvider: "paycrest" },
        after: { activeCashOutProvider: "pretium", reason: REASON },
        request_id: response.headers.get("x-request-id"),
        user_agent: "ops-test",
      },
    ]);
  });

  it("applies once", async () => {
    // #given
    const { token } = await prepared("pretium");
    await confirm(token);

    // #when
    const again = await confirm(token);

    // #then
    expect(again.status).toBe(410);
    expect(await changes()).toHaveLength(1);
  });

  it("refuses an expired token", async () => {
    // #given
    const { token } = await prepared("pretium");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000);

    // #when
    const response = await confirm(token);

    // #then
    expect(response.status).toBe(410);
    expect((await errorOf(response)).message).toBe(
      "This confirmation expired. Start again.",
    );
    expect(await active()).toBe("paycrest");
  });

  it("refuses a token prepared by another staff member", async () => {
    // #given
    const { token } = await prepared("pretium");

    // #when
    const response = await confirm(token, otherAdmin);

    // #then
    expect(response.status).toBe(403);
    expect(await active()).toBe("paycrest");
  });

  it("refuses a confirmation that was never prepared", async () => {
    // #when
    const response = await confirm(randomUUID());

    // #then
    expect(response.status).toBe(400);
    expect(await active()).toBe("paycrest");
  });

  it("refuses a stored confirmation whose provider no longer matches its hash", async () => {
    // #given a forged row: a real Pretium confirmation's hash, its provider changed
    const { token } = await prepared("pretium");
    const forged = randomUUID();
    await owner.query(
      `INSERT INTO staff_confirmations
         (staff_user_id, purpose, target, params, token_hash, intent_hash, expires_at)
       SELECT staff_user_id, purpose, target,
              jsonb_build_object('provider', 'paycrest', 'reason', params ->> 'reason'),
              $1, intent_hash, expires_at
       FROM staff_confirmations WHERE token_hash = $2`,
      [
        createHash("sha256").update(forged).digest("hex"),
        createHash("sha256").update(token).digest("hex"),
      ],
    );

    // #when
    const response = await confirm(forged);

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(
      "This confirmation is for something else. Start again.",
    );
    expect(await active()).toBe("paycrest");
  });

  it("refuses a pause token, and its own token on the pause", async () => {
    // #given
    const pause = await post("/internal/controls/pause/prepare", admin, {
      scope: "platform",
      reason: REASON,
    });
    const { token: pauseToken } = pausePreparedSchema.parse(
      await dataOf(pause),
    );
    const { token } = await prepared("pretium");

    // #when
    const pauseHere = await confirm(pauseToken);
    const thisOnPause = await post("/internal/controls/pause/confirm", admin, {
      token,
    });

    // #then
    expect([pauseHere.status, thisOnPause.status]).toEqual([400, 400]);
    expect(await active()).toBe("paycrest");
    const { rows } = await owner.query<{ paused: boolean }>(
      "SELECT payouts_paused AS paused FROM platform_settings",
    );
    expect(rows).toEqual([{ paused: false }]);
    expect([await spent(pauseToken), await spent(token)]).toEqual([
      false,
      false,
    ]);
  });

  it("refuses when Pretium stops being ready after the review, and keeps the token usable", async () => {
    // #given
    const { token } = await prepared("pretium");
    pretium.state.settlementAddress =
      "0x1111111111111111111111111111111111111111";

    // #when
    const refused = await confirm(token);

    // #then
    expect(refused.status).toBe(409);
    expect((await errorOf(refused)).details).toEqual({
      problems: [
        expect.stringContaining("Pretium's Base USDC settlement address is"),
      ],
    });
    expect(await active()).toBe("paycrest");
    expect(await spent(token)).toBe(false);
    expect(await changes()).toEqual([]);

    // #and once Pretium is fixed, the same confirmation applies
    pretium.state.reset();
    expect((await confirm(token)).status).toBe(200);
    expect(await active()).toBe("pretium");
  });

  it("refuses when another change already made the provider active, leaving the token unspent", async () => {
    // #given
    const mine = await prepared("pretium");
    const theirs = await post(`${PATH}/prepare`, otherAdmin, {
      provider: "pretium",
      reason: REASON,
    });
    const { token: theirToken } = cashOutProviderPreparedSchema.parse(
      await dataOf(theirs),
    );
    await confirm(theirToken, otherAdmin);

    // #when
    const response = await confirm(mine.token);

    // #then
    expect(response.status).toBe(409);
    expect(await spent(mine.token)).toBe(false);
    expect(await changes()).toHaveLength(1);
  });
});

describe("the cash-out provider for staff who aren't ops admins", () => {
  it("lets a viewer look, but refuses preparing and confirming", async () => {
    // #given
    const { token } = await prepared("pretium");

    // #when
    const statuses = await Promise.all([
      Promise.resolve(
        app.request(PATH, { headers: bearer(viewer.privyUserId) }),
      ).then((response) => response.status),
      prepare("pretium", viewer).then((response) => response.status),
      confirm(token, viewer).then((response) => response.status),
    ]);

    // #then
    expect(statuses).toEqual([200, 403, 403]);
    expect(await active()).toBe("paycrest");
    expect(await spent(token)).toBe(false);
  });

  it("refuses to confirm for an admin who has become a viewer since preparing", async () => {
    // #given
    const demoted = await createStaff(owner, { role: "ops_admin" });
    const response = await prepare("pretium", demoted);
    const { token } = cashOutProviderPreparedSchema.parse(
      await dataOf(response),
    );
    await owner.query(
      "UPDATE staff_users SET role = 'ops_viewer' WHERE id = $1",
      [demoted.staffUserId],
    );

    // #when
    const refused = await confirm(token, demoted);

    // #then
    expect(refused.status).toBe(403);
    expect((await errorOf(refused))._tag).toBe("Forbidden");
    expect(await active()).toBe("paycrest");
    expect(await spent(token)).toBe(false);
  });
});

describe("the cash-out provider in the database", () => {
  it("can't be written by the API's role directly", async () => {
    // #when
    const attempt = db.execute(
      sql`UPDATE platform_settings SET active_cash_out_provider = 'pretium'`,
    );

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "42501" } });
    expect(await active()).toBe("paycrest");
  });
});
