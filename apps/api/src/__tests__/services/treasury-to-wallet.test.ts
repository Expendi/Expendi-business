import { and, eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
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
import type { Tenant } from "../../middleware/tenant.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  notificationOutbox,
  organizations,
  treasuryEarnActions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { startApproval } from "../../services/approval/passkeys.js";
import {
  advanceTreasuryMove,
  stepTreasuryMove,
} from "../../services/treasury/advance.js";
import {
  previewTreasuryMove,
  startMoveConfirmation,
  startTreasuryMove,
  treasuryMoveIntentHash,
} from "../../services/treasury/moves.js";
import { returnStrandedDeposit } from "../../services/treasury/stranded.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  updateQuote,
} from "../helpers/near-payouts.js";
import { ledgerBalance } from "../helpers/payouts.js";
import {
  alsoInNextWithdrawal,
  createTreasuryCompany,
  creditDeliveries,
  deliverSentParts,
  fundVault,
  readActions,
  readLedger,
  readMove,
  returnQuotes,
  setBaseBalance,
  settleSentReturns,
  startMove,
  startMoveToWallet,
  treasuryQuotes,
  treasuryWalletUsdc,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const world = makeNearPayoutWorld({ PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, near, oneClick, privy, base } = world;
let db: Database;
let owner: pg.Pool;
let company: TreasuryCompany;
let settled: Set<string>;
let credited: Set<string>;
let delivered: Set<string>;

const COST = 4_465n;
const NO_DELAY = { retryDelayMs: 0 } as const;
/** What the company wallet and the vault hold between them at the start. */
const IN_VAULT = 70n * USDC;
const TOTAL = 100n * USDC + IN_VAULT;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  settled = new Set();
  credited = new Set();
  delivered = new Set();
  privy.state.resetEarn();
  privy.state.sends.length = 0;
  oneClick.state.clearQuoteFailures();
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
  fundVault(world, company, IN_VAULT);
});

const scope = () => ({ organizationId: company.tenant.organizationId });
const ref = (moveId: string) => ({ ...scope(), moveId });
const step = (moveId: string) =>
  runtime.runPromise(stepTreasuryMove(ref(moveId), NO_DELAY));
const advance = (moveId: string) =>
  runtime.runPromise(advanceTreasuryMove(ref(moveId), NO_DELAY));

/**
 * Runs the job over and over, 1Click settling what the Treasury wallet has
 * sent and the deposit watcher crediting what it delivered in between, until
 * the move leaves `open`. `check` sees the state between every two runs.
 */
async function drive(
  moveId: string,
  check: () => Promise<void> = () => Promise.resolve(),
  options: { rounds?: number; outcome?: "deliver" | "refund" } = {},
) {
  const rounds = options.rounds ?? 80;
  for (let round = 0; round < rounds; round += 1) {
    await settleSentReturns(world, db, company, settled, options.outcome);
    await creditDeliveries(world, db, company, credited);
    await advance(moveId);
    await check();
    const move = await readMove(db, company, moveId);
    if (move.status !== "open") return move;
  }
  throw new Error(`move ${moveId} still open after ${rounds} rounds`);
}

/** A move to Treasury, run to the end the way T3's tests do. */
async function driveToTreasury(moveId: string) {
  for (let round = 0; round < 80; round += 1) {
    await deliverSentParts(world, db, company, delivered);
    await advance(moveId);
    const move = await readMove(db, company, moveId);
    if (move.status !== "open") return move;
  }
  throw new Error(`move ${moveId} still open`);
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
const nearBalance = () => near.state.usdcBalanceOf(company.accountId);
const inVault = () => privy.state.vaultAssetsOf(company.treasuryPrivyWalletId);

const auditActions = async (): Promise<string[]> => {
  const { rows } = await owner.query<{ action: string }>(
    "SELECT action FROM audit_log WHERE organization_id = $1 AND action LIKE 'treasury_move.%' ORDER BY occurred_at, id",
    [company.tenant.organizationId],
  );
  return rows.map((row) => row.action);
};

const outbox = () =>
  runInScope(db, scope(), (tx) =>
    tx
      .select({
        kind: notificationOutbox.kind,
        channel: notificationOutbox.channel,
        audience: notificationOutbox.audience,
        title: notificationOutbox.title,
      })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, company.tenant.organizationId),
        ),
      )
      .orderBy(notificationOutbox.createdAt),
  );

const treasuryMessages = async () =>
  (await outbox()).filter((row) => row.kind.startsWith("treasury_move"));

/**
 * The ledger is what the company wallet holds on NEAR, and no USDC went
 * missing: what the wallet, the vault and the Treasury wallet hold between
 * them is what there was, less what 1Click charged.
 */
async function expectReconciled(treasuryExtra = 0n) {
  expect(await ledger()).toBe(nearBalance());
  const costs = (await returnQuotes(db, company))
    .filter((quote) => quote.status === "succeeded")
    .reduce((sum, quote) => sum + (quote.amountIn - quote.amountOut), 0n);
  expect(
    nearBalance() + inVault() + treasuryWalletUsdc(company) - treasuryExtra,
  ).toBe(TOTAL - costs);
}

/** Makes the Earn actions' last news older, as time passing would. */
const ageEarnActions = (
  field: "callStartedAt" | "settledAt",
  minutes: number,
) =>
  runInScope(db, scope(), (tx) =>
    tx
      .update(treasuryEarnActions)
      .set({ [field]: new Date(Date.now() - minutes * 60_000) }),
  );

const liveReturns = async () =>
  (await returnQuotes(db, company)).filter((quote) =>
    ["quoted", "depositing", "needs_review"].includes(quote.status),
  );

const withdrawals = async () =>
  (await readActions(db, company)).filter((a) => a.kind === "withdraw");

describe("a move to the wallet", () => {
  it("withdraws once, then sends what arrived back in parts one at a time, each within the cap", async () => {
    // #given 70 USDC in the vault and a 30 USDC cap
    const move = await startMoveToWallet(world, company, 70n * USDC);
    const seen: { quotes: number; live: number }[] = [];

    // #when the job runs to the end
    const done = await drive(move.id, async () => {
      seen.push({
        quotes: (await returnQuotes(db, company)).length,
        live: (await liveReturns()).length,
      });
    });

    // #then three even parts, each within the cap, never two live at once
    const quotes = await returnQuotes(db, company);
    expect({
      parts: quotes.map((quote) => quote.amountIn),
      neverTwoLive: seen.every((round) => round.live <= 1),
      withdrawals: (await withdrawals()).map((action) => [
        action.rawAmount,
        action.deliveredUsdc,
        action.status,
      ]),
      earnCalls: privy.state.earnCalls.map((call) => call.kind),
    }).toEqual({
      parts: [23_333_334n, 23_333_333n, 23_333_333n],
      neverTwoLive: true,
      withdrawals: [[IN_VAULT, IN_VAULT, "succeeded"]],
      earnCalls: ["withdraw"],
    });
    expect(quotes.every((quote) => quote.amountIn <= 30n * USDC)).toBe(true);

    // #then the move is completed for what the watcher credited, with the
    // cost the difference, and the ledger equals the chain
    const arrived = quotes.reduce((sum, quote) => sum + quote.amountOut, 0n);
    expect({
      status: done.status,
      moved: done.movedUsdc,
      cost: done.costUsdc,
      failure: done.failure,
      vault: inVault(),
      treasuryWallet: treasuryWalletUsdc(company),
      ledger: await ledger(),
      credits: (await readLedger(db, company))
        .filter((row) => row.type === "from_treasury")
        .map((row) => [row.usdcAmount, row.treasuryMoveId]),
      audit: await auditActions(),
    }).toEqual({
      status: "completed",
      moved: arrived,
      cost: IN_VAULT - arrived,
      failure: null,
      vault: 0n,
      treasuryWallet: 0n,
      ledger: 100n * USDC + arrived,
      credits: quotes.map((quote) => [quote.amountOut, move.id]),
      audit: ["treasury_move.started", "treasury_move.completed"],
    });
    await expectReconciled();
  });

  it("quotes EXACT_INPUT from Base to NEAR, recipient the company wallet, refund to the Treasury wallet", async () => {
    // #given a started move
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when the withdrawal and the quote have happened
    for (let i = 0; i < 4; i += 1) await step(move.id);

    // #then
    const [quote] = await returnQuotes(db, company);
    const request = oneClick.state.quoteRequests.at(-1);
    expect({
      purpose: quote?.purpose,
      swapType: quote?.swapType,
      recipient: quote?.recipient,
      refundTo: quote?.refundTo,
      move: quote?.treasuryMoveId,
      feeCover: quote?.feeCoverUsdc,
      requestRecipient: request?.recipient,
      requestRefund: request?.refundTo,
      deposits: quote?.depositAddress.startsWith("0x"),
    }).toEqual({
      purpose: "from_treasury",
      swapType: "EXACT_INPUT",
      recipient: company.accountId,
      refundTo: company.treasuryAddress,
      move: move.id,
      feeCover: null,
      requestRecipient: company.accountId,
      requestRefund: company.treasuryAddress,
      deposits: true,
    });
  });

  it("pays each part from the Treasury wallet through Privy, keyed per quote", async () => {
    // #given a move that has quoted and sent one part
    const move = await startMoveToWallet(world, company, 50n * USDC);
    for (let i = 0; i < 8 && privy.state.sends.length < 1; i += 1) {
      await step(move.id);
    }

    // #then
    const quotes = await returnQuotes(db, company);
    expect(
      privy.state.sends.map((send) => [
        send.privyWalletId,
        send.to,
        send.amount,
        send.idempotencyKey,
      ]),
    ).toEqual(
      quotes
        .filter((quote) => quote.depositTxHash !== null)
        .map((quote) => [
          company.treasuryPrivyWalletId,
          quote.depositAddress,
          quote.amountIn,
          `treasury-return-${quote.id}`,
        ]),
    );
  });

  it("withdraws what the vault is worth when the move was for all, which can have grown since", async () => {
    // #given a move for all, and the position growing after it was started
    const move = await startMoveToWallet(world, company, "all");
    expect({ requested: move.requestedUsdc, isAll: move.isAll }).toEqual({
      requested: IN_VAULT,
      isAll: true,
    });
    fundVault(world, company, IN_VAULT + 123_456n);

    // #when
    const done = await drive(move.id);

    // #then it asked for what the vault held then, and left nothing but
    // dust (here none) behind
    const [withdrawal] = await withdrawals();
    expect({
      status: done.status,
      asked: withdrawal?.rawAmount,
      left: inVault(),
      calls: privy.state.earnCalls.map((call) => call.rawAmount),
    }).toEqual({
      status: "completed",
      asked: IN_VAULT + 123_456n,
      left: 0n,
      calls: [IN_VAULT + 123_456n],
    });
    await expectReconciled(123_456n);
  });

  it("sends back what arrived when the vault fills the withdrawal in part, and tells every admin", async () => {
    // #given a vault that can only give 50 of the 70 asked
    privy.state.nextWithdrawalFills(50n * USDC);
    const move = await startMoveToWallet(world, company, 70n * USDC);

    // #when
    const done = await drive(move.id);

    // #then the move completes for the smaller amount, the rest stays in the vault
    const quotes = await returnQuotes(db, company);
    const arrived = quotes.reduce((sum, quote) => sum + quote.amountOut, 0n);
    expect({
      status: done.status,
      sentBack: quotes
        .filter((quote) => quote.status === "succeeded")
        .reduce((sum, quote) => sum + quote.amountIn, 0n),
      moved: done.movedUsdc,
      cost: done.costUsdc,
      vault: inVault(),
      messages: (await treasuryMessages())
        .map((row) => [row.kind, row.channel, row.audience, row.title])
        .sort(),
    }).toEqual({
      status: "completed",
      sentBack: 50n * USDC,
      moved: arrived,
      cost: 50n * USDC - arrived,
      vault: 20n * USDC,
      messages: [
        [
          "treasury_move_ended",
          "email",
          "admins",
          "Move to your wallet only partly done",
        ],
        [
          "treasury_move_ended",
          "push",
          "admins",
          "Move to your wallet only partly done",
        ],
      ],
    });
    const [partly] = (
      await owner.query<{ after: { partlyFilled?: boolean } }>(
        "SELECT after FROM audit_log WHERE organization_id = $1 AND action = 'treasury_move.completed'",
        [company.tenant.organizationId],
      )
    ).rows;
    expect(partly?.after.partlyFilled).toBe(true);
    await expectReconciled();
  });

  it("never sends back or credits USDC a stranger put in the Treasury wallet", async () => {
    // #given 9 USDC from a stranger already in the Treasury wallet, and more
    // arriving while the move runs
    setBaseBalance(world, company.treasuryAddress, 9n * USDC);
    const move = await startMoveToWallet(world, company, 40n * USDC);
    await step(move.id);
    await step(move.id);
    setBaseBalance(
      world,
      company.treasuryAddress,
      treasuryWalletUsdc(company) + 5n * USDC,
    );

    // #when the move runs to the end
    const done = await drive(move.id);

    // #then the 14 USDC a stranger sent is still there, and only what the
    // withdrawal delivered was sent back and credited
    const quotes = await returnQuotes(db, company);
    expect({
      status: done.status,
      sentBack: quotes.reduce((sum, quote) => sum + quote.amountIn, 0n),
      stillThere: treasuryWalletUsdc(company),
      credited: (await readLedger(db, company))
        .filter((row) => row.type === "from_treasury")
        .reduce((sum, row) => sum + row.usdcAmount, 0n),
    }).toEqual({
      status: "completed",
      sentBack: 40n * USDC,
      stillThere: 14n * USDC,
      credited: 40n * USDC - 2n * COST,
    });
    await expectReconciled(14n * USDC);
  });

  it("counts only the transfers to the Treasury wallet in the withdrawal's own transaction, and never more than was asked", async () => {
    // #given the withdrawal's transaction also carrying a transfer to someone
    // else, and one more to the Treasury wallet from a stranger
    alsoInNextWithdrawal(
      { from: randomAddress(), to: randomAddress(), amount: 99n * USDC },
      { from: randomAddress(), to: company.treasuryAddress, amount: 5n * USDC },
    );
    setBaseBalance(world, company.treasuryAddress, 5n * USDC);
    const move = await startMoveToWallet(world, company, 40n * USDC);

    // #when
    const done = await drive(move.id);

    // #then the Treasury wallet's transfers counted 45, capped at the 40 asked
    const [withdrawal] = await withdrawals();
    expect({
      status: done.status,
      delivered: withdrawal?.deliveredUsdc,
    }).toEqual({ status: "completed", delivered: 40n * USDC });
  });

  it("stays open, and tells nobody it is stuck, while the withdrawal's transaction hasn't shown on Base", async () => {
    // #given a succeeded withdrawal whose receipt isn't there yet
    const move = await startMoveToWallet(world, company, 20n * USDC);
    await step(move.id);
    await step(move.id);
    const [action] = await withdrawals();
    const receipt = base.state.receipts.get(action?.txHash ?? "");
    base.state.receipts.delete(action?.txHash ?? "");

    // #when the job runs
    const waiting = await advance(move.id);

    // #then it waits, sends nothing, and reads the delivery once the receipt shows
    expect({
      status: waiting?.status,
      sends: privy.state.sends.length,
    }).toEqual({ status: "open", sends: 0 });
    if (receipt) base.state.receipts.set(action?.txHash ?? "", receipt);
    expect((await drive(move.id)).status).toBe("completed");
  });

  it("goes to review when the receipt never shows, shows a revert, or shows no USDC for the wallet", async () => {
    for (const fault of ["missing", "reverted", "nothing"] as const) {
      // #given a succeeded withdrawal whose receipt is wrong
      company = await createTreasuryCompany(world, db, {
        balance: 100n * USDC,
        perTransactionMaxUsdc: 30n * USDC,
      });
      fundVault(world, company, IN_VAULT);
      const move = await startMoveToWallet(world, company, 20n * USDC);
      await step(move.id);
      await step(move.id);
      const [action] = await withdrawals();
      const hash = action?.txHash ?? "";
      const receipt = base.state.receipts.get(hash);
      if (fault === "missing") base.state.receipts.delete(hash);
      if (fault === "reverted" && receipt) {
        base.state.receipts.set(hash, { ...receipt, status: "0x0" });
      }
      if (fault === "nothing" && receipt) {
        base.state.receipts.set(hash, { ...receipt, logs: [] });
      }
      await ageEarnActions("settledAt", 31);

      // #when
      const reviewed = await advance(move.id);

      // #then nothing is sent and the move waits for a person
      expect({
        fault,
        status: reviewed?.status,
        sends: (await returnQuotes(db, company)).length,
      }).toEqual({ fault, status: "needs_review", sends: 0 });
    }
  });
});

describe("a return part 1Click refunds", () => {
  it("waits 30 minutes, then takes a new quote for what is still owed, and never sends more than the withdrawal delivered", async () => {
    // #given a 40 USDC move in two parts, the first refunded back to the Treasury wallet
    const move = await startMoveToWallet(world, company, 40n * USDC);
    await drive(move.id, () => Promise.resolve(), {
      outcome: "refund",
      rounds: 4,
    }).catch(() => undefined);
    const [refunded] = await returnQuotes(db, company);
    expect(refunded?.status).toBe("refunded");

    // #when the job runs before the wait is over
    await advance(move.id);
    await advance(move.id);

    // #then no new quote and nothing sent
    expect({
      quotes: (await returnQuotes(db, company)).length,
      sends: privy.state.sends.length,
      status: (await readMove(db, company, move.id)).status,
    }).toEqual({ quotes: 1, sends: 1, status: "open" });

    // #when the wait is over and 1Click delivers what is sent from now on
    await updateQuote(db, company.company, refunded?.id ?? "", {
      settledAt: new Date(Date.now() - 31 * 60_000),
    });
    const done = await drive(move.id);

    // #then every part is for what is owed: 40 across the quotes that weren't refunded
    const quotes = await returnQuotes(db, company);
    const sentBack = quotes
      .filter((quote) => quote.status === "succeeded")
      .reduce((sum, quote) => sum + quote.amountIn, 0n);
    expect({
      status: done.status,
      sentBack,
      statuses: quotes.map((quote) => quote.status),
      refundedAmount: refunded?.amountIn,
      credited: done.movedUsdc,
    }).toEqual({
      status: "completed",
      sentBack: 40n * USDC,
      statuses: ["refunded", "succeeded", "succeeded"],
      refundedAmount: 20n * USDC,
      credited: 40n * USDC - 2n * COST,
    });
    expect(treasuryWalletUsdc(company)).toBe(0n);
    await expectReconciled();
  });

  it("goes to review after five refunded parts rather than trying for ever", async () => {
    // #given a move whose parts keep being refunded
    const move = await startMoveToWallet(world, company, 20n * USDC);
    let status = "open";
    for (let attempt = 0; attempt < 6 && status === "open"; attempt += 1) {
      await drive(move.id, () => Promise.resolve(), {
        outcome: "refund",
        rounds: 3,
      }).catch(() => undefined);
      for (const quote of await returnQuotes(db, company)) {
        if (quote.status === "refunded") {
          await updateQuote(db, company.company, quote.id, {
            settledAt: new Date(Date.now() - 31 * 60_000),
          });
        }
      }
      status = (await readMove(db, company, move.id)).status;
    }

    // #then
    expect({
      status,
      quotes: (await returnQuotes(db, company)).length,
      stillThere: treasuryWalletUsdc(company),
    }).toEqual({ status: "needs_review", quotes: 5, stillThere: 20n * USDC });
  });
});

describe("the Privy withdrawal", () => {
  it.each(["rejected", "failed", "refused"] as const)(
    "ends the move failed when it is %s, tells every admin, and lets them try again",
    async (outcome) => {
      // #given
      privy.state.nextEarnCalls(outcome);
      const move = await startMoveToWallet(world, company, 20n * USDC);

      // #when
      const done = await drive(move.id);

      // #then nothing moved and the vault still holds everything
      expect({
        status: done.status,
        moved: done.movedUsdc,
        cost: done.costUsdc,
        quotes: (await returnQuotes(db, company)).length,
        vault: inVault(),
        messages: (await treasuryMessages())
          .map((row) => [row.channel, row.title])
          .sort(),
      }).toEqual({
        status: "failed",
        moved: 0n,
        cost: 0n,
        quotes: 0,
        vault: IN_VAULT,
        messages: [
          ["email", "Move to your wallet failed"],
          ["push", "Move to your wallet failed"],
        ],
      });

      // #then a new move can be started and completes
      const again = await startMoveToWallet(world, company, 20n * USDC);
      expect((await drive(again.id)).status).toBe("completed");
      await expectReconciled();
    },
  );

  it("is called once and with one reference when its answer is lost, then polled until it settles", async () => {
    // #given a call whose reply was lost
    privy.state.nextEarnCalls("unknown");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    await step(move.id);
    await step(move.id);
    const [saved] = await withdrawals();
    expect(saved?.status).toBe("saved");

    // #when the job runs again before Privy settles it
    await advance(move.id);
    await advance(move.id);
    const [pending] = await withdrawals();
    privy.state.settleEarnAction(
      privy.state.actionIdFor(saved?.referenceId ?? "") ?? "",
      "succeeded",
    );
    const done = await drive(move.id);

    // #then one row, one reference, one call
    expect({
      rows: (await withdrawals()).length,
      pending: pending?.status,
      calls: privy.state.earnCalls.length,
      references: new Set(privy.state.earnCalls.map((c) => c.referenceId)).size,
      status: done.status,
    }).toEqual({
      rows: 1,
      pending: "pending",
      calls: 1,
      references: 1,
      status: "completed",
    });
    await expectReconciled();
  });

  it("goes to review rather than repeat a call that was never confirmed for an hour", async () => {
    // #given an unanswered call, an hour old
    privy.state.nextEarnCalls("unknown");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    await step(move.id);
    await step(move.id);
    await ageEarnActions("callStartedAt", 61);

    // #when
    const reviewed = await advance(move.id);

    // #then
    expect({
      status: reviewed?.status,
      calls: privy.state.earnCalls.length,
    }).toEqual({ status: "needs_review", calls: 1 });
  });

  it("keeps polling a pending withdrawal and never calls Privy again", async () => {
    // #given a pending withdrawal
    privy.state.nextEarnCalls("pending");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let i = 0; i < 6; i += 1) await step(move.id);

    // #then
    expect({
      calls: privy.state.earnCalls.length,
      status: (await readMove(db, company, move.id)).status,
      action: (await withdrawals())[0]?.status,
    }).toEqual({ calls: 1, status: "open", action: "pending" });

    // #when it settles
    privy.state.settleEarnAction(
      privy.state.actionIdFor((await withdrawals())[0]?.referenceId ?? "") ??
        "",
      "succeeded",
    );

    // #then the move goes on without a second call
    expect((await drive(move.id)).status).toBe("completed");
    expect(privy.state.earnCalls.length).toBe(1);
  });
});

describe("killing the job and starting it again", () => {
  it("never withdraws or sends twice when every step runs twice", async () => {
    // #given a three-part move
    const move = await startMoveToWallet(world, company, 70n * USDC);

    // #when each step runs twice before 1Click or the watcher gets a turn
    let done = await readMove(db, company, move.id);
    for (let round = 0; round < 80 && done.status === "open"; round += 1) {
      await step(move.id);
      await step(move.id);
      await settleSentReturns(world, db, company, settled);
      await creditDeliveries(world, db, company, credited);
      done = await readMove(db, company, move.id);
    }

    // #then one withdrawal, one send and one credit per part
    const quotes = await returnQuotes(db, company);
    expect({
      status: done.status,
      withdrawals: privy.state.earnCalls.length,
      sends: privy.state.sends.length,
      quotes: quotes.length,
      credits: (await readLedger(db, company)).filter(
        (row) => row.type === "from_treasury",
      ).length,
    }).toEqual({
      status: "completed",
      withdrawals: 1,
      sends: 3,
      quotes: 3,
      credits: 3,
    });
    await expectReconciled();
  });

  it("never withdraws or sends twice when two runs overlap at every step", async () => {
    // #given a two-part move
    const move = await startMoveToWallet(world, company, 50n * USDC);

    // #when two runs race at every step
    let done = await readMove(db, company, move.id);
    for (let round = 0; round < 80 && done.status === "open"; round += 1) {
      await Promise.all([step(move.id), step(move.id)]);
      await settleSentReturns(world, db, company, settled);
      await creditDeliveries(world, db, company, credited);
      done = await readMove(db, company, move.id);
    }

    // #then
    expect({
      status: done.status,
      withdrawals: privy.state.earnCalls.length,
      sends: privy.state.sends.length,
      quotes: (await returnQuotes(db, company)).length,
    }).toEqual({ status: "completed", withdrawals: 1, sends: 2, quotes: 2 });
    await expectReconciled();
  });

  it("never sends again when a part's send was started and its outcome was lost", async () => {
    // #given Privy losing the answer to the Treasury wallet's send
    privy.state.nextSends("unknown");
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when the job runs many times
    for (let i = 0; i < 12; i += 1) await step(move.id);

    // #then one send was made, the quote and the move wait for a person
    const [quote] = await returnQuotes(db, company);
    expect({
      sends: privy.state.sends.length,
      quote: quote?.status,
      move: (await readMove(db, company, move.id)).status,
      quotes: (await returnQuotes(db, company)).length,
      stillThere: treasuryWalletUsdc(company),
    }).toEqual({
      sends: 1,
      quote: "needs_review",
      move: "needs_review",
      quotes: 1,
      stillThere: 20n * USDC,
    });
  });

  it("never sends when a run stopped between recording the send's start and saving its outcome", async () => {
    // #given a quote whose send was recorded as started and then the run died
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let i = 0; i < 4; i += 1) await step(move.id);
    const [quote] = await returnQuotes(db, company);
    await updateQuote(db, company.company, quote?.id ?? "", {
      status: "depositing",
      depositStartedAt: new Date(),
    });
    privy.state.sends.length = 0;

    // #when the job runs
    for (let i = 0; i < 4; i += 1) await step(move.id);

    // #then
    expect({
      sends: privy.state.sends.length,
      move: (await readMove(db, company, move.id)).status,
    }).toEqual({ sends: 0, move: "needs_review" });
  });
});

describe("when a part of a move to the wallet can't go", () => {
  it("goes to review, with the USDC still in the Treasury wallet, when no quote can be had", async () => {
    // #given 1Click refusing every quote
    oneClick.state.failNextQuotes("refused");
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when
    const done = await drive(move.id);

    // #then
    expect({
      status: done.status,
      holds: treasuryWalletUsdc(company),
      sends: privy.state.sends.length,
    }).toEqual({ status: "needs_review", holds: 20n * USDC, sends: 0 });
  });

  it("retries a quote 1Click can't answer, then goes to review", async () => {
    // #given 1Click not answering
    oneClick.state.failNextQuotes("unknown", "unknown");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let i = 0; i < 3; i += 1) await step(move.id);
    const waiting = await step(move.id);
    expect(waiting.move?.status).toBe("open");

    // #when the outage outlasts five minutes
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + 10 * 60_000 });
    try {
      oneClick.state.failNextQuotes("unknown");
      const done = await advance(move.id);

      // #then
      expect(done?.status).toBe("needs_review");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes a new quote when one expires before its send starts, without paying the old one", async () => {
    // #given a quote about to run out
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let i = 0; i < 4; i += 1) await step(move.id);
    const [first] = await returnQuotes(db, company);
    await updateQuote(db, company.company, first?.id ?? "", {
      deadline: new Date(Date.now() + 60_000),
    });

    // #when
    const done = await drive(move.id);

    // #then
    const quotes = await returnQuotes(db, company);
    expect({
      status: done.status,
      statuses: quotes.map((quote) => quote.status),
      sends: privy.state.sends.length,
      oldPaid: privy.state.sends.some((s) => s.to === first?.depositAddress),
    }).toEqual({
      status: "completed",
      statuses: ["expired", "succeeded"],
      sends: 1,
      oldPaid: false,
    });
  });

  it("never pays a quote whose recipient isn't the company wallet it has now", async () => {
    // #given a saved quote, then the company wallet's row changing under it
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let i = 0; i < 4; i += 1) await step(move.id);
    const [quote] = await returnQuotes(db, company);
    expect(quote?.status).toBe("quoted");
    await updateQuote(db, company.company, quote?.id ?? "", {
      recipient: randomAddress(),
    });

    // #when
    await advance(move.id);

    // #then the quote was expired unused, nothing was sent to it, and the
    // move took a fresh quote for the same part
    const [after, fresh] = await returnQuotes(db, company);
    expect({
      quote: after?.status,
      sentToIt: privy.state.sends.some(
        (send) => send.to === quote?.depositAddress,
      ),
      failure: after?.failure,
      freshRecipient: fresh?.recipient,
    }).toEqual({
      quote: "expired",
      sentToIt: false,
      failure: expect.stringContaining("own company wallet") as string,
      freshRecipient: company.accountId,
    });
  });

  it("goes to review without sending when Privy refuses the Treasury wallet's transfer", async () => {
    // #given
    privy.state.nextSends("policy_violation");
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when
    const done = await drive(move.id);

    // #then
    const [quote] = await returnQuotes(db, company);
    expect({
      status: done.status,
      quote: quote?.status,
      holds: treasuryWalletUsdc(company),
    }).toEqual({ status: "needs_review", quote: "failed", holds: 20n * USDC });
  });

  it("goes to review, not completed, when a delivery is never credited", async () => {
    // #given a delivered part the watcher never credits
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let round = 0; round < 12; round += 1) {
      await settleSentReturns(world, db, company, settled);
      await advance(move.id);
    }
    const [quote] = await returnQuotes(db, company);
    expect(quote?.status).toBe("succeeded");
    expect((await readMove(db, company, move.id)).status).toBe("open");

    // #when half an hour passes
    await updateQuote(db, company.company, quote?.id ?? "", {
      settledAt: new Date(Date.now() - 31 * 60_000),
    });
    const done = await advance(move.id);

    // #then
    expect(done?.status).toBe("needs_review");
  });

  it("still finishes when the company is paused after the move started", async () => {
    // #given
    const move = await startMoveToWallet(world, company, 20n * USDC);
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

describe("starting a move to the wallet", () => {
  const tenantAs = (role: Tenant["role"]): Tenant => ({
    ...company.tenant,
    role,
  });

  const confirmed = async (
    target: TreasuryCompany,
    amountUsdc: bigint | "all",
    confirmedFor: bigint | "all" = amountUsdc,
  ) => {
    const challenge = await runtime.runPromise(
      startApproval({
        organizationId: target.tenant.organizationId,
        userId: target.tenant.userId,
        purpose: "move_to_wallet",
        intentHash: treasuryMoveIntentHash(target.tenant.organizationId, {
          direction: "to_wallet",
          amountUsdc: confirmedFor,
        }),
      }),
    );
    return {
      direction: "to_wallet" as const,
      amountUsdc,
      challengeId: challenge.challengeId,
      response: target.passkey.sign(challenge.options, TEST_ORIGIN),
    };
  };

  const refusal = async (
    amountUsdc: bigint | "all",
    target: TreasuryCompany = company,
    tenant: Tenant = target.tenant,
  ) =>
    failureOf(
      await runtime.runPromiseExit(
        startTreasuryMove(tenant, await confirmed(target, amountUsdc)),
      ),
    );

  it("saves the move open with its approval, audits it, and reserves nothing", async () => {
    // #when
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #then
    expect({
      status: move.status,
      direction: move.direction,
      requested: move.requestedUsdc,
      isAll: move.isAll,
      confirmedBy: move.confirmedBy,
      ledger: await ledger(),
      audit: await auditActions(),
    }).toEqual({
      status: "open",
      direction: "to_wallet",
      requested: 20n * USDC,
      isAll: false,
      confirmedBy: company.tenant.userId,
      ledger: 100n * USDC,
      audit: ["treasury_move.started"],
    });
  });

  it("is for admins only", async () => {
    // #then
    for (const role of ["accountant", "employee"] as const) {
      expect(await refusal(20n * USDC, company, tenantAs(role))).toBe(
        "Forbidden",
      );
    }
  });

  it("refuses when Treasury isn't turned on", async () => {
    // #given a company with a wallet and no Treasury
    const paying = await createNearPayingCompany(world, db, {});
    const tenant: Tenant = {
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      membershipId: paying.company.adminMembershipId,
      role: "admin",
    };
    const exit = await runtime.runPromiseExit(
      startMoveConfirmation(tenant, {
        direction: "to_wallet",
        amountUsdc: 20n * USDC,
      }),
    );

    // #then
    expect(failureOf(exit)).toBe("Conflict");
  });

  it("refuses when the company is paused", async () => {
    // #given
    const start = await confirmed(company, 20n * USDC);
    await runInScope(db, scope(), (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, company.tenant.organizationId)),
    );

    // #then
    expect(
      failureOf(
        await runtime.runPromiseExit(startTreasuryMove(company.tenant, start)),
      ),
    ).toBe("Conflict");
  });

  it("refuses under 10 USDC, accepts exactly 10 and accepts all of a smaller position", async () => {
    // #then
    expect(await refusal(9n * USDC)).toBe("BadRequest");
    const ten = await startMoveToWallet(world, company, 10n * USDC);
    expect(ten.status).toBe("open");
    const small = await createTreasuryCompany(world, db, {
      balance: 100n * USDC,
    });
    fundVault(world, small, 3n * USDC);
    const all = await startMoveToWallet(world, small, "all");
    expect({ requested: all.requestedUsdc, isAll: all.isAll }).toEqual({
      requested: 3n * USDC,
      isAll: true,
    });
  });

  it("refuses more than Treasury is worth now, read live", async () => {
    // #then
    expect(await refusal(IN_VAULT + 1n)).toBe("Conflict");
    fundVault(world, company, 5n * USDC);
    expect(await refusal(IN_VAULT)).toBe("Conflict");
  });

  it("refuses all when Treasury holds nothing", async () => {
    // #given
    fundVault(world, company, 0n);

    // #then
    expect(await refusal("all")).toBe("Conflict");
  });

  it("refuses a move to Treasury for all", async () => {
    // #then
    const exit = await runtime.runPromiseExit(
      startMoveConfirmation(company.tenant, {
        direction: "to_treasury",
        amountUsdc: "all",
      }),
    );
    expect(failureOf(exit)).toBe("BadRequest");
  });

  it("says so, and spends no passkey, when Privy can't be asked what Treasury is worth", async () => {
    // #given
    privy.state.failNext("vaultPosition");

    // #then
    const exit = await runtime.runPromiseExit(
      startMoveConfirmation(company.tenant, {
        direction: "to_wallet",
        amountUsdc: 20n * USDC,
      }),
    );
    expect(failureOf(exit)).toBe("ServiceUnavailable");
  });

  it("refuses a second open move, whatever its direction", async () => {
    // #given an open move to Treasury
    await startMove(world, company, 20n * USDC);

    // #then
    expect(await refusal(20n * USDC)).toBe("Conflict");
  });

  it("refuses a confirmation made for another amount, or for all", async () => {
    // #then
    for (const [asked, confirmedFor] of [
      [30n * USDC, 20n * USDC],
      [IN_VAULT, "all"],
      ["all", IN_VAULT],
    ] as const) {
      const exit = await runtime.runPromiseExit(
        startTreasuryMove(
          company.tenant,
          await confirmed(company, asked, confirmedFor),
        ),
      );
      expect(failureOf(exit)).toBe("Forbidden");
    }
  });

  it("doesn't count against the daily cap", async () => {
    // #given a company whose daily cap is far below the move
    await runInScope(db, scope(), (tx) =>
      tx
        .update(organizations)
        .set({ dailyPayoutCapKes: 100n })
        .where(eq(organizations.id, company.tenant.organizationId)),
    );

    // #when
    const move = await startMoveToWallet(world, company, 50n * USDC);

    // #then
    expect(move.status).toBe("open");
  });

  it("previews the parts, cost and time without saving anything, and for all shows what Treasury is worth", async () => {
    oneClick.state.quoteRequests.length = 0;

    // #when
    const preview = await runtime.runPromise(
      previewTreasuryMove(company.tenant, {
        direction: "to_wallet",
        amountUsdc: 70n * USDC,
      }),
    );
    const all = await runtime.runPromise(
      previewTreasuryMove(company.tenant, {
        direction: "to_wallet",
        amountUsdc: "all",
      }),
    );

    // #then
    expect({
      parts: preview.parts,
      perPart: preview.perPartMaxUsdc,
      cost: preview.estimatedCostUsdc,
      slow: preview.estimatedSeconds > 60,
      inTreasury: preview.inTreasuryUsdc,
      allAmount: all.amountUsdc,
      isAll: all.isAll,
    }).toEqual({
      parts: 3,
      perPart: (30n * USDC).toString(),
      cost: (3n * COST).toString(),
      slow: true,
      inTreasury: IN_VAULT.toString(),
      allAmount: IN_VAULT.toString(),
      isAll: true,
    });
    expect(await auditActions()).toEqual([]);
    expect(await returnQuotes(db, company)).toEqual([]);
    expect(oneClick.state.quoteRequests.every((r) => r.dry)).toBe(true);
  });
});

describe("sending back a stranded vault deposit", () => {
  /** A move to Treasury whose vault deposit Privy rejected until it went to review. */
  async function strandedMove() {
    privy.state.nextEarnCalls("rejected", "rejected", "rejected");
    const move = await startMove(world, company, 20n * USDC);
    const reviewed = await driveToTreasury(move.id);
    expect(reviewed.status).toBe("needs_review");
    return move;
  }
  const actor = { type: "system", id: "staff-test" } as const;
  const sendBack = (moveId: string) =>
    runtime.runPromise(returnStrandedDeposit({ ...scope(), moveId, actor }));

  it("sends exactly that move's undeposited USDC to the company wallet and settles the move returned", async () => {
    // #given a stranded move, and 6 USDC of a stranger's in the Treasury wallet too
    const move = await strandedMove();
    const [quote] = await treasuryQuotes(db, company);
    const stranded = quote?.swappedAmountOut ?? 0n;
    expect(treasuryWalletUsdc(company)).toBe(stranded);
    setBaseBalance(world, company.treasuryAddress, stranded + 6n * USDC);

    // #when staff send it back and the job runs
    const started = await sendBack(move.id);
    const done = await drive(move.id);

    // #then the part went back, the stranger's USDC stayed, the move is returned
    const [back] = await returnQuotes(db, company);
    expect({
      amount: started.amountUsdc,
      status: done.status,
      sent: back?.amountIn,
      stillThere: treasuryWalletUsdc(company),
      moved: done.movedUsdc,
      cost: done.costUsdc,
      ledger: await ledger(),
      chain: nearBalance(),
      audit: await auditActions(),
    }).toEqual({
      amount: stranded,
      status: "returned",
      sent: stranded,
      stillThere: 6n * USDC,
      moved: 0n,
      cost: 20n * USDC - (stranded - COST),
      ledger: 80n * USDC + stranded - COST,
      chain: 80n * USDC + stranded - COST,
      audit: [
        "treasury_move.started",
        "treasury_move.needs_review",
        "treasury_move.return_started",
        "treasury_move.returned",
      ],
    });
  });

  it("is safe to ask twice: one quote, one send", async () => {
    // #given
    const move = await strandedMove();

    // #when
    const first = await sendBack(move.id);
    const second = await sendBack(move.id);
    await drive(move.id);

    // #then
    expect({
      same: first.quoteId === second.quoteId,
      quotes: (await returnQuotes(db, company)).length,
      sends: privy.state.sends.length,
    }).toEqual({ same: true, quotes: 1, sends: 1 });
  });

  it("is refused for a move that isn't waiting for review", async () => {
    // #given an open move, and one that completed
    const open = await startMove(world, company, 20n * USDC);
    const exit = await runtime.runPromiseExit(
      returnStrandedDeposit({ ...scope(), moveId: open.id, actor }),
    );

    // #then
    expect(failureOf(exit)).toBe("Conflict");
  });

  it("is refused while a deposit may still be in flight", async () => {
    // #given a move in review because its deposit's outcome is unclear
    privy.state.nextEarnCalls("unknown");
    const move = await startMove(world, company, 20n * USDC);
    for (let i = 0; i < 30 && privy.state.earnCalls.length === 0; i += 1) {
      await deliverSentParts(world, db, company, delivered);
      await step(move.id);
    }
    await ageEarnActions("callStartedAt", 61);
    await advance(move.id);
    expect((await readMove(db, company, move.id)).status).toBe("needs_review");

    // #then
    const exit = await runtime.runPromiseExit(
      returnStrandedDeposit({ ...scope(), moveId: move.id, actor }),
    );
    expect(failureOf(exit)).toBe("Conflict");
  });

  it("is refused for a move to the wallet", async () => {
    // #given
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #then
    const exit = await runtime.runPromiseExit(
      returnStrandedDeposit({ ...scope(), moveId: move.id, actor }),
    );
    expect(failureOf(exit)).toBe("BadRequest");
  });
});

describe("the Earn actions table", () => {
  it("allows one withdrawal per move, whatever became of it", async () => {
    // #given a move whose withdrawal was rejected
    privy.state.nextEarnCalls("rejected");
    const move = await startMoveToWallet(world, company, 20n * USDC);
    await drive(move.id);

    // #then a second withdrawal row for the same move is refused
    const second = await runInScope(db, scope(), (tx) =>
      tx.insert(treasuryEarnActions).values({
        organizationId: company.tenant.organizationId,
        treasuryMoveId: move.id,
        kind: "withdraw",
        referenceId: "tr-second-withdrawal",
        rawAmount: USDC,
      }),
    ).then(
      () => "inserted",
      (error: { cause?: unknown }) => violatedUniqueConstraint(error.cause),
    );
    expect(second).toBe("treasury_earn_actions_one_withdrawal_per_move");
    expect(await withdrawals()).toHaveLength(1);
  });
});
