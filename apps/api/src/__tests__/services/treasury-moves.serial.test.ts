import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { advanceTreasuryMoves } from "../../services/treasury/advance.js";
import { availableUsdc } from "../../services/wallet/ledger.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import { switchBalanceHome } from "../helpers/confidential-delivery.js";
import { makeNearPayoutWorld, updateQuote } from "../helpers/near-payouts.js";
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
  setBaseBalance,
  startMove,
  treasuryQuotes,
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
  await Promise.all([runtime.dispose(), owner.end()]);
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

/**
 * A company whose USDC is kept in a confidential account: its parts are paid
 * by a signed message and debited when 1Click reports them, never when the
 * message is accepted.
 */
const confidentialCompany = async (perTransactionMaxUsdc = 30n * USDC) => {
  const created = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc,
    balanceHome: "confidential_account",
  });
  oneClick.state.fundConfidential(created.accountId, 100n * USDC);
  return created;
};

const available = (paying: TreasuryCompany) =>
  runtime.runPromise(
    withScope({ organizationId: paying.tenant.organizationId }, (tx) =>
      availableUsdc(tx, paying.wallet.id),
    ),
  );

const quoteOf = async (paying: TreasuryCompany, index = 0) => {
  const quote = (await treasuryQuotes(db, paying))[index];
  if (!quote) throw new Error("no quote");
  return quote;
};

const isAccepted = (quote: IntentQuote) =>
  quote.status === "depositing" && quote.intentHash !== null;

/**
 * What 1Click does for each part that has been paid: the Treasury wallet
 * receives it and 1Click reports `SUCCESS`, or refunds it, once per quote.
 * Parts paid by a transfer on chain are delivered by the shared helper.
 */
async function settleParts(
  paying: TreasuryCompany,
  outcome: "deliver" | "refund" | "partial_refund" = "deliver",
): Promise<void> {
  for (const quote of await treasuryQuotes(db, paying)) {
    if (!isAccepted(quote) || delivered.has(quote.id)) continue;
    delivered.add(quote.id);
    if (outcome === "deliver") {
      setBaseBalance(
        world,
        paying.treasuryAddress,
        treasuryWalletUsdc(paying) + quote.amountOut,
      );
      oneClick.state.deliverIntentPayout(quote.depositAddress);
    } else if (outcome === "refund") {
      oneClick.state.refundIntentPayout(quote.depositAddress);
    } else {
      oneClick.state.setStatus(quote.depositAddress, {
        status: "REFUNDED",
        depositedAmount: quote.amountIn,
        refundedAmount: quote.amountIn - 1n,
        refundReason: "PARTIAL_DEPOSIT",
      });
    }
  }
  await deliverSentParts(world, db, paying, delivered);
}

const moveRows = async (paying: TreasuryCompany) =>
  (await readLedger(db, paying)).map((row) => [row.type, row.usdcAmount]);

describe("a move to Treasury from a confidential account", () => {
  it("pays a part by a signed message and debits it once, when 1Click reports it delivered", async () => {
    // #given a 20 USDC move
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    const submittedBefore = oneClick.state.submittedIntents.length;

    // #when the job signs and submits the part, and 1Click hasn't reported yet
    await job();
    const accepted = await quoteOf(paying);
    const beforeOutcome = {
      status: accepted.status,
      signed: accepted.signedIntent !== null,
      submitted: oneClick.state.submittedIntents.length > submittedBefore,
      send: accepted.companyWalletSendId,
      txHash: accepted.depositTxHash,
      rows: await moveRows(paying),
      available: await available(paying),
      move: (await readMove(db, paying, move.id)).status,
    };

    // #then nothing is debited yet and the move still reserves its USDC
    expect(beforeOutcome).toEqual({
      status: "depositing",
      signed: true,
      submitted: true,
      send: null,
      txHash: null,
      rows: [["deposit", 100n * USDC]],
      available: 80n * USDC,
      move: "open",
    });

    // #when 1Click reports it delivered, and the job runs more than once, also at the same time
    await settleParts(paying);
    const together = await Promise.all([job(), job()]);
    await job();

    // #then the part was debited exactly once, with no chain transaction, and the move completed
    const debits = (await readLedger(db, paying)).filter(
      (row) => row.type === "to_treasury",
    );
    const ended = await readMove(db, paying, move.id);
    expect(together.map((run) => run.errors)).toEqual([0, 0]);
    expect({
      debits: debits.map((row) => [
        row.usdcAmount,
        row.treasuryMoveId,
        row.intentQuoteId,
      ]),
      status: ended.status,
      moved: ended.movedUsdc,
      vault: privy.state.earnCalls.map((call) => call.kind),
      balance: await ledgerBalance(db, paying.company),
    }).toEqual({
      debits: [[-20n * USDC, move.id, accepted.id]],
      status: "completed",
      moved: accepted.amountOut,
      vault: ["deposit"],
      balance: 80n * USDC,
    });
    const stored = await runInScope(
      db,
      { organizationId: paying.tenant.organizationId },
      (tx) =>
        tx
          .select({
            txHash: walletTransactions.txHash,
            blockNumber: walletTransactions.blockNumber,
            chain: walletTransactions.chain,
          })
          .from(walletTransactions)
          .where(eq(walletTransactions.type, "to_treasury")),
    );
    expect(stored).toEqual([
      { txHash: null, blockNumber: null, chain: "near" },
    ]);
  });

  it("writes a refunded part's debit and credit together and ends the move returned", async () => {
    // #given a part that was paid
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    const part = await quoteOf(paying);
    expect(isAccepted(part)).toBe(true);

    // #when 1Click refunds it into the account
    await settleParts(paying, "refund");
    const run = await job();

    // #then the ledger is where it started, by one debit and one credit naming the move and the quote
    const ended = await readMove(db, paying, move.id);
    expect({
      errors: run.errors,
      quote: (await quoteOf(paying)).status,
      rows: (await readLedger(db, paying)).map((row) => [
        row.type,
        row.usdcAmount,
        row.treasuryMoveId,
        row.intentQuoteId,
      ]),
      status: ended.status,
      moved: ended.movedUsdc,
      cost: ended.costUsdc,
      balance: await ledgerBalance(db, paying.company),
      available: await available(paying),
      vault: privy.state.earnCalls.length,
    }).toEqual({
      errors: 0,
      quote: "refunded",
      rows: [
        ["deposit", 100n * USDC, null, null],
        ["to_treasury", -20n * USDC, move.id, part.id],
        ["from_treasury", 20n * USDC, move.id, part.id],
      ],
      status: "returned",
      moved: 0n,
      cost: 0n,
      balance: 100n * USDC,
      available: 100n * USDC,
      vault: 0,
    });
    await job();
    expect(await moveRows(paying)).toHaveLength(3);
  });

  it("credits only what 1Click says came back when it refunds less than was paid", async () => {
    // #given a part that was paid
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();

    // #when 1Click refunds all but one base unit
    await settleParts(paying, "partial_refund");
    await job();

    // #then the debit is the whole part and the credit is the refund, so the cost is the difference
    const ended = await readMove(db, paying, move.id);
    expect({
      rows: await moveRows(paying),
      status: ended.status,
      cost: ended.costUsdc,
    }).toEqual({
      rows: [
        ["deposit", 100n * USDC],
        ["to_treasury", -20n * USDC],
        ["from_treasury", 20n * USDC - 1n],
      ],
      status: "returned",
      cost: 1n,
    });
  });

  it("writes neither row when the credit can't be written, so a refund never leaves the ledger short", async () => {
    // #given a refunded part, and a database that refuses the credit
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    await settleParts(paying, "refund");
    const organizationId = paying.tenant.organizationId;
    await owner.query(
      `CREATE OR REPLACE FUNCTION wp4_refuse_credit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'wp4 test: credit refused'; END $$`,
    );
    await owner.query(
      `CREATE TRIGGER wp4_refuse_credit BEFORE INSERT ON wallet_transactions FOR EACH ROW WHEN (NEW.type::text = 'from_treasury' AND NEW.organization_id = '${organizationId}') EXECUTE FUNCTION wp4_refuse_credit()`,
    );
    const quiet = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let refused: { moves: number; errors: number };
    try {
      // #when the job tries
      refused = await job();
    } finally {
      quiet.mockRestore();
      await owner.query(
        "DROP TRIGGER wp4_refuse_credit ON wallet_transactions",
      );
      await owner.query("DROP FUNCTION wp4_refuse_credit()");
    }

    // #then the debit wasn't written alone
    expect({
      errors: refused.errors,
      rows: await moveRows(paying),
      move: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      errors: 1,
      rows: [["deposit", 100n * USDC]],
      move: "open",
    });

    // #when the job runs again with the credit allowed
    await job();

    // #then both rows are there and the move is returned
    expect({
      rows: await moveRows(paying),
      move: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      rows: [
        ["deposit", 100n * USDC],
        ["to_treasury", -20n * USDC],
        ["from_treasury", 20n * USDC],
      ],
      move: "returned",
    });
  });

  it("sends the move to review, writing nothing, when 1Click refunds a part without saying how much", async () => {
    // #given a paid part
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    const part = await quoteOf(paying);

    // #when 1Click reports it refunded with no amount
    oneClick.state.setStatus(part.depositAddress, {
      status: "REFUNDED",
      depositedAmount: part.amountIn,
      refundedAmount: null,
      refundReason: "PARTIAL_DEPOSIT",
    });
    await job();
    await job();

    // #then the ledger is untouched and the move still reserves its USDC
    expect({
      rows: await moveRows(paying),
      move: (await readMove(db, paying, move.id)).status,
      available: await available(paying),
    }).toEqual({
      rows: [["deposit", 100n * USDC]],
      move: "needs_review",
      available: 80n * USDC,
    });
  });

  it("keeps the reservation and puts the move in review while a part is in review", async () => {
    // #given a paid part
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    const part = await quoteOf(paying);

    // #when 1Click reports the swap failed after the deposit
    oneClick.state.setStatus(part.depositAddress, { status: "FAILED" });
    await job();

    // #then the part and the move are in review, nothing is debited, and the USDC stays reserved
    expect({
      quote: (await quoteOf(paying)).status,
      move: (await readMove(db, paying, move.id)).status,
      rows: await moveRows(paying),
      available: await available(paying),
      vault: privy.state.earnCalls.length,
    }).toEqual({
      quote: "needs_review",
      move: "needs_review",
      rows: [["deposit", 100n * USDC]],
      available: 80n * USDC,
      vault: 0,
    });
  });

  it("writes nothing when the part expires unpaid", async () => {
    // #given a part nobody signed
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    const submittedBefore = oneClick.state.submittedIntents.length;
    oneClick.state.failNextGenerate(2);
    await job();
    const part = await quoteOf(paying);
    expect(part.signedIntent).toBeNull();

    // #when its deadline comes too close to sign and the move runs on
    await updateQuote(db, paying.company, part.id, {
      deadline: new Date(Date.now() + 60_000),
    });
    await job();

    // #then no ledger row was written, nothing was submitted, and the move ended failed
    expect({
      quote: (await quoteOf(paying)).status,
      rows: await moveRows(paying),
      submitted: oneClick.state.submittedIntents.length - submittedBefore,
      move: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      quote: "failed",
      rows: [["deposit", 100n * USDC]],
      submitted: 0,
      move: "failed",
    });
  });
});

describe("a move opened before a company's balance moved", () => {
  it("debits a part by the way its own quote was paid, whichever way the company is set now", async () => {
    // #given a company paying from its wallet whose first part, paid by a transfer, is out
    const paying = await company();
    const move = await startMove(world, paying, 50n * USDC);
    await job();
    const first = await quoteOf(paying, 0);
    expect(first.depositType).toBe("ORIGIN_CHAIN");

    // #when the company is switched to a confidential account and the move runs on
    const funded = {
      company: paying.company,
      walletId: paying.wallet.id,
      accountId: paying.accountId,
      transitAddress: paying.transitAddress,
    };
    await switchBalanceHome(db, funded, "confidential_account");
    oneClick.state.fundConfidential(paying.accountId, 100n * USDC);
    const beforeSuccess: bigint[] = [];
    for (let round = 0; round < 40; round += 1) {
      await job();
      const parts = await treasuryQuotes(db, paying);
      const second = parts[1];
      if (second && isAccepted(second) && !delivered.has(second.id)) {
        beforeSuccess.push(
          ...(await readLedger(db, paying))
            .filter((row) => row.intentQuoteId === second.id)
            .map((row) => row.usdcAmount),
        );
      }
      await settleParts(paying);
      if ((await readMove(db, paying, move.id)).status !== "open") break;
    }

    // #then the first part was debited by its send, the second by 1Click's report, each once
    const parts = await treasuryQuotes(db, paying);
    const ledger = await readLedger(db, paying);
    const debitOf = (quote: IntentQuote) =>
      ledger.filter(
        (row) => row.type === "to_treasury" && row.intentQuoteId === quote.id,
      );
    expect({
      sides: parts.map((part) => part.depositType),
      debits: parts.map((part) => debitOf(part).map((row) => row.usdcAmount)),
      beforeSuccess,
      status: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      sides: ["ORIGIN_CHAIN", "CONFIDENTIAL_INTENTS"],
      debits: parts.map((part) => [-part.amountIn]),
      beforeSuccess: [],
      status: "completed",
    });
  });

  it("debits a part paid from the account when the company has since been switched back", async () => {
    // #given a part paid from the confidential account
    const paying = await confidentialCompany();
    const move = await startMove(world, paying, 20n * USDC);
    await job();
    const part = await quoteOf(paying);
    expect(isAccepted(part)).toBe(true);

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
    await settleParts(paying);
    await job();
    await job();

    // #then it was debited once at the report, with no chain transaction, and the move completed
    expect({
      debits: (await readLedger(db, paying))
        .filter((row) => row.type === "to_treasury")
        .map((row) => [row.usdcAmount, row.intentQuoteId]),
      status: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      debits: [[-20n * USDC, part.id]],
      status: "completed",
    });
  });
});

describe("a move to Treasury from a company wallet", () => {
  it("asks 1Click and writes the database exactly as before: no session, no confidential side, a debit with its send's hash", async () => {
    // #given a company paying from its wallet
    const paying = await company();
    const requestsBefore = oneClick.state.quoteRequests.length;
    const callsBefore = oneClick.state.calls.length;
    const intentsBefore = oneClick.state.submittedIntents.length;
    const move = await startMove(world, paying, 20n * USDC);

    // #when its move runs
    await job();
    const part = await quoteOf(paying);
    await deliverSentParts(world, db, paying, delivered);
    await job();

    // #then
    const requests = oneClick.state.quoteRequests.slice(requestsBefore);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(request).not.toHaveProperty("depositType");
      expect(request).not.toHaveProperty("refundType");
      expect(request).not.toHaveProperty("recipientType");
    }
    expect(
      oneClick.state.calls
        .slice(callsBefore)
        .every((call) => call.session === undefined),
    ).toBe(true);
    const [debit] = (await readLedger(db, paying)).filter(
      (row) => row.type === "to_treasury",
    );
    expect({
      sides: [part.depositType, part.refundType],
      signed: part.signedIntent,
      send: part.companyWalletSendId !== null,
      txHash: part.depositTxHash !== null,
      debit: debit?.usdcAmount,
      intents: oneClick.state.submittedIntents.length - intentsBefore,
      status: (await readMove(db, paying, move.id)).status,
    }).toEqual({
      sides: ["ORIGIN_CHAIN", "ORIGIN_CHAIN"],
      signed: null,
      send: true,
      txHash: true,
      debit: -20n * USDC,
      intents: 0,
      status: "completed",
    });
  });
});
