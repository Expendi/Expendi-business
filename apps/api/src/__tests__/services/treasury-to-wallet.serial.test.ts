import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import {
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { creditSettledQuotes } from "../../services/intents/quote-credit.js";
import { advanceTreasuryReturnQuote } from "../../services/intents/treasury-return.js";
import { advanceTreasuryMoves } from "../../services/treasury/advance.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import {
  settleOpenQuotes,
  switchBalanceHome,
} from "../helpers/confidential-delivery.js";
import {
  createFundedCompany,
  readQuote,
  saveQuote,
  saveTreasuryMove,
} from "../helpers/money-in.js";
import { makeNearPayoutWorld, updateQuote } from "../helpers/near-payouts.js";
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

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
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

const creditAll = () => runtime.runPromise(creditSettledQuotes());

/**
 * A company whose USDC is kept in a confidential account: its return parts
 * are delivered into the account, which no chain shows, and credited when
 * 1Click reports them.
 */
const confidentialCompany = async () => {
  const created = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
    balanceHome: "confidential_account",
  });
  fundVault(world, created, 60n * USDC);
  oneClick.state.fundConfidential(created.accountId, 100n * USDC);
  return created;
};

const deliveredIntoAccount = new Set<string>();

/**
 * What 1Click does for each return part the Treasury wallet has sent to a
 * confidential account: the wallet's USDC falls, 1Click reports `SUCCESS`
 * with `shortBy` less than the quote promised, and the account's balance
 * rises by what it delivered. No transfer exists on any chain.
 */
async function deliverIntoAccount(
  paying: TreasuryCompany,
  shortBy = 0n,
): Promise<void> {
  for (const quote of await returnQuotes(db, paying)) {
    if (
      quote.recipientType !== "CONFIDENTIAL_INTENTS" ||
      quote.status !== "depositing" ||
      quote.depositTxHash === null ||
      deliveredIntoAccount.has(quote.id)
    ) {
      continue;
    }
    deliveredIntoAccount.add(quote.id);
    setBaseBalance(
      world,
      paying.treasuryAddress,
      treasuryWalletUsdc(paying) - quote.amountIn,
    );
    const delivery = quote.amountOut - shortBy;
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: delivery,
    });
    oneClick.state.fundConfidential(paying.accountId, delivery);
  }
}

const moveRows = async (paying: TreasuryCompany) =>
  (await readLedger(db, paying)).filter((row) => row.type === "from_treasury");

describe("a move to the wallet, into a confidential account", () => {
  it("delivers into the account, is credited when 1Click reports it, and only then completes", async () => {
    // #given a 20 USDC move of a company that keeps its USDC in a confidential account
    const paying = await confidentialCompany();
    const move = await startMoveToWallet(world, paying, 20n * USDC);

    // #when the job withdraws and sends the part
    await job();
    const [part] = await returnQuotes(db, paying);
    if (!part) throw new Error("no return quote");
    const request = oneClick.state.quoteRequests.at(-1);

    // #then the quote delivers into the account, with the company's session
    expect({
      recipientType: part.recipientType,
      requested: request?.recipientType,
      status: part.status,
    }).toEqual({
      recipientType: "CONFIDENTIAL_INTENTS",
      requested: "CONFIDENTIAL_INTENTS",
      status: "depositing",
    });

    // #when 1Click reports it delivered, one base unit short of the quote
    await deliverIntoAccount(paying, 1n);
    await job();
    const beforeCredit = {
      move: (await readMove(db, paying, move.id)).status,
      credits: (await moveRows(paying)).length,
    };

    // #then nothing is credited and the move waits
    expect(beforeCredit).toEqual({ move: "open", credits: 0 });

    // #when the credit job runs, twice, and the watcher runs
    const first = await creditAll();
    const second = await creditAll();
    const watched = await watch();
    await job();

    // #then the delivery is credited once, for what 1Click reported, with no chain transaction, and the move completed
    const rows = await readLedger(db, paying);
    const stored = await runInScope(
      db,
      { organizationId: paying.tenant.organizationId },
      (tx) =>
        tx
          .select({
            txHash: walletTransactions.txHash,
            chain: walletTransactions.chain,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.type, "from_treasury")),
    );
    const ended = await readMove(db, paying, move.id);
    expect({
      credited: [first.credited, second.credited, watched.credited],
      rows: rows
        .filter((row) => row.type === "from_treasury")
        .map((row) => [row.usdcAmount, row.treasuryMoveId, row.intentQuoteId]),
      stored,
      status: ended.status,
      moved: ended.movedUsdc,
    }).toEqual({
      credited: [1, 0, 0],
      rows: [[part.amountOut - 1n, move.id, part.id]],
      stored: [{ txHash: null, chain: "near" }],
      status: "completed",
      moved: part.amountOut - 1n,
    });
    expect(await ledgerBalance(db, paying.company)).toBe(
      oneClick.state.confidentialBalances.get(paying.accountId),
    );
  });

  it("credits each part of a move once, and the deposit watcher credits none of them", async () => {
    // #given a 50 USDC move in two parts
    const paying = await confidentialCompany();
    const move = await startMoveToWallet(world, paying, 50n * USDC);

    // #when the job, 1Click, the credit job and the watcher take turns
    let watcherCredits = 0;
    for (let round = 0; round < 40; round += 1) {
      await job();
      await deliverIntoAccount(paying);
      await job();
      await creditAll();
      watcherCredits += (await watch()).credited;
      if ((await readMove(db, paying, move.id)).status !== "open") break;
    }

    // #then both parts were credited once, by the credit job
    const quotes = await returnQuotes(db, paying);
    const ended = await readMove(db, paying, move.id);
    expect({
      status: ended.status,
      credits: (await moveRows(paying))
        .map((row) => [row.usdcAmount, row.intentQuoteId])
        .sort(),
      watcherCredits,
    }).toEqual({
      status: "completed",
      credits: quotes.map((quote) => [quote.amountOut, quote.id]).sort(),
      watcherCredits: 0,
    });
    expect(quotes).toHaveLength(2);
    expect(await ledgerBalance(db, paying.company)).toBe(
      oneClick.state.confidentialBalances.get(paying.accountId),
    );
  });

  it("goes to review when the delivery isn't credited within 30 minutes", async () => {
    // #given a part reported delivered whose credit never comes
    const paying = await confidentialCompany();
    const move = await startMoveToWallet(world, paying, 20n * USDC);
    await job();
    await deliverIntoAccount(paying);
    await job();
    const [part] = await returnQuotes(db, paying);
    if (!part) throw new Error("no return quote");

    // #when it has waited an hour
    await updateQuote(db, paying.company, part.id, {
      settledAt: new Date(Date.now() - 60 * 60_000),
    });
    await job();

    // #then the move is in review and the ledger still has no credit
    expect({
      move: (await readMove(db, paying, move.id)).status,
      credits: (await moveRows(paying)).length,
    }).toEqual({ move: "needs_review", credits: 0 });
    await creditAll();
  });
});

describe("a move to the wallet opened before a company's balance moved", () => {
  it("credits each part by where its own quote delivered, whichever way the company is set now", async () => {
    // #given a company paying from its wallet whose first part is sent
    const paying = await company();
    const move = await startMoveToWallet(world, paying, 50n * USDC);
    await job();
    const [first] = await returnQuotes(db, paying);
    expect(first?.recipientType).toBe("DESTINATION_CHAIN");

    // #when the company is switched to a confidential account and the move runs on
    await switchBalanceHome(
      db,
      {
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      },
      "confidential_account",
    );
    oneClick.state.fundConfidential(paying.accountId, 50n * USDC);
    for (let round = 0; round < 40; round += 1) {
      await job();
      await deliverOnNear(paying);
      await deliverIntoAccount(paying);
      await job();
      await watch();
      await creditAll();
      if ((await readMove(db, paying, move.id)).status !== "open") break;
    }

    // #then the first part was credited by the watcher from its transfer, the second by 1Click's report, once each
    const quotes = await returnQuotes(db, paying);
    const credits = await readLedger(db, paying);
    const stored = await runInScope(
      db,
      { organizationId: paying.tenant.organizationId },
      (tx) =>
        tx
          .select({
            quoteId: walletTransactions.intentQuoteId,
            txHash: walletTransactions.txHash,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.type, "from_treasury")),
    );
    expect({
      recipients: quotes.map((quote) => quote.recipientType),
      credited: quotes.map(
        (quote) =>
          credits.filter(
            (row) =>
              row.type === "from_treasury" && row.intentQuoteId === quote.id,
          ).length,
      ),
      onChain: quotes.map(
        (quote) =>
          stored.find((row) => row.quoteId === quote.id)?.txHash !== null,
      ),
      status: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      recipients: ["DESTINATION_CHAIN", "CONFIDENTIAL_INTENTS"],
      credited: [1, 1],
      onChain: [true, false],
      status: "completed",
    });
  });

  it("credits a part delivered into the account when the company has since been switched back", async () => {
    // #given a part sent for delivery into the account
    const paying = await confidentialCompany();
    const move = await startMoveToWallet(world, paying, 20n * USDC);
    await job();

    // #when the company is switched back and 1Click reports the part delivered
    await switchBalanceHome(
      db,
      {
        company: paying.company,
        walletId: paying.wallet.id,
        accountId: paying.accountId,
        transitAddress: paying.transitAddress,
      },
      "company_wallet",
    );
    await deliverIntoAccount(paying);
    await job();
    const credit = await creditAll();
    await job();

    // #then it was credited by the credit job and the move completed
    expect({
      credited: credit.credited,
      credits: (await moveRows(paying)).length,
      status: (await readMove(db, paying, move.id)).status,
    }).toEqual({ credited: 1, credits: 1, status: "completed" });
  });
});

describe("a move to the wallet from a company wallet", () => {
  it("asks 1Click for a delivery to the company wallet, with no session and no confidential side", async () => {
    // #given a company paying from its wallet
    const paying = await company();
    const requestsBefore = oneClick.state.quoteRequests.length;
    const callsBefore = oneClick.state.calls.length;
    const move = await startMoveToWallet(world, paying, 20n * USDC);

    // #when its move runs to the end
    for (let round = 0; round < 40; round += 1) {
      await job();
      await deliverOnNear(paying);
      await job();
      await watch();
      if ((await readMove(db, paying, move.id)).status !== "open") break;
    }

    // #then
    const requests = oneClick.state.quoteRequests.slice(requestsBefore);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).not.toHaveProperty("recipientType");
      expect(request).not.toHaveProperty("depositType");
      expect(request).not.toHaveProperty("refundType");
    }
    expect(
      oneClick.state.calls
        .slice(callsBefore)
        .every((call) => call.session === undefined),
    ).toBe(true);
    const [part] = await returnQuotes(db, paying);
    expect({
      recipientType: part?.recipientType,
      status: (await readMove(db, paying, move.id)).status,
      credited: (await moveRows(paying)).length,
    }).toEqual({
      recipientType: "DESTINATION_CHAIN",
      status: "completed",
      credited: 1,
    });
  });
});

describe("a part to be delivered into a confidential account, without the company's session", () => {
  it("is not started, so no USDC leaves the Treasury wallet", async () => {
    // #given a part whose company can't sign in: its Privy wallet is unknown to Privy
    const funded = await createFundedCompany(db);
    const treasuryAddress = `0x${"ab".repeat(20)}`;
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(wallets)
          .set({
            treasuryAddress,
            treasuryPrivyWalletId: "treasury-wallet-unknown",
            treasuryPrivyPolicyId: "treasury-policy-unknown",
            treasuryTurnedOnAt: new Date(),
            balanceHome: "confidential_account",
          })
          .where(eq(wallets.id, funded.walletId)),
    );
    world.setBaseUsdc(treasuryAddress, 50n * USDC);
    const move = await saveTreasuryMove(db, funded, { direction: "to_wallet" });
    const part = await saveQuote(runtime, db, funded, "from_treasury", {
      confidential: true,
      amount: 20n * USDC,
      row: { treasuryMoveId: move.id, refundTo: treasuryAddress },
    });
    const sendsBefore = privy.state.sends.length;

    // #when the part is advanced
    await runtime.runPromise(
      advanceTreasuryReturnQuote({
        id: part.id,
        organizationId: funded.company.organizationId,
      }),
    );

    // #then it is still quoted and nothing was sent
    const after = await readQuote(db, funded, part.id);
    expect({
      status: after.status,
      started: after.depositStartedAt,
      sends: privy.state.sends.length - sendsBefore,
    }).toEqual({ status: "quoted", started: null, sends: 0 });
    await settleOpenQuotes(db, funded);
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(treasuryMoves)
          .set({ status: "failed", settledAt: new Date() })
          .where(eq(treasuryMoves.id, move.id)),
    );
  });
});
