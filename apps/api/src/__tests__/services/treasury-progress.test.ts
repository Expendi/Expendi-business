import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { TreasuryProgress } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { stepTreasuryMove } from "../../services/treasury/advance.js";
import { getTreasuryStatus } from "../../services/treasury/figures.js";
import { listTreasuryMoves } from "../../services/treasury/moves.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import { randomNearTxHash } from "../helpers/near.js";
import {
  createTreasuryCompany,
  creditDeliveries,
  deliverSentParts,
  fundVault,
  returnQuotes,
  settleSentReturns,
  startMove,
  startMoveToWallet,
  treasuryQuotes,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";

const world = makeNearPayoutWorld({}, { PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy, oneClick } = world;
let db: Database;
let company: TreasuryCompany;
let delivered: Set<string>;
let settled: Set<string>;
let credited: Set<string>;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  delivered = new Set();
  settled = new Set();
  credited = new Set();
  privy.state.resetEarn();
  oneClick.state.clearQuoteFailures();
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
});

const ref = (moveId: string) => ({
  organizationId: company.tenant.organizationId,
  moveId,
});

const progressOf = async (moveId: string): Promise<TreasuryProgress> => {
  const { moves } = await runtime.runPromise(listTreasuryMoves(company.tenant));
  const progress = moves.find((move) => move.id === moveId)?.progress;
  if (!progress) throw new Error("the move has no progress");
  return progress;
};

/** "dcww": done, current, waiting, waiting. */
const letters = (progress: TreasuryProgress): string =>
  progress.steps.map((step) => step.state[0]).join("");

/**
 * Steps the move one step at a time, with 1Click and the deposit watcher
 * acting in between, and reads its progress after every step. Returns what
 * was seen, with repeats folded.
 */
async function trace(moveId: string, rounds = 120): Promise<string[]> {
  const seen: string[] = [];
  const note = async () => {
    const progress = await progressOf(moveId);
    const suffix =
      progress.part === undefined
        ? ""
        : ` ${String(progress.part)}/${String(progress.parts)}`;
    const line = `${letters(progress)}${suffix}`;
    if (seen.at(-1) !== line) seen.push(line);
  };
  await note();
  for (let round = 0; round < rounds; round += 1) {
    await deliverSentParts(world, db, company, delivered);
    await settleSentReturns(world, db, company, settled);
    await creditDeliveries(world, db, company, credited);
    const step = await runtime.runPromise(
      stepTreasuryMove(ref(moveId), { retryDelayMs: 0 }),
    );
    await note();
    if (step.move?.status !== "open") return seen;
  }
  throw new Error("the move never left open");
}

describe("progress of a move to Treasury", () => {
  it("goes leaving the wallet, on its way, arriving, then in Treasury, each step stamped when it finished", async () => {
    // #given a move that fits in one part
    const move = await startMove(world, company, 20n * USDC);

    // #when it is stepped to the end
    const seen = await trace(move.id);

    // #then no part is shown and the steps only ever move forward
    expect(seen[0]).toBe("cwww");
    expect(seen.at(-1)).toBe("dddd");
    expect(seen).toContain("dcww");
    expect(seen).toContain("ddcw");
    const finished = await progressOf(move.id);
    expect(finished.steps.map((step) => step.key)).toEqual([
      "leaving_wallet",
      "on_its_way",
      "arriving",
      "in_treasury",
    ]);
    expect(finished.steps.every((step) => step.at !== null)).toBe(true);
    expect(finished.part).toBeUndefined();
  });

  it("is leaving the wallet until the send is debited, and on its way until 1Click delivers", async () => {
    // #given a move that has only been started
    const move = await startMove(world, company, 20n * USDC);
    expect(letters(await progressOf(move.id))).toBe("cwww");

    // #when the part is quoted and sent
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));

    // #then the debit is in the ledger and 1Click hasn't delivered
    const [quote] = await treasuryQuotes(db, company);
    expect(quote?.status).toBe("depositing");
    const sent = await progressOf(move.id);
    expect(letters(sent)).toBe("dcww");
    expect(sent.steps[0]?.at).not.toBeNull();
    expect(sent.steps[1]?.at).toBeNull();
  });

  it("shows the part a split move is on, and starts the next part from the beginning", async () => {
    // #given 70 USDC through a 30 USDC cap: three parts
    const move = await startMove(world, company, 70n * USDC);

    // #when
    const seen = await trace(move.id);

    // #then each part runs the four steps, and the last is all done
    expect(seen[0]).toBe("cwww 1/3");
    expect(seen).toContain("dcww 1/3");
    expect(seen).toContain("cwww 2/3");
    expect(seen).toContain("cwww 3/3");
    expect(seen.at(-1)).toBe("dddd 3/3");
  });

  it("marks on its way as where a refunded move stopped", async () => {
    // #given a part sent and refunded by 1Click, then credited back
    const move = await startMove(world, company, 20n * USDC);
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");
    oneClick.state.setStatus(quote.depositAddress, {
      status: "REFUNDED",
      refundedAmount: quote.amountIn,
      refundReason: "deadline",
    });
    world.near.state.fundWithUsdc(company.accountId, quote.amountIn);
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    expect(letters(await progressOf(move.id))).toBe("dcww");

    // #when the refund is credited and the move ends returned
    await creditRefund(move.id, quote.id, quote.amountIn);
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));

    // #then
    const progress = await progressOf(move.id);
    expect(letters(progress)).toBe("dfww");
    expect(progress.steps[1]?.at).toBeNull();
  });

  it("marks leaving the wallet as where a move stopped when nothing could be quoted", async () => {
    // #given 1Click refusing quotes
    oneClick.state.failNextQuotes("refused");
    const move = await startMove(world, company, 20n * USDC);

    // #when
    const seen = await trace(move.id);

    // #then
    expect(seen.at(-1)).toBe("fwww");
  });

  it("marks arriving as where a move stopped when the vault rejects the deposit", async () => {
    // #given Privy rejecting every deposit
    privy.state.nextEarnCalls("rejected", "rejected", "rejected", "rejected");
    const move = await startMove(world, company, 20n * USDC);

    // #when
    const seen = await trace(move.id);

    // #then the money got across and stopped at the vault, under review
    expect(seen.at(-1)).toBe("ddfw");
  });

  it("marks on its way as where a move stopped when 1Click gives up on a sent part", async () => {
    // #given a part that was sent
    const move = await startMove(world, company, 20n * USDC);
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    const [quote] = await treasuryQuotes(db, company);
    if (!quote) throw new Error("no quote");

    // #when 1Click reports FAILED
    oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));

    // #then
    expect(letters(await progressOf(move.id))).toBe("dfww");
  });

  it("shows the open move's progress in the account, the same as the list", async () => {
    // #given a move in flight
    const move = await startMove(world, company, 20n * USDC);
    await runtime.runPromise(stepTreasuryMove(ref(move.id)));

    // #when
    const status = await runtime.runPromise(getTreasuryStatus(company.tenant));

    // #then
    if (status.status !== "on") throw new Error("Treasury isn't on");
    expect(status.openMove?.progress).toEqual(await progressOf(move.id));
  });
});

describe("progress of a move to the wallet", () => {
  beforeEach(() => {
    fundVault(world, company, 70n * USDC);
  });

  it("goes leaving Treasury, on its way, then in the wallet", async () => {
    // #given a move that fits in one part
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when
    const seen = await trace(move.id);

    // #then
    expect(seen[0]).toBe("cww");
    expect(seen).toContain("dcw");
    expect(seen.at(-1)).toBe("ddd");
    const finished = await progressOf(move.id);
    expect(finished.steps.map((step) => step.key)).toEqual([
      "leaving_treasury",
      "on_its_way",
      "in_wallet",
    ]);
    expect(finished.steps.every((step) => step.at !== null)).toBe(true);
    expect(finished.part).toBeUndefined();
  });

  it("shows the part a split return is on once the withdrawal has delivered", async () => {
    // #given all 70 USDC through a 30 USDC cap: three parts back
    const move = await startMoveToWallet(world, company, "all");

    // #when
    const seen = await trace(move.id);

    // #then no part is named before the amount is known, then each part is
    expect(seen[0]).toBe("cww");
    expect(seen).toContain("dcw 1/3");
    expect(seen).toContain("dcw 2/3");
    expect(seen).toContain("dcw 3/3");
    expect(seen.at(-1)).toBe("ddd 3/3");
  });

  it("marks leaving Treasury as where a move stopped when the withdrawal is rejected", async () => {
    // #given Privy rejecting the withdrawal
    privy.state.nextEarnCalls("rejected");
    const move = await startMoveToWallet(world, company, 20n * USDC);

    // #when
    const seen = await trace(move.id);

    // #then
    expect(seen.at(-1)).toBe("fww");
  });

  it("marks on its way as where a move stopped when 1Click gives up on a part sent back", async () => {
    // #given a move whose withdrawal has run and whose first part is sent back
    const move = await startMoveToWallet(world, company, 20n * USDC);
    for (let round = 0; round < 6; round += 1) {
      await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    }
    const [quote] = (await returnQuotes(db, company)).slice(-1);
    if (!quote) throw new Error("no return quote");

    // #when 1Click reports the part's transfer FAILED
    oneClick.state.setStatus(quote.depositAddress, { status: "FAILED" });
    for (let round = 0; round < 3; round += 1) {
      await runtime.runPromise(stepTreasuryMove(ref(move.id)));
    }

    // #then
    expect(letters(await progressOf(move.id))).toBe("dfw");
  });
});

async function creditRefund(
  moveId: string,
  quoteId: string,
  amount: bigint,
): Promise<void> {
  await runInScope(
    db,
    { organizationId: company.tenant.organizationId },
    (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: company.tenant.organizationId,
        walletId: company.wallet.id,
        type: "from_treasury",
        chain: "near",
        usdcAmount: amount,
        treasuryMoveId: moveId,
        intentQuoteId: quoteId,
        txHash: randomNearTxHash(),
        receiptId: randomNearTxHash(),
        logIndex: 0,
        transferIndex: 0,
      }),
  );
}
