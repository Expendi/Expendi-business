import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { treasurySnapshots } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { writeTreasurySnapshots } from "../../services/treasury/snapshots.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
} from "../helpers/near-payouts.js";
import {
  createTreasuryCompany,
  fundVault,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The job looks across every company, so it runs here, one file at a time.
 * Assertions are about the companies this file made.
 */

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy } = world;
let db: Database;
let owner: pg.Pool;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  privy.state.setVaultApy(519);
});

/** 23:50 on 10 Nov in Nairobi, and 00:05 on 11 Nov. */
const BEFORE_MIDNIGHT = new Date("2026-11-10T20:50:00Z");
const AFTER_MIDNIGHT = new Date("2026-11-10T21:05:00Z");

const run = (now: Date) => runtime.runPromise(writeTreasurySnapshots(now));

const company = async (inVault = 40n * USDC): Promise<TreasuryCompany> => {
  const created = await createTreasuryCompany(world, db);
  fundVault(world, created, inVault);
  return created;
};

interface Row {
  readonly day: string;
  readonly assets: string;
  readonly shares: string;
  readonly apy: number | null;
  readonly read_at: Date;
}

const rowsOf = async (paying: TreasuryCompany): Promise<Row[]> => {
  const { rows } = await owner.query<Row>(
    `SELECT snapshot_date::text AS day, assets_in_vault::text AS assets,
            shares_in_vault::text AS shares, user_apy AS apy, read_at
       FROM treasury_snapshots WHERE organization_id = $1 ORDER BY snapshot_date`,
    [paying.tenant.organizationId],
  );
  return rows;
};

describe("the treasury-snapshots job", () => {
  it("writes the position and rate for the Nairobi day, read at the time of the run", async () => {
    // #given
    const paying = await company(40n * USDC);

    // #when
    await run(BEFORE_MIDNIGHT);

    // #then
    expect(await rowsOf(paying)).toEqual([
      {
        day: "2026-11-10",
        assets: (40n * USDC).toString(),
        shares: (40n * USDC).toString(),
        apy: 519,
        read_at: BEFORE_MIDNIGHT,
      },
    ]);
  });

  it("writes it once, and a second run the same day asks Privy for nothing", async () => {
    // #given
    const paying = await company();
    await run(BEFORE_MIDNIGHT);
    const reads = privy.state.calls.vaultPosition;

    // #when a position that has since changed is run again, and again later that day
    fundVault(world, paying, 99n * USDC);
    await run(BEFORE_MIDNIGHT);
    await run(new Date("2026-11-10T20:59:00Z"));

    // #then the day's first reading stands, and nobody was asked again
    expect((await rowsOf(paying)).map((row) => [row.day, row.assets])).toEqual([
      ["2026-11-10", (40n * USDC).toString()],
    ]);
    expect(privy.state.calls.vaultPosition).toBe(reads);
  });

  it("writes the next day's row after midnight in Nairobi, and only then", async () => {
    // #given the day's row, written at 23:50
    const paying = await company();
    await run(BEFORE_MIDNIGHT);

    // #when it runs just before and just after 00:00 Nairobi time
    await run(new Date("2026-11-10T20:59:59Z"));
    const before = (await rowsOf(paying)).map((row) => row.day);
    fundVault(world, paying, 55n * USDC);
    await run(new Date("2026-11-10T21:00:00Z"));
    await run(AFTER_MIDNIGHT);

    // #then
    expect({
      before,
      after: (await rowsOf(paying)).map((row) => [row.day, row.assets]),
    }).toEqual({
      before: ["2026-11-10"],
      after: [
        ["2026-11-10", (40n * USDC).toString()],
        ["2026-11-11", (55n * USDC).toString()],
      ],
    });
    const second = (await rowsOf(paying))[1];
    expect(second?.read_at.getTime()).toBe(
      new Date("2026-11-10T21:00:00Z").getTime(),
    );
  });

  it("writes one row when two runs start at once", async () => {
    // #given
    const paying = await company();

    // #when
    await Promise.all([run(BEFORE_MIDNIGHT), run(BEFORE_MIDNIGHT)]);

    // #then
    expect(await rowsOf(paying)).toHaveLength(1);
  });

  it("skips a company that hasn't turned Treasury on", async () => {
    // #given
    const off = await createNearPayingCompany(world, db);
    const on = await company();

    // #when
    await run(BEFORE_MIDNIGHT);

    // #then
    const { rows } = await owner.query(
      "SELECT 1 FROM treasury_snapshots WHERE organization_id = $1",
      [off.company.organizationId],
    );
    expect({ off: rows.length, on: (await rowsOf(on)).length }).toEqual({
      off: 0,
      on: 1,
    });
  });

  it("leaves a company Privy can't read for the next run, and the others are written", async () => {
    // #given
    const first = await company();
    const second = await company();

    // #when one read fails
    privy.state.failNext("vaultPosition");
    const failed = await run(BEFORE_MIDNIGHT);
    const retried = await run(BEFORE_MIDNIGHT);

    // #then
    expect({
      failed: failed.failed,
      retried: [retried.failed, retried.written],
      rows: [(await rowsOf(first)).length, (await rowsOf(second)).length],
    }).toEqual({ failed: 1, retried: [0, 1], rows: [1, 1] });
  });

  it("saves no rate when the vault gives none", async () => {
    // #given
    const paying = await company();
    privy.state.setVaultApy(null);

    // #when
    await run(BEFORE_MIDNIGHT);

    // #then
    expect((await rowsOf(paying)).map((row) => row.apy)).toEqual([null]);
  });
});

describe("who can reach snapshots", () => {
  it("shows a company only its own, and nobody can change one", async () => {
    // #given two companies with a snapshot each
    const mine = await company();
    const other = await company();
    await run(BEFORE_MIDNIGHT);

    // #when
    const seen = await runInScope(
      db,
      { organizationId: mine.tenant.organizationId, role: "accountant" },
      (tx) => tx.select().from(treasurySnapshots),
    );
    const update = runInScope(
      db,
      { organizationId: mine.tenant.organizationId },
      (tx) => tx.update(treasurySnapshots).set({ userApy: 1 }),
    );

    // #then
    expect(seen.map((row) => row.organizationId)).toEqual([
      mine.tenant.organizationId,
    ]);
    expect(seen.map((row) => row.organizationId)).not.toContain(
      other.tenant.organizationId,
    );
    await expect(update).rejects.toThrow();
  });
});
