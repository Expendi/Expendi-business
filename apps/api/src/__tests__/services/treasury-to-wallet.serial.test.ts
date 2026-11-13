import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { advanceTreasuryMoves } from "../../services/treasury/advance.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import {
  ftTransferLog,
  nearOutcome,
  randomNearAccount,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { ledgerBalance } from "../helpers/payouts.js";
import {
  createTreasuryCompany,
  fundVault,
  readLedger,
  readMove,
  returnQuotes,
  setBaseBalance,
  startMoveToWallet,
  treasuryWalletUsdc,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * The job and the deposit watcher look across every company, so they run
 * here, one file at a time, where no other file's moves are in the database.
 */

const world = makeNearPayoutWorld({ PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, near, oneClick, privy, fastNear } = world;
let db: Database;
let owner: pg.Pool;
let delivered: Set<string>;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await owner.query(
    "UPDATE ops_alerts SET resolved_at = now() WHERE kind = 'deposits_held' AND resolved_at IS NULL",
  );
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  delivered = new Set();
  privy.state.resetEarn();
});

const job = () =>
  runtime.runPromise(advanceTreasuryMoves(500, { retryDelayMs: 0 }));
const watch = () => runtime.runPromise(watchNearDeposits());

const company = async (perTransactionMaxUsdc = 30n * USDC) => {
  const created = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc,
  });
  fundVault(world, created, 60n * USDC);
  return created;
};

/**
 * What 1Click does for each return part the Treasury wallet has sent: the
 * wallet's USDC falls, and the company wallet receives the delivery from
 * NEAR Intents in a transaction 1Click lists, which the indexer finds.
 */
async function deliverOnNear(paying: TreasuryCompany): Promise<void> {
  for (const quote of await returnQuotes(db, paying)) {
    if (
      quote.status !== "depositing" ||
      quote.depositTxHash === null ||
      delivered.has(quote.id)
    ) {
      continue;
    }
    delivered.add(quote.id);
    setBaseBalance(
      world,
      paying.treasuryAddress,
      treasuryWalletUsdc(paying) - quote.amountIn,
    );
    const delivery = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: NEAR_INTENTS_ACCOUNT_ID,
                to: paying.accountId,
                amount: quote.amountOut,
              },
            ]),
          ],
        },
      ],
      { signerId: NEAR_INTENTS_ACCOUNT_ID },
    );
    near.state.outcomes.set(delivery.txHash, delivery);
    near.state.fundWithUsdc(paying.accountId, quote.amountOut);
    fastNear.state.index(paying.accountId, delivery);
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
      destinationChainTxHashes: [delivery.txHash],
    });
  }
}

describe("a move to the wallet, with the job and the deposit watcher", () => {
  it("is credited once per part, linked to its quote, by the watcher, and only then completes", async () => {
    // #given a 50 USDC move in two parts, and a stranger's transfer to the company wallet
    const paying = await company();
    const move = await startMoveToWallet(world, paying, 50n * USDC);
    const stranger = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: randomNearAccount(),
                to: paying.accountId,
                amount: 3n * USDC,
              },
            ]),
          ],
        },
      ],
      { signerId: randomNearAccount() },
    );
    near.state.outcomes.set(stranger.txHash, stranger);
    near.state.fundWithUsdc(paying.accountId, 3n * USDC);
    fastNear.state.index(paying.accountId, stranger);

    // #when the job, 1Click and the watcher take turns until the move ends,
    // and the watcher is run twice at every turn
    let credits = 0;
    for (let round = 0; round < 40; round += 1) {
      await job();
      await deliverOnNear(paying);
      await job();
      credits += (await watch()).credited;
      await watch();
      if ((await readMove(db, paying, move.id)).status !== "open") break;
    }

    // #then both parts were credited once as from_treasury, linked to their
    // quotes, the stranger's transfer as a plain deposit, and the ledger
    // equals the chain
    const quotes = await returnQuotes(db, paying);
    const ended = await readMove(db, paying, move.id);
    const rows = await readLedger(db, paying);
    expect({
      status: ended.status,
      quotes: quotes.length,
      fromTreasury: rows
        .filter((row) => row.type === "from_treasury")
        .map((row) => [row.usdcAmount, row.treasuryMoveId, row.intentQuoteId])
        .sort(),
      deposits: rows
        .filter((row) => row.type === "deposit")
        .map((row) => row.usdcAmount)
        .sort(),
      moved: ended.movedUsdc,
      cost: ended.costUsdc,
      credits,
      withdrawals: privy.state.earnCalls.filter((c) => c.kind === "withdraw")
        .length,
    }).toEqual({
      status: "completed",
      quotes: 2,
      fromTreasury: quotes
        .map((quote) => [quote.amountOut, move.id, quote.id])
        .sort(),
      deposits: [100n * USDC, 3n * USDC].sort(),
      moved: quotes.reduce((sum, quote) => sum + quote.amountOut, 0n),
      cost:
        50n * USDC - quotes.reduce((sum, quote) => sum + quote.amountOut, 0n),
      credits: 3,
      withdrawals: 1,
    });
    expect(await ledgerBalance(db, paying.company)).toBe(
      near.state.usdcBalanceOf(paying.accountId),
    );
    expect(treasuryWalletUsdc(paying)).toBe(0n);
  });

  it("moves every company's open move, each within its own cap, and leaves finished moves alone", async () => {
    // #given two companies with open moves to the wallet
    const small = await company(100n * USDC);
    const large = await company(30n * USDC);
    const smallMove = await startMoveToWallet(world, small, 20n * USDC);
    const largeMove = await startMoveToWallet(world, large, 50n * USDC);

    // #when the job runs, with 1Click and the watcher in between
    let ran = 0;
    for (let round = 0; round < 60; round += 1) {
      await deliverOnNear(small);
      await deliverOnNear(large);
      const summary = await job();
      ran += summary.moves;
      await watch();
      if (summary.moves === 0) break;
    }

    // #then both completed and a run with nothing open finds nothing
    expect({
      small: (await readMove(db, small, smallMove.id)).status,
      large: (await readMove(db, large, largeMove.id)).status,
      smallParts: (await returnQuotes(db, small)).length,
      largeParts: (await returnQuotes(db, large)).length,
      idle: await job(),
      busy: ran > 0,
    }).toEqual({
      small: "completed",
      large: "completed",
      smallParts: 1,
      largeParts: 2,
      idle: { moves: 0, errors: 0 },
      busy: true,
    });
    for (const paying of [small, large]) {
      expect(await ledgerBalance(db, paying.company)).toBe(
        near.state.usdcBalanceOf(paying.accountId),
      );
    }
  });
});
