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
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { ledgerBalance } from "../helpers/payouts.js";
import {
  createTreasuryCompany,
  deliverSentParts,
  readLedger,
  readMove,
  startMove,
  treasuryQuotes,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";

/**
 * The job and the deposit watcher look across every company, so they run
 * here, one file at a time, where no other file's moves are in the database.
 */

const world = makeNearPayoutWorld({ PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, near, oneClick, privy, fastNear } = world;
let db: Database;
let delivered: Set<string>;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(() => {
  delivered = new Set();
  privy.state.resetEarn();
});

const job = () =>
  runtime.runPromise(advanceTreasuryMoves(500, { retryDelayMs: 0 }));
const watch = () => runtime.runPromise(watchNearDeposits());

const company = (perTransactionMaxUsdc = 30n * USDC) =>
  createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc,
  });

describe("the treasury-moves job", () => {
  it("moves every company's open move, each within its own cap, and leaves finished moves alone", async () => {
    // #given two companies with open moves of different sizes
    const small = await company(100n * USDC);
    const large = await company(30n * USDC);
    const smallMove = await startMove(world, small, 20n * USDC);
    const largeMove = await startMove(world, large, 50n * USDC);

    // #when the job runs, 1Click delivering in between, until both are done
    let ran = 0;
    for (let round = 0; round < 40; round += 1) {
      await deliverSentParts(world, db, small, delivered);
      await deliverSentParts(world, db, large, delivered);
      const summary = await job();
      ran += summary.moves;
      if (summary.moves === 0) break;
    }

    // #then both completed, and a run with nothing open finds nothing
    expect({
      small: (await readMove(db, small, smallMove.id)).status,
      large: (await readMove(db, large, largeMove.id)).status,
      largeParts: (await treasuryQuotes(db, large)).length,
      sends: privy.state.earnCalls.length,
      idle: await job(),
      busy: ran > 0,
    }).toEqual({
      small: "completed",
      large: "completed",
      largeParts: 2,
      sends: 3,
      idle: { moves: 0, errors: 0 },
      busy: true,
    });
    expect(await ledgerBalance(db, small.company)).toBe(
      near.state.usdcBalanceOf(small.accountId),
    );
    expect(await ledgerBalance(db, large.company)).toBe(
      near.state.usdcBalanceOf(large.accountId),
    );
  });
});

describe("a part 1Click refunds", () => {
  it("is credited back by the deposit watcher as from_treasury, and only then does the move end returned", async () => {
    // #given a sent part
    const paying: TreasuryCompany = await company();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    const [quote] = await treasuryQuotes(db, paying);
    if (!quote) throw new Error("no quote");
    expect(quote.status).toBe("depositing");

    // #when 1Click refunds it to the company wallet, in a transfer it lists
    const refund = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: NEAR_INTENTS_ACCOUNT_ID,
                to: paying.accountId,
                amount: quote.amountIn,
              },
            ]),
          ],
        },
      ],
      { signerId: NEAR_INTENTS_ACCOUNT_ID },
    );
    near.state.outcomes.set(refund.txHash, refund);
    near.state.fundWithUsdc(paying.accountId, quote.amountIn);
    fastNear.state.index(paying.accountId, refund);
    oneClick.state.setStatus(quote.depositAddress, {
      status: "REFUNDED",
      refundedAmount: quote.amountIn,
      refundReason: "deadline",
      nearTxHashes: [refund.txHash],
    });

    // #when the watcher runs before the job has settled the quote
    const early = await watch();
    const ledgerEarly = await readLedger(db, paying);

    // #then it holds the refund: nothing is credited yet
    expect({
      credited: early.credited,
      held: early.held,
      rows: ledgerEarly.map((row) => row.type),
    }).toEqual({
      credited: 0,
      held: 1,
      rows: ["deposit", "to_treasury"],
    });

    // #when the job settles the quote, then the watcher runs, then the job again
    const settled = await job();
    const quoteAfter = (await treasuryQuotes(db, paying))[0];
    const stillOpen = (await readMove(db, paying, move.id)).status;
    const credited = await watch();
    const returned = await job();
    const ended = await readMove(db, paying, move.id);

    // #then the quote was refunded, the move waited for the credit, the
    // credit is one from_treasury row for the move, and the move is returned
    expect({
      settled: settled.errors,
      quote: quoteAfter?.status,
      beforeCredit: stillOpen,
      credited: credited.credited,
      returnedRun: returned.errors,
      status: ended.status,
      moved: ended.movedUsdc,
      cost: ended.costUsdc,
      rows: (await readLedger(db, paying)).map((row) => [
        row.type,
        row.usdcAmount,
        row.treasuryMoveId,
      ]),
      ledger: await ledgerBalance(db, paying.company),
      chain: near.state.usdcBalanceOf(paying.accountId),
    }).toEqual({
      settled: 0,
      quote: "refunded",
      beforeCredit: "open",
      credited: 1,
      returnedRun: 0,
      status: "returned",
      moved: 0n,
      cost: 0n,
      rows: [
        ["deposit", 100n * USDC, null],
        ["to_treasury", -20n * USDC, move.id],
        ["from_treasury", 20n * USDC, move.id],
      ],
      ledger: 100n * USDC,
      chain: 100n * USDC,
    });
  });
});
