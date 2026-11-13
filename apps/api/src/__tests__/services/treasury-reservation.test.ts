import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { runInScope } from "../../db/scope.js";
import { availableUsdc } from "../../services/wallet/ledger.js";
import {
  addLedgerRow,
  createFundedCompany,
  saveQuote,
  saveTreasuryMove,
} from "../helpers/money-in.js";
import { randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const USDC = 1_000_000n;

let runtime: AppRuntime;
let db: Database;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
  await addLedgerRow(db, funded, { type: "topup", usdcAmount: 100n * USDC });
});

afterAll(async () => {
  await runtime.dispose();
});

const available = () =>
  runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
    runtime.runPromise(availableUsdc(tx, funded.walletId)),
  );

/** What a part's send writes once the chain shows it executed. */
async function debitToTreasury(moveId: string, amount: bigint): Promise<void> {
  const quote = await saveQuote(runtime, db, funded, "to_treasury", {
    amount,
    row: { treasuryMoveId: moveId },
  });
  await addLedgerRow(db, funded, {
    type: "to_treasury",
    usdcAmount: -amount,
    treasuryMoveId: moveId,
    intentQuoteId: quote.id,
    chain: "near",
    txHash: randomNearTxHash(),
    receiptId: randomNearTxHash(),
    logIndex: 0,
    transferIndex: 0,
  });
}

describe("availableUsdc", () => {
  it("is the whole ledger balance when nothing is reserved", async () => {
    expect(await available()).toBe(100n * USDC);
  });

  it("holds back what an open move to Treasury has yet to send", async () => {
    // #given
    await saveTreasuryMove(db, funded, { requestedUsdc: 30n * USDC });

    // #then
    expect(await available()).toBe(70n * USDC);
  });

  it("holds back a move in needs_review, whose money may be about to leave", async () => {
    // #given
    await saveTreasuryMove(db, funded, {
      requestedUsdc: 30n * USDC,
      status: "needs_review",
    });

    // #then
    expect(await available()).toBe(70n * USDC);
  });

  it("holds back only the undebited remainder once a part has been sent", async () => {
    // #given a 30 USDC move of which 12 has left the wallet
    const move = await saveTreasuryMove(db, funded, {
      requestedUsdc: 30n * USDC,
    });
    await debitToTreasury(move.id, 12n * USDC);

    // #then the ledger fell by 12 and 18 is still reserved
    expect(await available()).toBe(70n * USDC);
  });

  it("stops holding anything back once every part is debited", async () => {
    // #given
    const move = await saveTreasuryMove(db, funded, {
      requestedUsdc: 30n * USDC,
    });
    await debitToTreasury(move.id, 30n * USDC);

    // #then
    expect(await available()).toBe(70n * USDC);
  });

  it("never holds back less than nothing when a move sent more than it asked", async () => {
    // #given a debit larger than the request, which the ledger allows
    const move = await saveTreasuryMove(db, funded, {
      requestedUsdc: 10n * USDC,
    });
    await debitToTreasury(move.id, 12n * USDC);

    // #then only the debit itself is gone from the balance
    expect(await available()).toBe(88n * USDC);
  });

  it.each([["completed" as const], ["returned" as const], ["failed" as const]])(
    "stops holding anything back once the move is %s",
    async (status) => {
      // #given
      await saveTreasuryMove(db, funded, {
        requestedUsdc: 30n * USDC,
        status,
        settledAt: new Date(),
      });

      // #then
      expect(await available()).toBe(100n * USDC);
    },
  );

  it("holds nothing back for a move to the wallet", async () => {
    // #given
    await saveTreasuryMove(db, funded, {
      direction: "to_wallet",
      requestedUsdc: 30n * USDC,
    });

    // #then
    expect(await available()).toBe(100n * USDC);
  });

  it("doesn't count another company's move", async () => {
    // #given
    const other = await createFundedCompany(db);
    await saveTreasuryMove(db, other, { requestedUsdc: 30n * USDC });

    // #then
    expect(await available()).toBe(100n * USDC);
  });
});
