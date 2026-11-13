import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { treasuryMoves, treasurySnapshots } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { kesCentsFor } from "../../services/paycrest/amounts.js";
import { advanceTreasuryMove } from "../../services/treasury/advance.js";
import { getTreasuryStatus } from "../../services/treasury/figures.js";
import { listTreasuryMoves } from "../../services/treasury/moves.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import {
  createTreasuryCompany,
  deliverSentParts,
  fundVault,
  readActions,
  runMoveToEnd,
  startMove,
  startMoveToWallet,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy } = world;
let db: Database;
let company: TreasuryCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  privy.state.reset();
  privy.state.setVaultApy(519);
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 100n * USDC,
  });
});

const status = (tenant: Tenant = company.tenant) =>
  runtime.runPromise(getTreasuryStatus(tenant));

type On = Extract<Awaited<ReturnType<typeof status>>, { status: "on" }>;

const statusOn = async (tenant?: Tenant): Promise<On> => {
  const result = await status(tenant);
  if (result.status !== "on") throw new Error(`Treasury is ${result.status}`);
  return result;
};

/** What the vault took for the company so far, from its recorded deposits. */
const deposited = async () =>
  (await readActions(db, company))
    .filter(
      (action) => action.kind === "deposit" && action.status === "succeeded",
    )
    .reduce((sum, action) => sum + action.rawAmount, 0n);

/** A move to Treasury that has run to the end, leaving what the vault took. */
async function moveIn(amount: bigint): Promise<bigint> {
  const before = await deposited();
  const move = await startMove(world, company, amount);
  const done = await runMoveToEnd(world, db, company, move.id);
  expect(done.status).toBe("completed");
  return (await deposited()) - before;
}

const saveSnapshot = (values: {
  readonly assetsInVault: bigint;
  readonly userApy: number | null;
  readonly readAt: Date;
}) =>
  runInScope(db, { organizationId: company.tenant.organizationId }, (tx) =>
    tx.insert(treasurySnapshots).values({
      organizationId: company.tenant.organizationId,
      snapshotDate: "2026-11-12",
      sharesInVault: values.assetsInVault,
      ...values,
    }),
  );

describe("the Treasury account's figures", () => {
  it("shows what Treasury is worth, its rate and the KES equivalent, with no yield before any is earned", async () => {
    // #given 40 USDC moved in
    const took = await moveIn(40n * USDC);

    // #when
    const figures = await statusOn();

    // #then the value is Privy's, and nothing was earned
    expect({
      value: figures.valueUsdc,
      yield: figures.yieldUsdc,
      rateBps: figures.rateBps,
      kes: figures.kesEquivalent,
      openMove: figures.openMove,
      saved: figures.saved,
      address: figures.address,
      readJustNow: Date.now() - Date.parse(figures.asOf ?? "") < 10_000,
    }).toEqual({
      value: took.toString(),
      yield: "0",
      rateBps: 519,
      kes: {
        kesCents: kesCentsFor(took, "128.68").toString(),
        rate: "128.68",
      },
      openMove: null,
      saved: false,
      address: company.treasuryAddress,
      readJustNow: true,
    });
  });

  it("counts yield as value less what was moved in, and what was moved out comes back", async () => {
    // #given 40 USDC in, then 1.5 USDC earned
    const took = await moveIn(40n * USDC);
    privy.state.setVaultAssets(
      company.treasuryPrivyWalletId,
      took + 1_500_000n,
    );
    const earned = await statusOn();

    // #when 10 USDC is moved out
    const out = await startMoveToWallet(world, company, 10n * USDC);
    const done = await runMoveToEnd(world, db, company, out.id);
    const after = await statusOn();

    // #then what left the vault is added back, so the yield is unchanged
    expect({
      earned: earned.yieldUsdc,
      moveStatus: done.status,
      value: after.valueUsdc,
      yield: after.yieldUsdc,
    }).toEqual({
      earned: "1500000",
      moveStatus: "completed",
      value: (took + 1_500_000n - 10n * USDC).toString(),
      yield: "1500000",
    });
  });

  it("adds back what a partly filled withdrawal delivered, not what was asked", async () => {
    // #given 40 USDC in, and a vault that gives back 6 of the 10 asked for
    const took = await moveIn(40n * USDC);
    privy.state.nextWithdrawalFills(6n * USDC);

    // #when
    const out = await startMoveToWallet(world, company, 10n * USDC);
    await runMoveToEnd(world, db, company, out.id);
    const figures = await statusOn();

    // #then 34 USDC is left of 40, and no yield is made up
    expect({ value: figures.valueUsdc, yield: figures.yieldUsdc }).toEqual({
      value: (took - 6n * USDC).toString(),
      yield: "0",
    });
  });

  it("shows the open move: its direction, amount and a plain status", async () => {
    // #given a move to Treasury that has only been started
    const move = await startMove(world, company, 20n * USDC);

    // #when
    const figures = await statusOn();

    // #then
    expect(figures.openMove).toEqual({
      id: move.id,
      direction: "to_treasury",
      amountUsdc: (20n * USDC).toString(),
      isAll: false,
      status: "open",
      statusText: "On its way to Treasury",
      startedAt: move.createdAt.toISOString(),
      progress: {
        steps: [
          { key: "leaving_wallet", state: "current", at: null },
          { key: "on_its_way", state: "waiting", at: null },
          { key: "arriving", state: "waiting", at: null },
          { key: "in_treasury", state: "waiting", at: null },
        ],
      },
    });
  });

  it("says a move to the wallet is on its way, and a move under review is being checked", async () => {
    // #given 30 USDC in the vault and a move of all of it
    fundVault(world, company, 30n * USDC);
    const move = await startMoveToWallet(world, company, "all");
    const open = await statusOn();

    // #when a person has to look at it
    await runInScope(
      db,
      { organizationId: company.tenant.organizationId },
      (tx) =>
        tx
          .update(treasuryMoves)
          .set({ status: "needs_review" })
          .where(eq(treasuryMoves.id, move.id)),
    );
    const review = await statusOn();

    // #then
    expect({
      open: [open.openMove?.statusText, open.openMove?.isAll],
      review: [review.openMove?.status, review.openMove?.statusText],
    }).toEqual({
      open: ["On its way to your wallet", true],
      review: ["needs_review", "Being checked by Expendi"],
    });
  });

  it("holds the yield back while a Privy call is in flight, so a deposit the records lack isn't shown as earnings", async () => {
    // #given a deposit Privy hasn't settled
    privy.state.nextEarnCalls("pending");
    const move = await startMove(world, company, 20n * USDC);
    const delivered = new Set<string>();
    const ref = {
      organizationId: company.tenant.organizationId,
      moveId: move.id,
    };
    for (let round = 0; round < 40; round += 1) {
      await deliverSentParts(world, db, company, delivered);
      await runtime.runPromise(advanceTreasuryMove(ref, { retryDelayMs: 0 }));
      const [action] = await readActions(db, company);
      if (action?.status === "pending") break;
    }

    // #when the vault already shows the USDC
    privy.state.setVaultAssets(company.treasuryPrivyWalletId, 19n * USDC);
    const figures = await statusOn();

    // #then
    expect({ value: figures.valueUsdc, yield: figures.yieldUsdc }).toEqual({
      value: (19n * USDC).toString(),
      yield: null,
    });
  });

  it("shows an accountant the same figures", async () => {
    // #given
    const took = await moveIn(40n * USDC);

    // #when
    const figures = await statusOn({ ...company.tenant, role: "accountant" });

    // #then
    expect(figures.valueUsdc).toBe(took.toString());
  });
});

describe("when Privy can't be reached", () => {
  it("answers with the last snapshot's value and rate and when they were read", async () => {
    // #given a snapshot, and then a Privy that fails
    const took = await moveIn(40n * USDC);
    const readAt = new Date("2026-11-12T06:00:00Z");
    await saveSnapshot({ assetsInVault: took, userApy: 480, readAt });
    privy.state.failNext("vaultPosition");
    privy.state.failNext("vaultDetails");

    // #when
    const figures = await statusOn();

    // #then
    expect({
      value: figures.valueUsdc,
      rateBps: figures.rateBps,
      asOf: figures.asOf,
      saved: figures.saved,
      kes: figures.kesEquivalent?.kesCents,
    }).toEqual({
      value: took.toString(),
      rateBps: 480,
      asOf: readAt.toISOString(),
      saved: true,
      kes: kesCentsFor(took, "128.68").toString(),
    });
  });

  it("works yield out as of the snapshot, so a move made since doesn't skew it", async () => {
    // #given a snapshot of 40 USDC in, and 10 more moved in after it was read
    const first = await moveIn(40n * USDC);
    await saveSnapshot({
      assetsInVault: first,
      userApy: 519,
      readAt: new Date(),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await moveIn(10n * USDC);
    privy.state.failNext("vaultPosition");

    // #when
    const figures = await statusOn();

    // #then the later deposit isn't counted against the older value
    expect({ value: figures.valueUsdc, yield: figures.yieldUsdc }).toEqual({
      value: first.toString(),
      yield: "0",
    });
  });

  it("keeps the live value when only the rate can't be read, and falls back to the snapshot's rate", async () => {
    // #given
    const took = await moveIn(40n * USDC);
    await saveSnapshot({
      assetsInVault: 1n,
      userApy: 480,
      readAt: new Date("2026-11-12T06:00:00Z"),
    });
    privy.state.failNext("vaultDetails");

    // #when
    const figures = await statusOn();

    // #then
    expect({
      value: figures.valueUsdc,
      rateBps: figures.rateBps,
      saved: figures.saved,
    }).toEqual({ value: took.toString(), rateBps: 480, saved: false });
  });

  it("still answers, with nothing to show, when nothing was ever saved", async () => {
    // #given
    privy.state.failNext("vaultPosition");
    privy.state.failNext("vaultDetails");

    // #when
    const figures = await statusOn();

    // #then
    expect({
      value: figures.valueUsdc,
      yield: figures.yieldUsdc,
      rateBps: figures.rateBps,
      kes: figures.kesEquivalent,
      asOf: figures.asOf,
      saved: figures.saved,
      address: figures.address,
    }).toEqual({
      value: null,
      yield: null,
      rateBps: null,
      kes: null,
      asOf: null,
      saved: true,
      address: company.treasuryAddress,
    });
  });
});

describe("the move list", () => {
  it("shows whether a move was for all, and what a withdrawal delivered", async () => {
    // #given 30 USDC in the vault, a partial fill of 20 for a move of "all"
    fundVault(world, company, 30n * USDC);
    privy.state.nextWithdrawalFills(20n * USDC);
    const move = await startMoveToWallet(world, company, "all");
    await runMoveToEnd(world, db, company, move.id);

    // #when
    const { moves } = await runtime.runPromise(
      listTreasuryMoves(company.tenant),
    );

    // #then
    expect(
      moves.map((row) => [
        row.direction,
        row.isAll,
        row.requestedUsdc,
        row.deliveredUsdc,
        row.status,
      ]),
    ).toEqual([
      [
        "to_wallet",
        true,
        (30n * USDC).toString(),
        (20n * USDC).toString(),
        "completed",
      ],
    ]);
  });

  it("shows no delivery for a move to Treasury, or one whose withdrawal hasn't run", async () => {
    // #given one of each
    await moveIn(20n * USDC);
    await runMoveToEnd(
      world,
      db,
      company,
      (await startMoveToWallet(world, company, 10n * USDC)).id,
    );

    // #when
    const { moves } = await runtime.runPromise(
      listTreasuryMoves(company.tenant),
    );

    // #then newest first: the withdrawal delivered 10, the deposit shows none
    expect(
      moves.map((row) => [row.direction, row.isAll, row.deliveredUsdc]),
    ).toEqual([
      ["to_wallet", false, (10n * USDC).toString()],
      ["to_treasury", false, null],
    ]);
  });
});
