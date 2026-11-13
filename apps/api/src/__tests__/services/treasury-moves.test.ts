import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import {
  notificationOutbox,
  organizations,
  treasuryEarnActions,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { startApproval } from "../../services/approval/passkeys.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import {
  advanceTreasuryMove,
  EARN_MAX_ATTEMPTS,
  stepTreasuryMove,
} from "../../services/treasury/advance.js";
import {
  startMoveConfirmation,
  startTreasuryMove,
  treasuryMoveIntentHash,
} from "../../services/treasury/moves.js";
import { availableUsdc } from "../../services/wallet/ledger.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  updateQuote,
} from "../helpers/near-payouts.js";
import { randomNearTxHash } from "../helpers/near.js";
import { allowlistAddress, ledgerBalance } from "../helpers/payouts.js";
import {
  createTreasuryCompany,
  deliverSentParts,
  readActions,
  readLedger,
  readMove,
  setBaseBalance,
  startMove,
  treasuryQuotes,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, near, oneClick, privy } = world;
let db: Database;
let owner: pg.Pool;
let company: TreasuryCompany;
let delivered: Set<string>;

const COST = 4_465n;
const NO_DELAY = { retryDelayMs: 0 } as const;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  delivered = new Set();
  privy.state.resetEarn();
  privy.state.sends.length = 0;
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
});

const scope = () => ({ organizationId: company.tenant.organizationId });
const ref = (moveId: string) => ({ ...scope(), moveId });
const step = (moveId: string) =>
  runtime.runPromise(stepTreasuryMove(ref(moveId), NO_DELAY));
const advance = (moveId: string) =>
  runtime.runPromise(advanceTreasuryMove(ref(moveId), NO_DELAY));

/**
 * Runs the job's step over and over, with 1Click delivering what has been
 * sent in between, until the move leaves `open`. `check` sees the move's
 * state between every two steps.
 */
async function drive(
  moveId: string,
  check: () => Promise<void> = () => Promise.resolve(),
  rounds = 80,
) {
  for (let round = 0; round < rounds; round += 1) {
    await deliverSentParts(world, db, company, delivered);
    await advance(moveId);
    await check();
    const move = await readMove(db, company, moveId);
    if (move.status !== "open") return move;
  }
  throw new Error(`move ${moveId} still open after ${rounds} rounds`);
}

const failureOf = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  if (failure && typeof failure === "object" && "_tag" in failure) {
    return String(failure._tag);
  }
  return String(failure);
};

const ledger = () => ledgerBalance(db, company.company);
const available = () =>
  runInScope(db, scope(), (tx) =>
    runtime.runPromise(availableUsdc(tx, company.wallet.id)),
  );

/** What the move's audit entries say, oldest first. */
const auditActions = async (): Promise<string[]> => {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE organization_id = $1 AND action LIKE 'treasury_move.%' ORDER BY occurred_at, id",
    [company.tenant.organizationId],
  );
  return rows.map((row) => row.action);
};

/** What the ledger says must be what the company wallet holds (the transit wallet holds nothing). */
const expectLedgerToMatchChain = async () => {
  expect(await ledger()).toBe(near.state.usdcBalanceOf(company.accountId));
};

const liveQuotes = async () =>
  (await treasuryQuotes(db, company)).filter((quote) =>
    ["quoted", "depositing", "needs_review"].includes(quote.status),
  );

describe("a move to Treasury", () => {
  it("goes in parts one at a time, each within the cap, and ends completed with the ledger matching the chain", async () => {
    // #given 70 USDC to move over a 30 USDC cap
    const move = await startMove(world, company, 70n * USDC);
    const seen: { quotes: number; deposited: number; live: number }[] = [];

    // #when the job runs to the end
    const done = await drive(move.id, async () => {
      const quotes = await treasuryQuotes(db, company);
      const deposited = (await readActions(db, company)).filter(
        (action) => action.status === "succeeded",
      ).length;
      seen.push({
        quotes: quotes.length,
        deposited,
        live: (await liveQuotes()).length,
      });
    });

    // #then three even parts, each within the cap, never two open at once
    // and never a new part before the last one's deposit had succeeded
    const quotes = await treasuryQuotes(db, company);
    const actions = await readActions(db, company);
    expect({
      parts: quotes.map((quote) => quote.amountIn),
      neverTwoLive: seen.every((round) => round.live <= 1),
      neverAheadOfDeposits: seen.every(
        (round) => round.quotes <= round.deposited + 1,
      ),
      deposits: actions.map((action) => action.rawAmount),
      sends: near.state.broadcasts.length > 0,
    }).toEqual({
      parts: [23_333_334n, 23_333_333n, 23_333_333n],
      neverTwoLive: true,
      neverAheadOfDeposits: true,
      deposits: quotes.map((quote) => quote.amountOut),
      sends: true,
    });
    expect(quotes.every((quote) => quote.amountIn <= 30n * USDC)).toBe(true);
    const delivery = quotes.reduce((sum, quote) => sum + quote.amountOut, 0n);
    expect({
      status: done.status,
      moved: done.movedUsdc,
      cost: done.costUsdc,
      failure: done.failure,
      vault: privy.state.vaultAssetsOf(company.treasuryPrivyWalletId),
      treasuryWalletLeft: 0n,
      ledger: await ledger(),
    }).toEqual({
      status: "completed",
      moved: delivery,
      cost: 70n * USDC - delivery,
      failure: null,
      vault: delivery,
      treasuryWalletLeft: 0n,
      ledger: 30n * USDC,
    });
    expect(done.costUsdc).toBe(3n * COST);
    await expectLedgerToMatchChain();
  });

  it("quotes EXACT_INPUT to the Treasury wallet, refunds to the company wallet and asks no fee cover", async () => {
    // #given a move
    const move = await startMove(world, company, 20n * USDC);

    // #when it runs
    await drive(move.id);

    // #then
    const [quote] = await treasuryQuotes(db, company);
    expect({
      swapType: quote?.swapType,
      recipient: quote?.recipient,
      refundTo: quote?.refundTo,
      feeCover: quote?.feeCoverUsdc,
      move: quote?.treasuryMoveId,
      registered: quote?.depositRegistrationTxHash !== null,
      asked: oneClick.state.quoteRequests
        .filter((request) => request.recipient === company.treasuryAddress)
        .map((request) => [request.swapType, request.dry]),
    }).toEqual({
      swapType: "EXACT_INPUT",
      recipient: company.treasuryAddress,
      refundTo: company.accountId,
      feeCover: null,
      move: move.id,
      registered: true,
      asked: [["EXACT_INPUT", false]],
    });
  });

  it("writes one to_treasury debit per part, linked to its move and quote, when the send ran", async () => {
    // #given a move whose first part has been sent
    const move = await startMove(world, company, 20n * USDC);
    await step(move.id);
    await step(move.id);
    await step(move.id);

    // #when the send ran and the step is repeated
    await advance(move.id);
    await advance(move.id);

    // #then
    const [quote] = await treasuryQuotes(db, company);
    expect(
      (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ),
    ).toEqual([
      {
        type: "to_treasury",
        usdcAmount: -20n * USDC,
        treasuryMoveId: move.id,
        intentQuoteId: quote?.id,
      },
    ]);
  });

  it("never sends or deposits twice when every step runs twice", async () => {
    // #given a two-part move
    const move = await startMove(world, company, 50n * USDC);

    // #when each step is run twice before 1Click gets a turn
    let done = await readMove(db, company, move.id);
    for (let round = 0; round < 80 && done.status === "open"; round += 1) {
      await step(move.id);
      await step(move.id);
      await deliverSentParts(world, db, company, delivered);
      done = await readMove(db, company, move.id);
    }

    // #then one send and one deposit per part, one debit each
    const quotes = await treasuryQuotes(db, company);
    expect({
      status: done.status,
      quotes: quotes.length,
      sends: quotes.map((quote) =>
        near.state.usdcBalanceOf(quote.depositAddress),
      ),
      earnCalls: privy.state.earnCalls.length,
      references: new Set(privy.state.earnCalls.map((call) => call.referenceId))
        .size,
      debits: (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ).length,
    }).toEqual({
      status: "completed",
      quotes: 2,
      sends: quotes.map((quote) => quote.amountIn),
      earnCalls: 2,
      references: 2,
      debits: 2,
    });
    await expectLedgerToMatchChain();
  });

  it("never sends or deposits twice when two runs overlap at every step", async () => {
    // #given a two-part move
    const move = await startMove(world, company, 50n * USDC);

    // #when two job runs race each other, round after round
    let done = await readMove(db, company, move.id);
    for (let round = 0; round < 80 && done.status === "open"; round += 1) {
      await Promise.allSettled([
        runtime.runPromise(stepTreasuryMove(ref(move.id), NO_DELAY)),
        runtime.runPromise(stepTreasuryMove(ref(move.id), NO_DELAY)),
      ]);
      await deliverSentParts(world, db, company, delivered);
      done = await readMove(db, company, move.id);
    }

    // #then
    const quotes = await treasuryQuotes(db, company);
    expect({
      status: done.status,
      sends: quotes.map((quote) =>
        near.state.usdcBalanceOf(quote.depositAddress),
      ),
      earnCalls: privy.state.earnCalls.length,
      debits: (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ).length,
    }).toEqual({
      status: "completed",
      sends: quotes.map((quote) => quote.amountIn),
      earnCalls: 2,
      debits: quotes.length,
    });
    await expectLedgerToMatchChain();
  });

  it("deposits what the quote delivered, never the Treasury wallet's whole balance", async () => {
    // #given USDC a stranger sent to the Treasury wallet before the move
    setBaseBalance(world, company.treasuryAddress, 500n * USDC);
    const move = await startMove(world, company, 20n * USDC);

    // #when the move runs
    const done = await drive(move.id);

    // #then only what was delivered went into the vault and the stranger's USDC
    // is still there, uncredited
    const [quote] = await treasuryQuotes(db, company);
    expect({
      status: done.status,
      deposited: privy.state.earnCalls.map((call) => call.rawAmount),
      vault: privy.state.vaultAssetsOf(company.treasuryPrivyWalletId),
      ledger: (await readLedger(db, company)).map((row) => row.type),
    }).toEqual({
      status: "completed",
      deposited: [quote?.amountOut],
      vault: quote?.amountOut,
      ledger: ["deposit", "to_treasury"],
    });
  });

  it("waits while the delivery hasn't reached the Treasury wallet, then deposits it", async () => {
    // #given a delivered part whose USDC the chain doesn't show yet
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
    });

    // #when the job runs
    await advance(move.id);
    await advance(move.id);

    // #then nothing was deposited, less or otherwise
    expect({
      earnCalls: privy.state.earnCalls.length,
      actions: (await readActions(db, company)).length,
      status: (await readMove(db, company, move.id)).status,
    }).toEqual({ earnCalls: 0, actions: 0, status: "open" });

    // #when the USDC arrives
    setBaseBalance(world, company.treasuryAddress, quote.amountOut);
    const done = await drive(move.id);

    // #then exactly the delivery goes in
    expect({
      status: done.status,
      deposited: privy.state.earnCalls.map((call) => call.rawAmount),
    }).toEqual({ status: "completed", deposited: [quote.amountOut] });
  });

  it("goes to review rather than deposit less when the USDC never arrives", async () => {
    // #given a delivery reported half an hour ago that the chain never shows
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    oneClick.state.setStatus(quote.depositAddress, {
      status: "SUCCESS",
      depositedAmount: quote.amountIn,
      amountIn: quote.amountIn,
      amountOut: quote.amountOut,
    });
    await advance(move.id);
    await updateQuote(db, company.company, quote.id, {
      settledAt: new Date(Date.now() - 31 * 60_000),
    });

    // #when the job runs
    await advance(move.id);

    // #then
    const reviewed = await readMove(db, company, move.id);
    expect({
      status: reviewed.status,
      failure: reviewed.failure,
      earnCalls: privy.state.earnCalls.length,
    }).toEqual({
      status: "needs_review",
      failure: expect.stringContaining("Check the Treasury wallet") as string,
      earnCalls: 0,
    });
  });
});

describe("when something goes wrong with a move to Treasury", () => {
  it("fails with nothing moved when no quote can be had, and releases the reservation", async () => {
    // #given 1Click refusing quotes, past the retry window
    oneClick.state.failNextQuotes("refused");
    const move = await startMove(world, company, 20n * USDC);
    expect(await available()).toBe(80n * USDC);

    // #when
    const failed = await advance(move.id);

    // #then
    expect({
      status: failed?.status,
      failure: failed?.failure,
      moved: failed?.movedUsdc,
      reserved: await available(),
      quotes: (await treasuryQuotes(db, company)).length,
      ledger: await ledger(),
    }).toEqual({
      status: "failed",
      failure: expect.stringContaining("Nothing was sent") as string,
      moved: 0n,
      reserved: 100n * USDC,
      quotes: 0,
      ledger: 100n * USDC,
    });
    await expectLedgerToMatchChain();
  });

  it("completes for less when a later part can't be quoted", async () => {
    // #given the first of two parts deposited, then 1Click refusing
    const move = await startMove(world, company, 50n * USDC);
    let current = await readMove(db, company, move.id);
    while (
      (await readActions(db, company)).every(
        (action) => action.status !== "succeeded",
      )
    ) {
      await deliverSentParts(world, db, company, delivered);
      await step(move.id);
      current = await readMove(db, company, move.id);
    }
    expect(current.status).toBe("open");
    oneClick.state.failNextQuotes("refused");

    // #when
    const done = await advance(move.id);

    // #then
    const [first] = await treasuryQuotes(db, company);
    expect({
      status: done?.status,
      moved: done?.movedUsdc,
      cost: done?.costUsdc,
      ledger: await ledger(),
    }).toEqual({
      status: "completed",
      moved: first?.amountOut,
      cost: COST,
      ledger: 75n * USDC,
    });
    await expectLedgerToMatchChain();
  });

  it("waits and quotes again when 1Click doesn't answer, instead of ending the move", async () => {
    // #given 1Click losing the reply to the first quote request
    oneClick.state.failNextQuotes("unknown");
    const move = await startMove(world, company, 20n * USDC);

    // #when the job runs
    const waiting = await advance(move.id);

    // #then the move is still open with nothing sent
    expect({
      status: waiting?.status,
      quotes: (await treasuryQuotes(db, company)).length,
    }).toEqual({ status: "open", quotes: 0 });

    // #when 1Click answers again
    const done = await drive(move.id);

    // #then it completes
    expect(done.status).toBe("completed");
  });

  it("takes a new quote when one expires before its deposit starts, without sending the old one", async () => {
    // #given a saved quote whose deadline is too close to start a deposit
    const move = await startMove(world, company, 20n * USDC);
    await step(move.id);
    const [first] = await treasuryQuotes(db, company);
    if (!first) throw new Error("no quote");
    await updateQuote(db, company.company, first.id, {
      deadline: new Date(Date.now() + 60_000),
    });

    // #when the job runs to the end
    const done = await drive(move.id);

    // #then the first quote expired unused and a second one carried the part
    const quotes = await treasuryQuotes(db, company);
    expect({
      status: done.status,
      quotes: quotes.map((quote) => quote.status),
      oldHolds: near.state.usdcBalanceOf(first.depositAddress),
      keys: quotes.map((quote) => quote.quoteKey.split(":").at(-1)),
      ledger: await ledger(),
    }).toEqual({
      status: "completed",
      quotes: ["expired", "succeeded"],
      oldHolds: 0n,
      keys: ["1", "2"],
      ledger: 80n * USDC,
    });
    await expectLedgerToMatchChain();
  });

  it("never pays a quote whose recipient isn't the Treasury wallet its company has now", async () => {
    // #given a saved quote, then the company's Treasury wallet row changing
    // under it (a quote can never be trusted over the row)
    const move = await startMove(world, company, 20n * USDC);
    await step(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    await owner.query(
      "UPDATE wallets SET treasury_address = $1 WHERE id = $2",
      [randomAddress(), company.wallet.id],
    );

    // #when the job runs
    await advance(move.id);

    // #then the quote was expired unused and nothing was sent to it
    const [after] = await treasuryQuotes(db, company);
    expect({
      quote: after?.status,
      holds: near.state.usdcBalanceOf(quote.depositAddress),
      failure: after?.failure,
    }).toEqual({
      quote: "expired",
      holds: 0n,
      failure: expect.stringContaining("own Treasury wallet") as string,
    });
  });

  it("fails with nothing moved when Privy refuses the company wallet's send", async () => {
    // #given a company wallet that holds too little on chain
    near.state.balances.set(company.accountId, 1n * USDC);
    const move = await startMove(world, company, 20n * USDC);

    // #when
    const failed = await advance(move.id);

    // #then the part's quote failed, nothing was debited, the move failed
    const [quote] = await treasuryQuotes(db, company);
    expect({
      move: failed?.status,
      quote: quote?.status,
      debits: (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ),
      depositAddressHolds: near.state.usdcBalanceOf(
        quote?.depositAddress ?? "",
      ),
    }).toEqual({
      move: "failed",
      quote: "failed",
      debits: [],
      depositAddressHolds: 0n,
    });
  });

  it("keeps the move open and never sends again while the send's outcome is unclear", async () => {
    // #given a send the chain ran but hasn't reported
    near.state.nextBroadcasts("run", "withhold");
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);

    // #then the move waits, with nothing debited and one send at most
    expect({
      move: (await readMove(db, company, move.id)).status,
      quote: quote?.status,
      debits: (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ).length,
    }).toEqual({ move: "open", quote: "depositing", debits: 0 });

    // #when the chain reports it
    near.state.release();
    const done = await drive(move.id);

    // #then one send, one debit, one deposit
    expect({
      status: done.status,
      holds: near.state.usdcBalanceOf(quote?.depositAddress ?? ""),
      debits: (await readLedger(db, company)).filter(
        (row) => row.type === "to_treasury",
      ).length,
      earnCalls: privy.state.earnCalls.length,
    }).toEqual({
      status: "completed",
      holds: quote?.amountIn,
      debits: 1,
      earnCalls: 1,
    });
  });

  it("goes to review when a send is still unclear long after the deadline", async () => {
    // #given an unclear send and a deadline long past
    near.state.nextBroadcasts("run", "withhold");
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    await updateQuote(db, company.company, quote.id, {
      deadline: new Date(Date.now() - 20 * 60_000),
    });

    // #when
    const reviewed = await advance(move.id);

    // #then
    expect(reviewed?.status).toBe("needs_review");
  });

  it("goes to review when 1Click reports FAILED, keeping what was debited", async () => {
    // #given a part that was sent
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");

    // #when 1Click gives up on it
    oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
    await advance(move.id);
    const reviewed = await advance(move.id);

    // #then
    expect({
      status: reviewed?.status,
      moved: reviewed?.movedUsdc,
      ledger: await ledger(),
      audit: await auditActions(),
    }).toEqual({
      status: "needs_review",
      moved: null,
      ledger: 80n * USDC,
      audit: ["treasury_move.started", "treasury_move.needs_review"],
    });
    await expectLedgerToMatchChain();
  });

  it("ends returned only after the refund is credited as from_treasury", async () => {
    // #given a part that was sent, then refunded by 1Click to the company wallet
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    oneClick.state.setStatus(quote.depositAddress, {
      status: "REFUNDED",
      refundedAmount: quote.amountIn,
      refundReason: "deadline",
    });
    near.state.fundWithUsdc(company.accountId, quote.amountIn);

    // #when the job marks the quote refunded, before the watcher credits it
    const waiting = await advance(move.id);
    const refunded = (await treasuryQuotes(db, company))[0];

    // #then the quote is refunded, so the watcher may credit it, and the move waits
    expect({
      move: waiting?.status,
      quote: refunded?.status,
      ledger: await ledger(),
    }).toEqual({ move: "open", quote: "refunded", ledger: 80n * USDC });

    // #when the watcher credits the return
    await runInScope(db, scope(), (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: company.tenant.organizationId,
        walletId: company.wallet.id,
        type: "from_treasury",
        chain: "near",
        usdcAmount: quote.amountIn,
        treasuryMoveId: move.id,
        txHash: randomNearTxHash(),
        receiptId: randomNearTxHash(),
        logIndex: 0,
        transferIndex: 0,
      }),
    );
    const returned = await advance(move.id);

    // #then the move is returned with nothing at the vault and the ledger whole
    expect({
      status: returned?.status,
      moved: returned?.movedUsdc,
      cost: returned?.costUsdc,
      earnCalls: privy.state.earnCalls.length,
      ledger: await ledger(),
      audit: await auditActions(),
    }).toEqual({
      status: "returned",
      moved: 0n,
      cost: 0n,
      earnCalls: 0,
      ledger: 100n * USDC,
      audit: ["treasury_move.started", "treasury_move.returned"],
    });
    await expectLedgerToMatchChain();
  });

  it("goes to review when a refund is never credited", async () => {
    // #given a refunded part whose credit hasn't arrived in half an hour
    const move = await startMove(world, company, 20n * USDC);
    await advance(move.id);
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    oneClick.state.setStatus(quote.depositAddress, {
      status: "REFUNDED",
      refundedAmount: quote.amountIn,
    });
    await advance(move.id);
    await updateQuote(db, company.company, quote.id, {
      settledAt: new Date(Date.now() - 31 * 60_000),
    });

    // #when
    const reviewed = await advance(move.id);

    // #then
    expect(reviewed?.status).toBe("needs_review");
  });

  describe("the vault deposit", () => {
    const untilDepositCalled = async (moveId: string) => {
      for (let round = 0; round < 30; round += 1) {
        await deliverSentParts(world, db, company, delivered);
        await advance(moveId);
        if (privy.state.earnCalls.length > 0) return;
      }
      throw new Error("the deposit was never called");
    };

    it("retries a rejected deposit with a new reference and goes on", async () => {
      // #given Privy rejecting the first deposit
      privy.state.nextEarnCalls("rejected");
      const move = await startMove(world, company, 20n * USDC);

      // #when
      const done = await drive(move.id);

      // #then two attempts, each its own reference, the second succeeded
      const actions = await readActions(db, company);
      expect({
        status: done.status,
        attempts: actions.map((action) => [action.attempt, action.status]),
        references: new Set(actions.map((action) => action.referenceId)).size,
        longest: Math.max(
          ...actions.map((action) => action.referenceId.length),
        ),
        called: privy.state.earnCalls.map((call) => call.referenceId),
        vault: privy.state.vaultAssetsOf(company.treasuryPrivyWalletId),
      }).toEqual({
        status: "completed",
        attempts: [
          [1, "rejected"],
          [2, "succeeded"],
        ],
        references: 2,
        longest: expect.any(Number) as number,
        called: actions.map((action) => action.referenceId),
        vault: actions[1]?.rawAmount,
      });
      expect(actions.every((a) => a.referenceId.length <= 64)).toBe(true);
      expect(
        actions.every((a) => a.referenceId === `tr-${a.id}-${a.attempt}`),
      ).toBe(true);
    });

    it("goes to review after three rejections, and says staff can send the USDC back", async () => {
      // #given Privy rejecting every deposit
      privy.state.nextEarnCalls("rejected", "rejected", "rejected", "rejected");
      const move = await startMove(world, company, 20n * USDC);

      // #when
      const reviewed = await drive(move.id);

      // #then
      expect({
        status: reviewed.status,
        attempts: (await readActions(db, company)).length,
        calls: privy.state.earnCalls.length,
        failure: reviewed.failure,
        debited: await ledger(),
      }).toEqual({
        status: "needs_review",
        attempts: EARN_MAX_ATTEMPTS,
        calls: EARN_MAX_ATTEMPTS,
        failure: expect.stringContaining("send it back") as string,
        debited: 80n * USDC,
      });
    });

    it("treats a refusal before signing like a rejection", async () => {
      // #given Privy answering the first call with a 400
      privy.state.nextEarnCalls("refused");
      const move = await startMove(world, company, 20n * USDC);

      // #when
      const done = await drive(move.id);

      // #then it went in on the second reference
      const actions = await readActions(db, company);
      expect({
        status: done.status,
        attempts: actions.map((action) => [action.attempt, action.status]),
      }).toEqual({
        status: "completed",
        attempts: [
          [1, "rejected"],
          [2, "succeeded"],
        ],
      });
    });

    it("goes to review when the deposit reverts", async () => {
      // #given a deposit that fails on chain
      privy.state.nextEarnCalls("failed");
      const move = await startMove(world, company, 20n * USDC);

      // #when
      const reviewed = await drive(move.id);

      // #then
      expect({
        status: reviewed.status,
        failure: reviewed.failure,
        calls: privy.state.earnCalls.length,
      }).toEqual({
        status: "needs_review",
        failure: expect.stringContaining("reverted") as string,
        calls: 1,
      });
    });

    it("keeps polling a pending deposit and never calls Privy again", async () => {
      // #given a deposit Privy hasn't settled
      privy.state.nextEarnCalls("pending");
      const move = await startMove(world, company, 20n * USDC);
      await untilDepositCalled(move.id);
      await advance(move.id);
      await advance(move.id);
      const [action] = await readActions(db, company);

      // #then it is pending, with one call made
      expect({
        status: action?.status,
        calls: privy.state.earnCalls.length,
        move: (await readMove(db, company, move.id)).status,
      }).toEqual({ status: "pending", calls: 1, move: "open" });

      // #when Privy settles it
      privy.state.settleEarnAction(action?.privyActionId ?? "", "succeeded");
      const done = await drive(move.id);

      // #then
      expect({
        status: done.status,
        calls: privy.state.earnCalls.length,
        hash: (await readActions(db, company))[0]?.txHash,
      }).toEqual({
        status: "completed",
        calls: 1,
        hash: expect.stringMatching(/^0x[0-9a-f]{64}$/) as string,
      });
    });

    it("repeats an unanswered call with the same reference and never a new one", async () => {
      // #given a call whose reply was lost
      privy.state.nextEarnCalls("unknown");
      const move = await startMove(world, company, 20n * USDC);
      await untilDepositCalled(move.id);
      const [saved] = await readActions(db, company);
      expect(saved?.status).toBe("saved");

      // #when the job runs again before Privy settles the action
      await advance(move.id);
      await advance(move.id);
      const [pending] = await readActions(db, company);
      privy.state.settleEarnAction(
        privy.state.actionIdFor(saved?.referenceId ?? "") ?? "",
        "succeeded",
      );
      const done = await drive(move.id);

      // #then one row, one reference, one call, one vault deposit
      const actions = await readActions(db, company);
      expect({
        rows: actions.length,
        referenceSame: actions[0]?.referenceId === saved?.referenceId,
        pendingRow: pending?.status,
        calls: privy.state.earnCalls.length,
        status: done.status,
        vault: privy.state.vaultAssetsOf(company.treasuryPrivyWalletId),
      }).toEqual({
        rows: 1,
        referenceSame: true,
        pendingRow: "pending",
        calls: 1,
        status: "completed",
        vault: actions[0]?.rawAmount,
      });
    });
  });

  it("goes to review rather than repeat a deposit call that was never confirmed for an hour", async () => {
    // #given a saved deposit whose call was started over an hour ago
    privy.state.nextEarnCalls("unknown");
    const move = await startMove(world, company, 20n * USDC);
    for (let round = 0; round < 30; round += 1) {
      await deliverSentParts(world, db, company, delivered);
      await advance(move.id);
      if (privy.state.earnCalls.length > 0) break;
    }
    await runInScope(db, scope(), (tx) =>
      tx
        .update(treasuryEarnActions)
        .set({ callStartedAt: new Date(Date.now() - 61 * 60_000) }),
    );

    // #when
    const reviewed = await advance(move.id);

    // #then
    expect({
      status: reviewed?.status,
      calls: privy.state.earnCalls.length,
    }).toEqual({ status: "needs_review", calls: 1 });
  });
});

describe("starting a move to Treasury", () => {
  const tenantAs = (role: Tenant["role"]): Tenant => ({
    ...company.tenant,
    role,
  });
  const request = { direction: "to_treasury", amountUsdc: 20n * USDC } as const;

  /**
   * A passkey confirmation for `amountUsdc`, asked for without the
   * confirmation route's own checks, so what is refused is the start itself.
   */
  const confirmed = async (
    target: TreasuryCompany,
    amountUsdc: bigint,
    direction: "to_treasury" | "to_wallet" = "to_treasury",
  ) => {
    const challenge = await runtime.runPromise(
      startApproval({
        organizationId: target.tenant.organizationId,
        userId: target.tenant.userId,
        purpose:
          direction === "to_treasury" ? "move_to_treasury" : "move_to_wallet",
        intentHash: treasuryMoveIntentHash(target.tenant.organizationId, {
          direction,
          amountUsdc,
        }),
      }),
    );
    return {
      direction,
      amountUsdc,
      challengeId: challenge.challengeId,
      response: target.passkey.sign(challenge.options, TEST_ORIGIN),
    };
  };

  const refusal = async (
    target: TreasuryCompany,
    amountUsdc: bigint,
    tenant: Tenant = target.tenant,
  ) =>
    failureOf(
      await runtime.runPromiseExit(
        startTreasuryMove(tenant, await confirmed(target, amountUsdc)),
      ),
    );

  it("saves the move open with its approval, reserves it and audits it", async () => {
    // #when
    const move = await startMove(world, company, 20n * USDC);

    // #then
    expect({
      status: move.status,
      direction: move.direction,
      requested: move.requestedUsdc,
      confirmedBy: move.confirmedBy,
      available: await available(),
      audit: await auditActions(),
    }).toEqual({
      status: "open",
      direction: "to_treasury",
      requested: 20n * USDC,
      confirmedBy: company.tenant.userId,
      available: 80n * USDC,
      audit: ["treasury_move.started"],
    });
  });

  it("refuses a confirmation made for another amount", async () => {
    // #given a passkey confirmation for 20 USDC
    const challenge = await runtime.runPromise(
      startMoveConfirmation(company.tenant, request),
    );

    // #when it is used to start 30
    const exit = await runtime.runPromiseExit(
      startTreasuryMove(company.tenant, {
        ...request,
        amountUsdc: 30n * USDC,
        challengeId: challenge.challengeId,
        response: company.passkey.sign(challenge.options, TEST_ORIGIN),
      }),
    );

    // #then
    expect(failureOf(exit)).toBe("Forbidden");
  });

  it.each([["employee" as const], ["accountant" as const]])(
    "refuses a %s",
    async (role) => {
      // #when
      const confirmation = await runtime.runPromiseExit(
        startMoveConfirmation(tenantAs(role), request),
      );
      const start = await refusal(company, 20n * USDC, tenantAs(role));

      // #then
      expect({ confirmation: failureOf(confirmation), start }).toEqual({
        confirmation: "Forbidden",
        start: "Forbidden",
      });
    },
  );

  it("refuses when Treasury isn't turned on", async () => {
    // #given a company with a wallet and no Treasury
    const paying = await createNearPayingCompany(world, db, {
      balance: 100n * USDC,
    });
    const off: TreasuryCompany = {
      ...paying,
      tenant: {
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        membershipId: paying.company.adminMembershipId,
        role: "admin",
      },
      treasuryAddress: "",
      treasuryPrivyWalletId: "",
    };

    // #then
    expect(await refusal(off, 20n * USDC)).toBe("Conflict");
  });

  it("refuses under 10 USDC and accepts exactly 10", async () => {
    // #then
    expect(await refusal(company, 9_999_999n)).toBe("BadRequest");
    expect((await startMove(world, company, 10n * USDC)).status).toBe("open");
  });

  it("refuses more than the wallet has available", async () => {
    // #then
    expect(await refusal(company, 100n * USDC + 1n)).toBe("Conflict");
    expect(await available()).toBe(100n * USDC);
  });

  it("refuses a second open move, whatever its size", async () => {
    // #given an open move
    await startMove(world, company, 20n * USDC);

    // #then
    expect(await refusal(company, 10n * USDC)).toBe("Conflict");
  });

  it("refuses a second move that the database would also refuse, as one conflict", async () => {
    // #given two confirmations, taken before either move starts
    const first = await confirmed(company, 20n * USDC);
    const second = await confirmed(company, 20n * USDC);

    // #when both start at once
    const exits = await Promise.all([
      runtime.runPromiseExit(startTreasuryMove(company.tenant, first)),
      runtime.runPromiseExit(startTreasuryMove(company.tenant, second)),
    ]);

    // #then one starts and the other is a conflict
    expect(exits.map(failureOf).sort()).toEqual(["Conflict", "succeeded"]);
  });

  it("refuses when the company is paused", async () => {
    // #given a confirmation, then a pause
    const start = await confirmed(company, 20n * USDC);
    await runInScope(db, scope(), (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, company.tenant.organizationId)),
    );

    // #then
    const exit = await runtime.runPromiseExit(
      startTreasuryMove(company.tenant, start),
    );
    expect(failureOf(exit)).toBe("Conflict");
  });

  it("waits for the company wallet's row lock before checking what is available", async () => {
    // #given the company wallet's row locked by someone else. The lock is
    // FOR NO KEY UPDATE, which blocks payout approval's and the move's own
    // FOR UPDATE but not the foreign key check of the insert that follows, so
    // only the move's own lock can make it wait.
    const start = await confirmed(company, 20n * USDC);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const lockTaken = new Promise<void>((resolve) => {
      locked = resolve;
    });
    const holder = runInScope(db, scope(), async (tx) => {
      await tx.execute(
        sql`SELECT id FROM wallets WHERE id = ${company.wallet.id} FOR NO KEY UPDATE`,
      );
      locked();
      await held;
    });
    await lockTaken;

    // #when the move is started meanwhile
    let finished = false;
    const starting = runtime
      .runPromise(startTreasuryMove(company.tenant, start))
      .finally(() => {
        finished = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 400));

    // #then it hasn't got past the lock; once released it starts
    const waitedForLock = !finished;
    release();
    await holder;
    const move = await starting;
    expect({ waitedForLock, status: move.status }).toEqual({
      waitedForLock: true,
      status: "open",
    });
  });

  it("doesn't count a Treasury move against the daily cap", async () => {
    // #given a company whose daily cap is far below the move
    await runInScope(db, scope(), (tx) =>
      tx
        .update(organizations)
        .set({ dailyPayoutCapKes: 100n })
        .where(eq(organizations.id, company.tenant.organizationId)),
    );

    // #when
    const move = await startMove(world, company, 50n * USDC);

    // #then
    expect(move.status).toBe("open");
  });

  it("stops a payout started during an open move from spending what it reserved", async () => {
    // #given 95 of the wallet's 100 USDC reserved by an open move
    await startMove(world, company, 95n * USDC);
    const address = randomAddress();
    await allowlistAddress(runtime, company, address, "Supplier", "base");
    const prepared = await runtime.runPromise(
      preparePayouts({
        organizationId: company.tenant.organizationId,
        actor: { type: "user", id: company.tenant.userId },
        requests: [
          {
            subjectType: "bill",
            subjectId: randomUUID(),
            idempotencyKey: `bill:${randomUUID()}:1`,
            recipient: {
              method: "usdc",
              chain: "base",
              address,
              accountName: "Supplier",
            },
            amountUsdc: 10n * USDC,
          },
        ],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: company.tenant.organizationId,
        userId: company.tenant.userId,
        payoutIds: prepared.map((payout) => payout.id),
      }),
    );

    // #when the admin approves it
    const exit = await runtime.runPromiseExit(
      approvePayouts({
        organizationId: company.tenant.organizationId,
        userId: company.tenant.userId,
        challengeId: approval.challengeId,
        response: company.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then it is refused for balance
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(
      failure && typeof failure === "object" && "reason" in failure
        ? failure.reason
        : "no reason",
    ).toBe("insufficient_balance");
  });
});

describe("a paused company's open move", () => {
  it("still finishes", async () => {
    // #given an open move, then a pause
    const move = await startMove(world, company, 20n * USDC);
    await runInScope(db, scope(), (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, company.tenant.organizationId)),
    );

    // #when
    const done = await drive(move.id);

    // #then
    expect(done.status).toBe("completed");
  });
});

describe("notifications and audit", () => {
  const outbox = () =>
    runInScope(db, scope(), (tx) =>
      tx
        .select({
          kind: notificationOutbox.kind,
          channel: notificationOutbox.channel,
          audience: notificationOutbox.audience,
        })
        .from(notificationOutbox)
        .where(
          and(
            eq(
              notificationOutbox.organizationId,
              company.tenant.organizationId,
            ),
          ),
        )
        .orderBy(notificationOutbox.createdAt),
    );

  it("tells the admin who started a completed move by push", async () => {
    // #given
    const move = await startMove(world, company, 20n * USDC);

    // #when
    await drive(move.id);

    // #then
    expect(
      (await outbox()).filter((row) => row.kind.startsWith("treasury_move")),
    ).toEqual([
      { kind: "treasury_move_completed", channel: "push", audience: "member" },
    ]);
  });

  it("tells every admin by push and email when a move ends without completing", async () => {
    // #given
    oneClick.state.failNextQuotes("refused");
    const move = await startMove(world, company, 20n * USDC);

    // #when
    await advance(move.id);

    // #then
    expect(
      (await outbox())
        .filter((row) => row.kind.startsWith("treasury_move"))
        .map((row) => [row.kind, row.channel, row.audience])
        .sort(),
    ).toEqual([
      ["treasury_move_ended", "email", "admins"],
      ["treasury_move_ended", "push", "admins"],
    ]);
  });

  it.each([
    ["completed", undefined],
    ["failed", "refused" as const],
  ])("audits a move that %s", async (outcome, failure) => {
    // #given
    if (failure) oneClick.state.failNextQuotes(failure);
    const move = await startMove(world, company, 20n * USDC);

    // #when
    await drive(move.id);

    // #then
    expect(await auditActions()).toEqual([
      "treasury_move.started",
      `treasury_move.${outcome}`,
    ]);
  });
});

describe("the Earn actions table", () => {
  it("allows one live call per move", async () => {
    // #given a move whose first deposit is saved and live
    privy.state.nextEarnCalls("pending");
    const move = await startMove(world, company, 20n * USDC);
    for (let round = 0; round < 30; round += 1) {
      await deliverSentParts(world, db, company, delivered);
      await advance(move.id);
      if ((await readActions(db, company)).length > 0) break;
    }
    const [action] = await readActions(db, company);
    if (!action) throw new Error("no action");

    // #when a second live row is inserted for the same move
    const second = runInScope(db, scope(), (tx) =>
      tx.insert(treasuryEarnActions).values({
        organizationId: action.organizationId,
        treasuryMoveId: action.treasuryMoveId,
        intentQuoteId: action.intentQuoteId,
        kind: "deposit",
        attempt: 2,
        referenceId: `tr-${randomUUID()}-2`,
        rawAmount: action.rawAmount,
      }),
    );

    // #then the database refuses it
    await expect(second).rejects.toThrow();
  });
});
