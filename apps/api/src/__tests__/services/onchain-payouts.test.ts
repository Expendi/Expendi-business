import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { UsdcPayoutRequest } from "../../services/payout/payout-service.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../../services/allowlist/allowlist.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { fundPayout } from "../../services/payout/fund.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  makeFakePrivyWallets,
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import { followPayout } from "../helpers/near-usdc-payouts.js";
import {
  allowlistAddress,
  createPayingCompany,
  payClaims,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let paying: PayingCompany;
let payee: string;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  paying = await createPayingCompany(runtime, db);
  payee = randomAddress();
  await allowlistAddress(runtime, paying, payee, "Supplier");
});

const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function usdcBill(
  overrides: Partial<UsdcPayoutRequest> = {},
): UsdcPayoutRequest {
  return {
    subjectType: "bill",
    subjectId: randomUUID(),
    idempotencyKey: `bill:${randomUUID()}:1`,
    recipient: {
      method: "usdc",
      chain: "base",
      address: payee,
      accountName: "Acme Ltd",
    },
    amountUsdc: 25n * USDC,
    ...overrides,
  };
}

const prepare = (request: UsdcPayoutRequest) =>
  runtime.runPromiseExit(
    preparePayouts({
      organizationId: paying.company.organizationId,
      actor: { type: "user", id: paying.company.admin.id },
      requests: [request],
    }),
  );

const rejection = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) return "succeeded";
  const failure = Option.getOrNull(Cause.failureOption(exit.cause));
  return failure && typeof failure === "object" && "reason" in failure
    ? failure.reason
    : String(failure);
};

async function removeFromAllowlist(addressId: string): Promise<void> {
  const change = { action: "remove", addressId } as const;
  const challenge = await runtime.runPromise(
    requestAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      change,
    }),
  );
  await runtime.runPromise(
    confirmAllowlistChange({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: challenge.challengeId,
      response: paying.passkey.sign(challenge.options, TEST_ORIGIN),
      change,
    }),
  );
}

/**
 * A USDC payout as a company wallet on Base sent it, before NEAR became the
 * main chain: approved through the engine, then recorded as sent in
 * `txHash`. Nothing sends from Base any more, so the row is written here.
 */
async function sentFromBase(): Promise<Payout & { txHash: string }> {
  const prepared = await prepare(usdcBill());
  if (Exit.isFailure(prepared)) throw new Error("prepare failed");
  const [payout] = prepared.value;
  if (!payout) throw new Error("nothing prepared");
  const approval = await runtime.runPromise(
    requestPayoutApproval({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      payoutIds: [payout.id],
    }),
  );
  await runtime.runPromise(
    approvePayouts({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: approval.challengeId,
      response: paying.passkey.sign(approval.options, TEST_ORIGIN),
    }),
  );
  const txHash = randomTxHash();
  await updatePayout(db, paying.company, payout.id, {
    status: "paying",
    fundingStartedAt: new Date(),
    depositAddress: payee,
    amountToTransferUsdc: payout.quotedUsdc,
    txHash,
  });
  return { ...(await reload(payout)), txHash };
}

const reload = (payout: Payout) => readPayout(db, paying.company, payout.id);

describe("USDC payouts sent from a company wallet on Base before the move", () => {
  it("is marked paid once the transfer is confirmed on chain", async () => {
    // #given
    const payout = await sentFromBase();
    rpc.state.receipts.set(
      payout.txHash,
      transferReceipt(
        [{ from: paying.wallet.address, to: payee, amount: 25n * USDC }],
        { txHash: payout.txHash },
      ),
    );

    // #when
    await followPayout(runtime, payout);

    // #then
    const paid = await reload(payout);
    expect({ status: paid.status, reference: paid.providerReference }).toEqual({
      status: "paid",
      reference: payout.txHash,
    });
  });

  it("sends a reverted transfer for review", async () => {
    // #given
    const payout = await sentFromBase();
    rpc.state.receipts.set(
      payout.txHash,
      transferReceipt(
        [{ from: paying.wallet.address, to: payee, amount: 25n * USDC }],
        { txHash: payout.txHash, status: "0x0" },
      ),
    );

    // #when
    await followPayout(runtime, payout);

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("sends a transfer that moved a different amount for review", async () => {
    // #given
    const payout = await sentFromBase();
    rpc.state.receipts.set(
      payout.txHash,
      transferReceipt(
        [{ from: paying.wallet.address, to: payee, amount: 24n * USDC }],
        { txHash: payout.txHash },
      ),
    );

    // #when
    await followPayout(runtime, payout);

    // #then
    expect((await reload(payout)).status).toBe("needs_review");
  });

  it("never signs or sends anything while it is followed", async () => {
    // #given
    const payout = await sentFromBase();

    // #when
    await followPayout(runtime, payout);

    // #then
    expect({
      status: (await reload(payout)).status,
      sends: privy.state.sends.length,
    }).toEqual({ status: "paying", sends: 0 });
  });
});

describe("USDC payouts to allowlisted addresses", () => {
  it.each([
    ["a NEAR account", "near", "supplier.acme.near"],
    ["a Solana address", "solana", SOLANA_ADDRESS],
  ] as const)(
    "prepares a payout to %s with its payee chain, exactly as allowlisted",
    async (_name, chain, address) => {
      // #given
      await allowlistAddress(runtime, paying, address, "Supplier", chain);

      // #when
      const exit = await prepare(
        usdcBill({
          recipient: { method: "usdc", chain, address, accountName: "Acme" },
        }),
      );

      // #then
      if (Exit.isFailure(exit)) throw new Error("prepare failed");
      expect(exit.value[0]?.recipient).toEqual({
        method: "usdc",
        chain,
        address,
        accountName: "Acme",
      });
    },
  );

  it.each([
    ["a NEAR account with a capital letter", "near", "Supplier.near"],
    ["a Solana address in lowercase", "solana", SOLANA_ADDRESS.toLowerCase()],
    ["a NEAR account as a Base address", "base", "supplier.near"],
    [
      "a Base address as a NEAR account",
      "near",
      "0x52908400098527886e0f7030069857d2e4169ee7",
    ],
  ] as const)("can't pay %s", async (_name, chain, address) => {
    // #when
    const exit = await prepare(
      usdcBill({
        recipient: { method: "usdc", chain, address, accountName: "Acme" },
      }),
    );

    // #then
    expect(rejection(exit)).toBe("invalid_recipient");
  });

  it("can't pay an address that isn't on the allowlist", async () => {
    // #when
    const exit = await prepare(
      usdcBill({
        recipient: {
          method: "usdc",
          chain: "base",
          address: randomAddress(),
          accountName: "Stranger",
        },
      }),
    );

    // #then
    expect({
      reason: rejection(exit),
      sends: privy.state.sends.length,
    }).toEqual({ reason: "not_allowlisted", sends: 0 });
  });

  it("refuses to approve once the address was removed from the allowlist", async () => {
    // #given
    const extra = randomAddress();
    const extraId = await allowlistAddress(runtime, paying, extra);
    const prepared = await prepare(
      usdcBill({
        recipient: {
          method: "usdc",
          chain: "base",
          address: extra,
          accountName: "Soon gone",
        },
      }),
    );
    if (Exit.isFailure(prepared)) throw new Error("prepare failed");
    const [payout] = prepared.value;
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [payout?.id ?? ""],
      }),
    );
    await removeFromAllowlist(extraId);

    // #when
    const exit = await runtime.runPromiseExit(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then
    expect({
      reason: rejection(exit),
      sends: privy.state.sends.length,
    }).toEqual({ reason: "not_allowlisted", sends: 0 });
  });

  it("won't fund once the address was removed after approval", async () => {
    // #given an approved payout whose address is then removed
    const extra = randomAddress();
    const extraId = await allowlistAddress(runtime, paying, extra);
    const prepared = await prepare(
      usdcBill({
        recipient: {
          method: "usdc",
          chain: "base",
          address: extra,
          accountName: "Gone",
        },
      }),
    );
    if (Exit.isFailure(prepared)) throw new Error("prepare failed");
    const [payout] = prepared.value;
    if (!payout) throw new Error("nothing prepared");
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [payout.id],
      }),
    );
    await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );
    await removeFromAllowlist(extraId);

    // #when
    const funded = await runtime.runPromise(
      fundPayout({
        organizationId: paying.company.organizationId,
        payoutId: payout.id,
      }),
    );

    // #then
    expect({
      status: funded.status,
      sends: privy.state.sends.length,
    }).toEqual({ status: "failed", sends: 0 });
  });

  it("refuses a single payment above the wallet's per-transaction cap", async () => {
    // #when the test wallet's cap is 5,000 USDC
    const exit = await prepare(usdcBill({ amountUsdc: 5_001n * USDC }));

    // #then
    expect(rejection(exit)).toBe("over_transaction_cap");
  });

  it("credits money back from an allowlisted address as a deposit, not a refund", async () => {
    // #given a payout already went to the payee
    await payClaims(runtime, db, paying, [usdcBill()]);
    const receipt = transferReceipt([
      { from: payee, to: paying.wallet.address, amount: 3n * USDC },
    ]);
    rpc.state.receipts.set(receipt.transactionHash, receipt);

    // #when the same address later sends the company USDC
    await runtime.runPromise(
      creditUsdcDeposits([receipt.transactionHash], {
        type: "system",
        id: "alchemy-webhook",
      }),
    );

    // #then
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ type: walletTransactions.type })
          .from(walletTransactions)
          .where(eq(walletTransactions.txHash, receipt.transactionHash)),
    );
    expect(rows).toEqual([{ type: "deposit" }]);
  });
});
