import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  staffTreasuryConfirmedSchema,
  staffTreasuryPreparedSchema,
} from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { TestStaff } from "../helpers/staff.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import { bearer } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import {
  createTreasuryCompany,
  fundVault,
  runMoveToEnd,
  startMove,
  startMoveToWallet,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy } = world;
let db: Database;
let owner: pg.Pool;
let admin: TestStaff;
let viewer: TestStaff;
let company: TreasuryCompany;

const app = createApp({ runtime });

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  admin = await createStaff(owner, { role: "ops_admin" });
  viewer = await createStaff(owner, { role: "ops_viewer" });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.resetEarn();
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
  fundVault(world, company, 70n * USDC);
});

const url = (moveId: string, segment: string, step: "prepare" | "confirm") =>
  `/internal/companies/${company.tenant.organizationId}/treasury/moves/${moveId}/${segment}/${step}`;

const post = (path: string, staff: TestStaff, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

const REASON = "Checked the Treasury wallet and the vault in Privy.";

describe("the staff Treasury action routes", () => {
  it("resumes a return in two steps and the job then finishes it", async () => {
    // #given
    privy.state.nextSends("policy_violation");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    expect((await runMoveToEnd(world, db, company, move.id)).status).toBe(
      "needs_review",
    );

    // #when
    const prepared = await post(
      url(move.id, "resume-return", "prepare"),
      admin,
      {
        reason: REASON,
      },
    );
    const body = staffTreasuryPreparedSchema.parse(
      ((await prepared.json()) as { data: unknown }).data,
    );
    const quotesBefore = world.oneClick.state.quoteRequests.length;
    const sendsBefore = privy.state.sends.length;
    const confirmed = await post(
      url(move.id, "resume-return", "confirm"),
      admin,
      {
        token: body.token,
      },
    );
    const inTheRequest = [
      world.oneClick.state.quoteRequests.length - quotesBefore,
      privy.state.sends.length - sendsBefore,
    ];
    const done = await runMoveToEnd(world, db, company, move.id);

    // #then
    expect({
      prepared: prepared.status,
      amount: body.amountUsdc,
      confirmed: confirmed.status,
      inTheRequest,
      result: staffTreasuryConfirmedSchema.parse(
        ((await confirmed.json()) as { data: unknown }).data,
      ).action,
      done: done.status,
    }).toEqual({
      prepared: 201,
      amount: (20n * USDC).toString(),
      confirmed: 200,
      inTheRequest: [0, 0],
      result: "resume_return",
      done: "completed",
    });
  });

  it("returns a stranded deposit in two steps", async () => {
    // #given
    privy.state.nextEarnCalls("rejected", "rejected", "rejected");
    const move = await startMove(world, company, 20n * USDC);
    expect((await runMoveToEnd(world, db, company, move.id)).status).toBe(
      "needs_review",
    );

    // #when
    const prepared = await post(
      url(move.id, "return-stranded-deposit", "prepare"),
      admin,
      { reason: REASON },
    );
    const { token } = staffTreasuryPreparedSchema.parse(
      ((await prepared.json()) as { data: unknown }).data,
    );
    const confirmed = await post(
      url(move.id, "return-stranded-deposit", "confirm"),
      admin,
      { token },
    );
    const done = await runMoveToEnd(world, db, company, move.id);

    // #then
    expect([confirmed.status, done.status]).toEqual([200, "returned"]);
  });

  it("is for ops admins only, needs a written reason, and refuses a move that isn't under review", async () => {
    // #given an open move
    const move = await startMoveToWallet(world, company, 20n * USDC);
    const path = url(move.id, "resume-return", "prepare");

    // #when
    const statuses = await Promise.all([
      post(path, viewer, { reason: REASON }),
      post(url(move.id, "resume-return", "confirm"), viewer, { token: "x" }),
      post(path, admin, { reason: "short" }),
      post(path, admin, { reason: REASON }),
    ]).then((responses) => responses.map((response) => response.status));

    // #then
    expect(statuses).toEqual([403, 403, 400, 409]);
  });
});
