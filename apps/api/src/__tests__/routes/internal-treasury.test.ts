import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StaffTreasury } from "@expendi-business/shared";
import { staffTreasurySchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { TestStaff } from "../helpers/staff.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { createCompany } from "../helpers/db.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import { bearer } from "../helpers/runtime.js";
import { createNonStaffLogin, createStaff } from "../helpers/staff.js";
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
let app: App;
let owner: pg.Pool;
let viewer: TestStaff;
let company: TreasuryCompany;
const alertIds: string[] = [];

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  viewer = await createStaff(owner, { role: "ops_viewer" });
});

afterAll(async () => {
  await owner.query(
    "UPDATE ops_alerts SET resolved_at = now() WHERE id = ANY($1::uuid[])",
    [alertIds],
  );
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

const path = (organizationId: string) =>
  `/internal/companies/${organizationId}/treasury`;

const get = (organizationId: string, staff: TestStaff | null = viewer) =>
  app.request(path(organizationId), {
    headers: staff ? bearer(staff.privyUserId) : {},
  });

async function treasuryOf(target: TreasuryCompany): Promise<StaffTreasury> {
  const response = await get(target.tenant.organizationId);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return staffTreasurySchema.parse(body.data);
}

async function onMoves(target: TreasuryCompany) {
  const treasury = await treasuryOf(target);
  if (treasury.status !== "on") throw new Error("Treasury isn't on");
  return treasury;
}

async function openAlert(
  organizationId: string | null,
  kind: string,
  title: string,
) {
  const {
    rows: [row],
  } = await owner.query<{ id: string }>(
    "INSERT INTO ops_alerts (kind, subject_key, organization_id, title, details) VALUES ($1::ops_alert_kind, $2, $3, $4, '[]'::jsonb) RETURNING id",
    [kind, `test-${randomUUID()}`, organizationId, title],
  );
  if (!row) throw new Error("alert insert returned no row");
  alertIds.push(row.id);
}

describe("a company's Treasury for staff", () => {
  it("shows both directions of a move with their quotes, Earn calls and ledger rows", async () => {
    // #given a completed move each way
    const toTreasury = await startMove(world, company, 25n * USDC);
    await runMoveToEnd(world, db, company, toTreasury.id);
    const toWallet = await startMoveToWallet(world, company, 20n * USDC);
    await runMoveToEnd(world, db, company, toWallet.id);

    // #when
    const treasury = await onMoves(company);

    // #then
    const move = (id: string) => treasury.moves.find((row) => row.id === id);
    const inbound = move(toTreasury.id);
    const outbound = move(toWallet.id);
    expect({
      order: treasury.moves.map((row) => row.id),
      inbound: {
        status: inbound?.status,
        quotes: inbound?.quotes.map((quote) => [
          quote.purpose,
          quote.status,
          quote.oneClickStatus,
        ]),
        calls: inbound?.earnActions.map((call) => [
          call.kind,
          call.attempt,
          call.status,
          call.privyActionId !== null,
          call.txHash !== null,
        ]),
        ledger: inbound?.ledger.map((row) => row.type),
        debit: inbound?.ledger.every((row) => BigInt(row.usdcAmount) < 0n),
        hashes: inbound?.quotes.every((quote) => quote.depositTxHash !== null),
        action: inbound?.action,
      },
      outbound: {
        status: outbound?.status,
        quotes: outbound?.quotes.map((quote) => [
          quote.purpose,
          quote.status,
          quote.oneClickStatus,
        ]),
        calls: outbound?.earnActions.map((call) => [
          call.kind,
          call.status,
          call.deliveredUsdc,
        ]),
        ledger: outbound?.ledger.map((row) => row.type),
        credit: outbound?.ledger.every((row) => BigInt(row.usdcAmount) > 0n),
        action: outbound?.action,
      },
    }).toEqual({
      order: [toWallet.id, toTreasury.id],
      inbound: {
        status: "completed",
        quotes: [["to_treasury", "succeeded", "SUCCESS"]],
        calls: [["deposit", 1, "succeeded", true, true]],
        ledger: ["to_treasury"],
        debit: true,
        hashes: true,
        action: null,
      },
      outbound: {
        status: "completed",
        quotes: [["from_treasury", "succeeded", "SUCCESS"]],
        calls: [["withdraw", "succeeded", (20n * USDC).toString()]],
        ledger: ["from_treasury"],
        credit: true,
        action: null,
      },
    });
  });

  it("shows the Treasury wallet and Privy's live position", async () => {
    // #when
    const treasury = await onMoves(company);

    // #then
    expect(treasury).toMatchObject({
      status: "on",
      address: company.treasuryAddress,
      position: {
        state: "read",
        assetsInVault: (70n * USDC).toString(),
      },
      alerts: [],
      moves: [],
    });
  });

  it("says Privy couldn't be read instead of failing, and still shows the moves", async () => {
    // #given
    const move = await startMove(world, company, 10n * USDC);
    privy.state.failNext("vaultPosition");

    // #when
    const treasury = await onMoves(company);

    // #then
    expect(treasury.position).toEqual({
      state: "unreadable",
      message: expect.any(String) as string,
    });
    expect(treasury.moves.map((row) => row.id)).toEqual([move.id]);
  });

  it("is off for a company that hasn't turned Treasury on, and a 404 for one that doesn't exist", async () => {
    // #given
    const plain = await createCompany(db);

    // #when
    const off = await get(plain.organizationId);
    const missing = await get(randomUUID());
    const malformed = await get("not-a-company");

    // #then
    expect({
      off: [off.status, ((await off.json()) as { data: unknown }).data],
      missing: missing.status,
      malformed: malformed.status,
    }).toEqual({
      off: [200, { status: "off" }],
      missing: 404,
      malformed: 404,
    });
  });

  it("lists this company's open Treasury alerts only", async () => {
    // #given an open alert here, one for another company, a resolved one, and a non-Treasury one
    const other = await createTreasuryCompany(world, db);
    await openAlert(
      company.tenant.organizationId,
      "treasury_move_stuck",
      "A Treasury move isn't settled",
    );
    await openAlert(
      other.tenant.organizationId,
      "treasury_usdc_idle",
      "USDC idle elsewhere",
    );
    await openAlert(
      company.tenant.organizationId,
      "low_company_balance",
      "Low balance",
    );

    // #when
    const treasury = await onMoves(company);

    // #then
    expect(treasury.alerts.map((alert) => [alert.kind, alert.title])).toEqual([
      ["treasury_move_stuck", "A Treasury move isn't settled"],
    ]);
  });

  it("offers the right action on a move under review, and none otherwise", async () => {
    // #given a stranded deposit
    privy.state.nextEarnCalls("rejected", "rejected", "rejected");
    const stranded = await startMove(world, company, 20n * USDC);
    const reviewed = await runMoveToEnd(world, db, company, stranded.id);
    expect(reviewed.status).toBe("needs_review");

    // #when
    const treasury = await onMoves(company);

    // #then
    const [move] = treasury.moves;
    expect(move?.action).toEqual({
      kind: "return_stranded_deposit",
      amountUsdc: expect.stringMatching(/^\d+$/) as string,
    });
    expect(move?.earnActions.map((call) => call.status)).toEqual([
      "rejected",
      "rejected",
      "rejected",
    ]);
  });

  it("offers to resume a return that didn't finish, for what is still owed", async () => {
    // #given a delivery whose return Privy refused to send
    privy.state.nextSends("policy_violation");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    const reviewed = await runMoveToEnd(world, db, company, move.id);
    expect(reviewed.status).toBe("needs_review");

    // #when
    const treasury = await onMoves(company);

    // #then
    expect(treasury.moves[0]?.action).toEqual({
      kind: "resume_return",
      amountUsdc: (20n * USDC).toString(),
    });
  });

  it("keeps each company's moves to itself", async () => {
    // #given
    const other = await createTreasuryCompany(world, db, {
      balance: 100n * USDC,
    });
    const mine = await startMove(world, company, 10n * USDC);
    const theirs = await startMove(world, other, 10n * USDC);

    // #when
    const [here, there] = await Promise.all([onMoves(company), onMoves(other)]);

    // #then
    expect([
      here.moves.map((row) => row.id),
      there.moves.map((row) => row.id),
    ]).toEqual([[mine.id], [theirs.id]]);
  });
});

describe("who may see it", () => {
  it("is read-only for every staff role, and refused to everyone else", async () => {
    // #given
    const admin = await createStaff(owner, { role: "ops_admin" });
    const login = createNonStaffLogin();

    // #when
    const statuses = await Promise.all([
      get(company.tenant.organizationId, viewer),
      get(company.tenant.organizationId, admin),
      get(company.tenant.organizationId, null),
      app.request(path(company.tenant.organizationId), {
        headers: bearer(login.privyUserId),
      }),
      app.request(path(company.tenant.organizationId), {
        method: "POST",
        headers: bearer(viewer.privyUserId),
      }),
    ]).then((responses) => responses.map((response) => response.status));

    // #then
    expect(statuses).toEqual([200, 200, 401, 403, 404]);
  });
});
