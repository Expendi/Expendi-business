import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { PausePrepareRequest } from "@expendi-business/shared";
import {
  companyDetailSchema,
  controlsResponseSchema,
  pauseConfirmedSchema,
  pausePreparedSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { makeFakePaycrest, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * One company's pause. The platform-wide pause stops every company, so it
 * is tested on its own in `internal-platform-pause.serial.test.ts`.
 */
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;
let paying: PayingCompany;

const REASON = "Suspected fraud reported by the company's CFO.";

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
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
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
    error: { _tag: string; message: string };
  };
  return body.error;
}

const companyPause = (
  organizationId = paying.company.organizationId,
  reason = REASON,
): PausePrepareRequest => ({ scope: "company", organizationId, reason });

async function prepared(
  action: "pause" | "unpause",
  request: PausePrepareRequest = companyPause(),
) {
  const response = await post(
    `/internal/controls/${action}/prepare`,
    admin,
    request,
  );
  expect(response.status).toBe(201);
  return pausePreparedSchema.parse(await dataOf(response));
}

async function confirmed(action: "pause" | "unpause", token: string) {
  return post(`/internal/controls/${action}/confirm`, admin, { token });
}

async function companyPaused(): Promise<boolean> {
  const response = await app.request(
    `/internal/companies/${paying.company.organizationId}`,
    { headers: bearer(viewer.privyUserId) },
  );
  return companyDetailSchema.parse(await dataOf(response)).payoutsPaused;
}

async function auditFor(action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    organization_id: string | null;
    entity_type: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT actor_type, actor_id, organization_id, entity_type, before, after
     FROM audit_log WHERE action = $1 AND entity_id = $2`,
    [action, paying.company.organizationId],
  );
  return rows;
}

describe("pausing one company's payouts", () => {
  it("changes nothing until confirmed, and says what will happen", async () => {
    // #when
    const step = await prepared("pause");

    // #then
    expect(step).toMatchObject({
      action: "pause",
      scope: "company",
      organization: {
        id: paying.company.organizationId,
        name: paying.company.name,
      },
      currentlyPaused: false,
      reason: REASON,
    });
    expect(step.consequences.join(" ")).toContain("no money moves");
    expect(await companyPaused()).toBe(false);
  });

  it("pauses on confirmation, audited as the staff member with the reason", async () => {
    // #given
    const { token } = await prepared("pause");

    // #when
    const response = await confirmed("pause", token);

    // #then
    expect(pauseConfirmedSchema.parse(await dataOf(response))).toEqual({
      scope: "company",
      organizationId: paying.company.organizationId,
      payoutsPaused: true,
    });
    expect(await companyPaused()).toBe(true);
    expect(await auditFor("organization.payouts_paused")).toEqual([
      {
        actor_type: "staff",
        actor_id: admin.staffUserId,
        organization_id: paying.company.organizationId,
        entity_type: "organization",
        before: { payoutsPaused: false },
        after: { payoutsPaused: true, reason: REASON },
      },
    ]);
  });

  it("refuses an approval already on its way once the pause is confirmed, with no order", async () => {
    // #given an admin has a payout ready and the approval challenge in hand
    const { company, passkey } = paying;
    const [payout] = await runtime.runPromise(
      preparePayouts({
        organizationId: company.organizationId,
        actor: { type: "user", id: company.admin.id },
        requests: [claimRequest()],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: company.organizationId,
        userId: company.admin.id,
        payoutIds: [payout?.id ?? ""],
      }),
    );
    const { token } = await prepared("pause");
    await confirmed("pause", token);

    // #when
    const attempt = runtime.runPromise(
      approveAndPay({
        organizationId: company.organizationId,
        userId: company.admin.id,
        challengeId: approval.challengeId,
        response: passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then
    await expect(attempt).rejects.toThrow("Payouts are paused");
    expect(paycrest.state.created).toHaveLength(0);
  });

  it("leaves other companies paying", async () => {
    // #given
    const other = await createPayingCompany(runtime, db);
    const { token } = await prepared("pause");
    await confirmed("pause", token);

    // #when
    const [payout] = await payClaims(runtime, db, other, [claimRequest()]);

    // #then
    expect(payout?.status).toBe("paying");
  });

  it("lists the paused company under controls", async () => {
    // #given
    const { token } = await prepared("pause");
    await confirmed("pause", token);

    // #when
    const response = await app.request("/internal/controls", {
      headers: bearer(viewer.privyUserId),
    });

    // #then
    const controls = controlsResponseSchema.parse(await dataOf(response));
    expect(controls.pausedCompanies.map((company) => company.id)).toContain(
      paying.company.organizationId,
    );
  });

  it("refuses to pause a company that's already paused", async () => {
    // #given
    const { token } = await prepared("pause");
    await confirmed("pause", token);

    // #when
    const response = await post(
      "/internal/controls/pause/prepare",
      admin,
      companyPause(),
    );

    // #then
    expect(response.status).toBe(409);
  });
});

describe("unpausing one company's payouts", () => {
  beforeEach(async () => {
    const { token } = await prepared("pause");
    await confirmed("pause", token);
  });

  it("lets payouts be approved again, audited with the reason", async () => {
    // #given
    const { token } = await prepared("unpause");

    // #when
    const response = await confirmed("unpause", token);
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);

    // #then
    expect(response.status).toBe(200);
    expect(payout?.status).toBe("paying");
    expect(await auditFor("organization.payouts_unpaused")).toEqual([
      expect.objectContaining({
        actor_type: "staff",
        before: { payoutsPaused: true },
        after: { payoutsPaused: false, reason: REASON },
      }),
    ]);
  });

  it("refuses a pause token on the unpause step", async () => {
    // #given
    const { token } = await prepared("unpause");
    await confirmed("unpause", token);
    const pause = await prepared("pause");

    // #when
    const response = await confirmed("unpause", pause.token);

    // #then
    expect(response.status).toBe(400);
    expect(await companyPaused()).toBe(false);
  });
});

describe("the pause's second confirmation", () => {
  it("refuses a confirmation that was never prepared", async () => {
    // #when
    const response = await confirmed("pause", randomUUID());

    // #then
    expect(response.status).toBe(400);
    expect(await companyPaused()).toBe(false);
  });

  it("applies once", async () => {
    // #given
    const { token } = await prepared("pause");
    await confirmed("pause", token);

    // #when
    const again = await confirmed("pause", token);

    // #then
    expect(again.status).toBe(410);
    expect(await auditFor("organization.payouts_paused")).toHaveLength(1);
  });

  it.each<[string, unknown, string]>([
    [
      "a reason",
      { scope: "company", organizationId: randomUUID(), reason: "because" },
      "Write why, in at least 10 characters.",
    ],
    [
      "a company for a company pause",
      { scope: "company", reason: REASON },
      "Choose a company to pause, or pause all companies.",
    ],
  ])("needs %s", async (_label, body, message) => {
    // #when
    const response = await post(
      "/internal/controls/pause/prepare",
      admin,
      body,
    );

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toBe(message);
  });

  it("returns 404 for a company that doesn't exist", async () => {
    // #when
    const response = await post(
      "/internal/controls/pause/prepare",
      admin,
      companyPause(randomUUID()),
    );

    // #then
    expect(response.status).toBe(404);
  });
});

describe("viewers on controls", () => {
  it("can look but every pause action is refused", async () => {
    // #given
    const { token } = await prepared("pause");

    // #when
    const statuses = await Promise.all([
      Promise.resolve(
        app.request("/internal/controls", {
          headers: bearer(viewer.privyUserId),
        }),
      ).then((response) => response.status),
      post("/internal/controls/pause/prepare", viewer, companyPause()).then(
        (response) => response.status,
      ),
      post("/internal/controls/pause/confirm", viewer, { token }).then(
        (response) => response.status,
      ),
      post("/internal/controls/unpause/prepare", viewer, companyPause()).then(
        (response) => response.status,
      ),
      post("/internal/controls/unpause/confirm", viewer, { token }).then(
        (response) => response.status,
      ),
    ]);

    // #then
    expect(statuses).toEqual([200, 403, 403, 403, 403]);
    expect(await companyPaused()).toBe(false);
  });
});
