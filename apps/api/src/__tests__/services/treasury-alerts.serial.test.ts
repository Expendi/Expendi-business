import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { OpsAlertKind } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { runAlerts } from "../../services/alerts/run-alerts.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import {
  createTreasuryCompany,
  fundVault,
  readActions,
  runMoveToEnd,
  setBaseBalance,
  startMove,
  startMoveToWallet,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The Treasury alerts look across every company, so they run here, one file
 * at a time. Assertions are about the companies this file made.
 */

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy, base } = world;
let db: Database;
let owner: pg.Pool;
const made: TreasuryCompany[] = [];

const RESOLVE_OPEN_ALERTS =
  "UPDATE ops_alerts SET resolved_at = now() WHERE kind::text LIKE 'treasury_%' AND resolved_at IS NULL";

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  await owner.query(RESOLVE_OPEN_ALERTS);
});

afterEach(async () => {
  base.state.failNextCalls(0);
  for (const paying of made.splice(0)) {
    setBaseBalance(world, paying.treasuryAddress, 0n);
    await moves(
      "UPDATE treasury_moves SET status = 'failed', settled_at = now() WHERE organization_id = $1 AND status IN ('open', 'needs_review')",
      [paying.tenant.organizationId],
    );
  }
});

afterAll(async () => {
  await owner.query(RESOLVE_OPEN_ALERTS);
  await Promise.all([runtime.dispose(), owner.end()]);
});

/**
 * Runs `statement` as the table's owner, which row-level security still
 * binds (it is FORCEd): the table is released from it for the length of one
 * transaction, which only this file, running alone, sees.
 */
async function asOwnerOf(
  table: "treasury_moves" | "treasury_earn_actions",
  statement: string,
  params: readonly unknown[] = [],
): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${table} NO FORCE ROW LEVEL SECURITY`);
    await client.query(statement, [...params]);
    await client.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

const moves = (statement: string, params?: readonly unknown[]) =>
  asOwnerOf("treasury_moves", statement, params);
const actions = (statement: string, params?: readonly unknown[]) =>
  asOwnerOf("treasury_earn_actions", statement, params);

const runChecks = () => runtime.runPromise(runAlerts());

async function company(): Promise<TreasuryCompany> {
  const created = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 100n * USDC,
  });
  made.push(created);
  return created;
}

interface Incident {
  readonly title: string;
  readonly details: readonly { label: string; value: string }[];
  readonly resolved: boolean;
}

/** Every incident of `kind` about `subjectKey`, oldest first. */
async function incidents(
  kind: OpsAlertKind,
  subjectKey: string,
): Promise<Incident[]> {
  const { rows } = await owner.query<{
    title: string;
    details: Incident["details"];
    resolved_at: Date | null;
  }>(
    "SELECT title, details, resolved_at FROM ops_alerts WHERE kind = $1 AND subject_key = $2 ORDER BY opened_at, id",
    [kind, subjectKey],
  );
  return rows.map((row) => ({
    title: row.title,
    details: row.details,
    resolved: row.resolved_at !== null,
  }));
}

/** [open, resolved] incident counts, so "opened once" and "resolved" read the same way. */
async function tally(kind: OpsAlertKind, subjectKey: string) {
  const all = await incidents(kind, subjectKey);
  return [
    all.filter((incident) => !incident.resolved).length,
    all.filter((incident) => incident.resolved).length,
  ];
}

const detail = (incident: Incident | undefined, label: string) =>
  incident?.details.find((line) => line.label === label)?.value;

/** A move to Treasury run to the end, and what the vault took for it. */
async function moveIn(paying: TreasuryCompany, amount: bigint) {
  const move = await startMove(world, paying, amount);
  const done = await runMoveToEnd(world, db, paying, move.id);
  expect(done.status).toBe("completed");
  return done;
}

/** Makes what a company's moves and Earn calls settled `minutes` ago. */
async function ageSettled(paying: TreasuryCompany, minutes: number) {
  const orgId = paying.tenant.organizationId;
  await moves(
    "UPDATE treasury_moves SET settled_at = now() - make_interval(mins => $2) WHERE organization_id = $1 AND settled_at IS NOT NULL",
    [orgId, minutes],
  );
  await actions(
    "UPDATE treasury_earn_actions SET settled_at = now() - make_interval(mins => $2) WHERE organization_id = $1 AND settled_at IS NOT NULL",
    [orgId, minutes],
  );
}

const startedAgo = (moveId: string, minutes: number) =>
  moves(
    "UPDATE treasury_moves SET created_at = now() - make_interval(mins => $2) WHERE id = $1",
    [moveId, minutes],
  );

const orgId = (paying: TreasuryCompany) => paying.tenant.organizationId;

describe("a move not settled after 30 minutes", () => {
  it("opens once when a move is still open after 30 minutes, whichever way it goes", async () => {
    // #given a move to Treasury started 31 minutes ago, and one to the wallet
    const toTreasury = await company();
    const toWallet = await company();
    fundVault(world, toWallet, 40n * USDC);
    const a = await startMove(world, toTreasury, 20n * USDC);
    const b = await startMoveToWallet(world, toWallet, 10n * USDC);
    await startedAgo(a.id, 31);
    await startedAgo(b.id, 31);

    // #when it checks twice
    await runChecks();
    await runChecks();

    // #then each opened one incident
    expect({
      toTreasury: await tally("treasury_move_stuck", a.id),
      toWallet: await tally("treasury_move_stuck", b.id),
      title: (await incidents("treasury_move_stuck", a.id))[0]?.title,
    }).toEqual({
      toTreasury: [1, 0],
      toWallet: [1, 0],
      title: expect.stringContaining("to Treasury") as string,
    });
  });

  it("stays quiet for a move that is only 10 minutes old", async () => {
    // #given
    const paying = await company();
    const move = await startMove(world, paying, 20n * USDC);
    await startedAgo(move.id, 10);

    // #when
    await runChecks();

    // #then
    expect(await tally("treasury_move_stuck", move.id)).toEqual([0, 0]);
  });

  it("counts a move under review until a person settles it, then resolves", async () => {
    // #given an old move that went to needs_review
    const paying = await company();
    const move = await startMove(world, paying, 20n * USDC);
    await startedAgo(move.id, 45);
    await moves(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );

    // #when it checks, and the move is still under review
    await runChecks();
    await runChecks();
    const whileReviewed = await tally("treasury_move_stuck", move.id);
    const status = detail(
      (await incidents("treasury_move_stuck", move.id))[0],
      "Status",
    );

    // #and when a person settles it
    await moves(
      "UPDATE treasury_moves SET status = 'returned', settled_at = now() WHERE id = $1",
      [move.id],
    );
    await runChecks();

    // #then
    expect({
      whileReviewed,
      status,
      settled: await tally("treasury_move_stuck", move.id),
    }).toEqual({
      whileReviewed: [1, 0],
      status: "needs review",
      settled: [0, 1],
    });
  });

  it("resolves when the move settles", async () => {
    // #given an old open move that then completes
    const paying = await company();
    const move = await startMove(world, paying, 20n * USDC);
    await startedAgo(move.id, 31);
    await runChecks();

    // #when
    await runMoveToEnd(world, db, paying, move.id);
    await runChecks();

    // #then
    expect(await tally("treasury_move_stuck", move.id)).toEqual([0, 1]);
  });
});

describe("USDC sitting in a Treasury wallet with no move open", () => {
  it("opens once, and resolves when the USDC is gone", async () => {
    // #given 5 USDC in the Treasury wallet and no move
    const paying = await company();
    setBaseBalance(world, paying.treasuryAddress, 5n * USDC);

    // #when
    await runChecks();
    await runChecks();
    const open = await tally("treasury_usdc_idle", orgId(paying));
    const held = detail(
      (await incidents("treasury_usdc_idle", orgId(paying)))[0],
      "In the Treasury wallet",
    );
    setBaseBalance(world, paying.treasuryAddress, 0n);
    await runChecks();

    // #then
    expect({
      open,
      held,
      after: await tally("treasury_usdc_idle", orgId(paying)),
    }).toEqual({ open: [1, 0], held: "5 USDC", after: [0, 1] });
  });

  it("stays quiet for dust, and while a move is open", async () => {
    // #given exactly dust in one wallet, and 5 USDC in another with a move open
    const dusty = await company();
    setBaseBalance(world, dusty.treasuryAddress, 1n * USDC);
    const moving = await company();
    setBaseBalance(world, moving.treasuryAddress, 5n * USDC);
    await startMove(world, moving, 20n * USDC);

    // #when
    await runChecks();

    // #then
    expect({
      dust: await tally("treasury_usdc_idle", orgId(dusty)),
      moving: await tally("treasury_usdc_idle", orgId(moving)),
    }).toEqual({ dust: [0, 0], moving: [0, 0] });
  });

  it("names a move to the wallet in needs_review as the likely reason", async () => {
    // #given a move to the wallet under review, with its USDC in the Treasury wallet
    const paying = await company();
    fundVault(world, paying, 40n * USDC);
    const move = await startMoveToWallet(world, paying, 10n * USDC);
    await moves(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );
    setBaseBalance(world, paying.treasuryAddress, 10n * USDC);

    // #when
    await runChecks();

    // #then
    const [incident] = await incidents("treasury_usdc_idle", orgId(paying));
    expect(detail(incident, "Likely reason")).toBe(
      `A move to the wallet (${move.id}) is in needs review.`,
    );
  });

  it("names a move to Treasury in needs_review too", async () => {
    // #given
    const paying = await company();
    const move = await startMove(world, paying, 20n * USDC);
    await moves(
      "UPDATE treasury_moves SET status = 'needs_review' WHERE id = $1",
      [move.id],
    );
    setBaseBalance(world, paying.treasuryAddress, 7n * USDC);

    // #when
    await runChecks();

    // #then
    const [incident] = await incidents("treasury_usdc_idle", orgId(paying));
    expect(detail(incident, "Likely reason")).toBe(
      `A move to Treasury (${move.id}) is in needs review.`,
    );
  });

  it("gives no reason when no move is under review", async () => {
    // #given
    const paying = await company();
    setBaseBalance(world, paying.treasuryAddress, 5n * USDC);

    // #when
    await runChecks();

    // #then
    const [incident] = await incidents("treasury_usdc_idle", orgId(paying));
    expect(detail(incident, "Likely reason")).toBeUndefined();
  });

  it("leaves an open alert as it is when Base can't be read", async () => {
    // #given an open alert and then a Base that fails
    const paying = await company();
    setBaseBalance(world, paying.treasuryAddress, 5n * USDC);
    await runChecks();
    setBaseBalance(world, paying.treasuryAddress, 0n);
    base.state.failNextCalls(1_000);

    // #when
    await runChecks();
    const whileDown = await tally("treasury_usdc_idle", orgId(paying));
    base.state.failNextCalls(0);
    await runChecks();

    // #then it only resolves once the balance can be read
    expect({
      whileDown,
      after: await tally("treasury_usdc_idle", orgId(paying)),
    }).toEqual({ whileDown: [1, 0], after: [0, 1] });
  });
});

describe("a position at Privy that doesn't match Expendi's moves", () => {
  /** What Privy reports as ever deposited and withdrawn. */
  const privyDeposited = (
    paying: TreasuryCompany,
    deposited: bigint,
    withdrawn = 0n,
  ) =>
    privy.state.setVaultTotals(paying.treasuryPrivyWalletId, {
      deposited,
      withdrawn,
    });

  async function movedIn(): Promise<{
    paying: TreasuryCompany;
    took: bigint;
  }> {
    const paying = await company();
    await moveIn(paying, 40n * USDC);
    const took = (await readActions(db, paying))
      .filter((a) => a.kind === "deposit" && a.status === "succeeded")
      .reduce((sum, a) => sum + a.rawAmount, 0n);
    return { paying, took };
  }

  it("waits out Privy's lag: nothing opens while the last move settled minutes ago", async () => {
    // #given totals that disagree, right after a move settled
    const { paying, took } = await movedIn();
    privyDeposited(paying, took - 1n);

    // #when
    await runChecks();

    // #then
    expect(await tally("treasury_position_mismatch", orgId(paying))).toEqual([
      0, 0,
    ]);
  });

  it("opens once when they still disagree after the lag, and resolves when they agree", async () => {
    // #given the same, 10 minutes later
    const { paying, took } = await movedIn();
    privyDeposited(paying, took - 1n);
    await ageSettled(paying, 10);

    // #when
    await runChecks();
    await runChecks();
    const open = await tally("treasury_position_mismatch", orgId(paying));
    privyDeposited(paying, took);
    await runChecks();

    // #then
    expect({
      open,
      after: await tally("treasury_position_mismatch", orgId(paying)),
    }).toEqual({ open: [1, 0], after: [0, 1] });
  });

  it("stays quiet when totals match, however much yield the position has made", async () => {
    // #given a position worth 3 USDC more than was put in
    const { paying, took } = await movedIn();
    privy.state.setVaultAssets(paying.treasuryPrivyWalletId, took + 3n * USDC);
    await ageSettled(paying, 10);

    // #when
    await runChecks();

    // #then
    expect(await tally("treasury_position_mismatch", orgId(paying))).toEqual([
      0, 0,
    ]);
  });

  it("compares what was withdrawn too", async () => {
    // #given 10 USDC moved out, which Privy doesn't know about
    const { paying, took } = await movedIn();
    const out = await startMoveToWallet(world, paying, 10n * USDC);
    await runMoveToEnd(world, db, paying, out.id);
    privyDeposited(paying, took, 0n);
    await ageSettled(paying, 10);

    // #when
    await runChecks();
    const missing = await tally("treasury_position_mismatch", orgId(paying));
    privyDeposited(paying, took, 10n * USDC);
    await runChecks();

    // #then
    expect({
      missing,
      after: await tally("treasury_position_mismatch", orgId(paying)),
    }).toEqual({ missing: [1, 0], after: [0, 1] });
  });

  it("doesn't compare while a move is open, and keeps an alert already open", async () => {
    // #given an open alert, then a new move started
    const { paying, took } = await movedIn();
    privyDeposited(paying, took - 1n);
    await ageSettled(paying, 10);
    await runChecks();
    await startMove(world, paying, 20n * USDC);
    privyDeposited(paying, took);

    // #when
    await runChecks();

    // #then the open move means nothing is compared, so the alert stays
    expect(await tally("treasury_position_mismatch", orgId(paying))).toEqual([
      1, 0,
    ]);
  });

  it("opens nothing for a company with no moves and no position", async () => {
    // #given
    const paying = await company();

    // #when
    await runChecks();

    // #then
    expect(await tally("treasury_position_mismatch", orgId(paying))).toEqual([
      0, 0,
    ]);
  });

  it("leaves an open alert as it is when Privy can't be read", async () => {
    // #given an open alert and a Privy that then fails
    const { paying, took } = await movedIn();
    privyDeposited(paying, took - 1n);
    await ageSettled(paying, 10);
    await runChecks();
    privyDeposited(paying, took);
    privy.state.failNext("vaultPosition", 1_000);

    // #when
    await runChecks();
    const whileDown = await tally("treasury_position_mismatch", orgId(paying));
    privy.state.failNext("vaultPosition", 0);
    await runChecks();

    // #then
    expect({
      whileDown,
      after: await tally("treasury_position_mismatch", orgId(paying)),
    }).toEqual({ whileDown: [1, 0], after: [0, 1] });
  });
});

describe("a vault withdrawal that filled in part", () => {
  async function withdraw(asked: bigint, fill?: bigint) {
    const paying = await company();
    fundVault(world, paying, 40n * USDC);
    if (fill !== undefined) privy.state.nextWithdrawalFills(fill);
    const move = await startMoveToWallet(world, paying, asked);
    const done = await runMoveToEnd(world, db, paying, move.id);
    expect(done.status).toBe("completed");
    return { paying, move };
  }

  it("opens once with what was asked and what arrived, and resolves after a day", async () => {
    // #given 20 USDC asked and 12 delivered
    const { move } = await withdraw(20n * USDC, 12n * USDC);

    // #when
    await runChecks();
    await runChecks();
    const open = await tally("treasury_partial_fill", move.id);
    const [incident] = await incidents("treasury_partial_fill", move.id);

    // #and when the fill is over a day old
    await actions(
      "UPDATE treasury_earn_actions SET settled_at = now() - interval '25 hours' WHERE treasury_move_id = $1",
      [move.id],
    );
    await runChecks();

    // #then
    expect({
      open,
      asked: detail(incident, "Asked"),
      delivered: detail(incident, "Delivered"),
      after: await tally("treasury_partial_fill", move.id),
    }).toEqual({
      open: [1, 0],
      asked: "20 USDC",
      delivered: "12 USDC",
      after: [0, 1],
    });
  });

  it("stays quiet for a withdrawal that filled in full", async () => {
    // #given
    const { move } = await withdraw(20n * USDC);

    // #when
    await runChecks();

    // #then
    expect(await tally("treasury_partial_fill", move.id)).toEqual([0, 0]);
  });
});
