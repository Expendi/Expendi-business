import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  intentQuotes,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, runInScope, withScope } from "../../db/scope.js";
import { changeBalanceHome } from "../../services/intents/balance-home.js";
import { rolloutConfidentialAccounts } from "../../services/intents/confidential-rollout.js";
import { recordedExpendiSurplus } from "../../services/intents/expendi-surplus.js";
import { startFeeCover } from "../../services/intents/fee-cover.js";
import { startMoveIn } from "../../services/intents/move-in.js";
import { moveOut } from "../../services/intents/move-out.js";
import { isPaused } from "../../services/payout/guards.js";
import { ensureCompanyWallet } from "../../services/wallet/company-wallet.js";
import {
  NEAR_INTENTS_ACCOUNT_ID,
  watchNearDeposits,
} from "../../services/wallet/near-deposits.js";
import { createCompany } from "../helpers/db.js";
import { makeFakeFastNear } from "../helpers/fast-near.js";
import { insertFundingPayout, insertOpenSend } from "../helpers/in-flight.js";
import { saveQuote } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import {
  ftTransferLog,
  nearOutcome,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const fakes = makeNearUsdcFakes();
const oneClick = makeFakeOneClick();
const fastNear = makeFakeFastNear();
let runtime: AppRuntime;
let disabled: AppRuntime;
let db: Database;
let owner: pg.Pool;
const made: string[] = [];

beforeAll(async () => {
  runtime = makeTestRuntime(
    { ...fakes.layers, oneClick: oneClick.layer, fastNear: fastNear.layer },
    { ...fakes.env, CONFIDENTIAL_ACCOUNTS_ENABLED: "true" },
  );
  disabled = makeTestRuntime(
    { ...fakes.layers, oneClick: oneClick.layer },
    { ...fakes.env, CONFIDENTIAL_ACCOUNTS_ENABLED: "false" },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  // This serial suite exercises the global candidate walker. Completed
  // suites' fixtures are not rollout candidates.
  await owner.query("UPDATE wallets SET confidential_opt_out = true");
});
beforeEach(() => {
  oneClick.state.costPerQuote = 0n;
  fakes.chain.state.balances.set(fakes.relayer.accountId, 0n);
  fakes.chain.state.fundWithUsdc(fakes.relayer.accountId, 1_000_000n * USDC);
});
afterEach(async () => {
  for (const organizationId of made.splice(0)) {
    // Disable our fixtures for later global jobs. The tests never reuse them.
    await owner.query(
      "UPDATE wallets SET confidential_opt_out = true, balance_home_changing = false, balance_home = 'company_wallet' WHERE organization_id = $1",
      [organizationId],
    );
  }
});
afterAll(async () => {
  await Promise.all([runtime.dispose(), disabled.dispose(), owner.end()]);
});

async function company(
  home: "company_wallet" | "confidential_account" = "confidential_account",
  cap = 100n * USDC,
) {
  const c = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    10n * USDC,
    cap,
    home,
  );
  made.push(c.company.organizationId);
  return c;
}
const scopeOf = (c: NearUsdcPayingCompany) => ({
  organizationId: c.company.organizationId,
});
const readWallet = async (c: NearUsdcPayingCompany) =>
  (
    await runInScope(db, scopeOf(c), (tx) =>
      tx.select().from(wallets).where(eq(wallets.id, c.wallet.id)),
    )
  )[0];
const quotes = (c: NearUsdcPayingCompany) =>
  runInScope(db, scopeOf(c), (tx) =>
    tx
      .select()
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.walletId, c.wallet.id),
          eq(intentQuotes.purpose, "move_out"),
        ),
      ),
  );
const drain = (c: NearUsdcPayingCompany) =>
  runtime.runPromise(moveOut(c.company.organizationId));
const turnOff = (c: NearUsdcPayingCompany) =>
  runtime.runPromise(
    changeBalanceHome(c.company.organizationId, "company_wallet"),
  );
const float = (
  c: NearUsdcPayingCompany,
  pool: "company_wallet" | "confidential_account",
) =>
  runtime.runPromise(
    withScope(scopeOf(c), (tx) =>
      recordedExpendiSurplus(tx, c.wallet.id, undefined, pool),
    ),
  );
const ledger = (c: NearUsdcPayingCompany) =>
  runInScope(db, scopeOf(c), (tx) =>
    tx
      .select()
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, c.wallet.id)),
  );
function delivered(q: IntentQuote) {
  oneClick.state.deliverIntentPayout(q.depositAddress);
}

describe("resumable confidential rollback", () => {
  it("drains in capped parts, resumes, and never changes the ledger", async () => {
    const c = await company("confidential_account", 6n * USDC);
    oneClick.state.fundConfidential(c.wallet.address, 10n * USDC);
    const before = await ledger(c);
    expect(await turnOff(c)).toMatchObject({ draining: true });
    const first = await drain(c);
    expect(first).toMatchObject({
      purpose: "move_out",
      amountIn: 5n * USDC,
      status: "depositing",
    });
    if (!first) throw new Error("missing first quote");
    await drain(c);
    expect(await quotes(c)).toHaveLength(1);
    delivered(first);
    await drain(c);
    const second = await drain(c);
    expect(second?.amountIn).toBe(5n * USDC);
    if (!second) throw new Error("missing second quote");
    delivered(second);
    await drain(c);
    await drain(c);
    expect(await readWallet(c)).toMatchObject({
      balanceHome: "company_wallet",
      balanceHomeChanging: false,
      confidentialOptOut: true,
    });
    expect(await ledger(c)).toEqual(before);
    expect(oneClick.state.confidentialBalances.get(c.wallet.address)).toBe(0n);
  });

  it("moves Expendi's float between surplus pools, without crediting it to the company", async () => {
    const c = await company();
    const refill = await runtime.runPromise(
      startFeeCover({ organizationId: c.company.organizationId, atLeast: 0n }),
    );
    if (!refill) throw new Error("missing refill");
    oneClick.state.deliverConfidential(refill.depositAddress, USDC);
    await runInScope(db, scopeOf(c), (tx) =>
      tx
        .update(intentQuotes)
        .set({
          status: "succeeded",
          settledAt: new Date(),
          swappedAmountOut: USDC,
        })
        .where(eq(intentQuotes.id, refill.id)),
    );
    expect(await float(c, "confidential_account")).toBe(USDC);
    const before = await ledger(c);
    await turnOff(c);
    const q = await drain(c);
    expect(q?.movedSurplusUsdc).toBe(USDC);
    if (!q) throw new Error("missing move-out");
    delivered(q);
    await drain(c);
    await drain(c);
    expect(await float(c, "confidential_account")).toBe(0n);
    expect(await float(c, "company_wallet")).toBe(USDC);
    expect(await ledger(c)).toEqual(before);
  });

  /** Records a 1 USDC float refill as delivered without putting it there. */
  async function recordMissingFloat(c: NearUsdcPayingCompany) {
    const refill = await runtime.runPromise(
      startFeeCover({ organizationId: c.company.organizationId, atLeast: 0n }),
    );
    if (!refill) throw new Error("missing refill");
    await runInScope(db, scopeOf(c), (tx) =>
      tx
        .update(intentQuotes)
        .set({
          status: "succeeded",
          settledAt: new Date(),
          swappedAmountOut: USDC,
        })
        .where(eq(intentQuotes.id, refill.id)),
    );
  }

  it("finishes when the emptied account held less float than recorded, and writes the rest off", async () => {
    const c = await company();
    await recordMissingFloat(c);
    oneClick.state.fundConfidential(c.wallet.address, 400_000n);
    const before = await ledger(c);
    expect(await turnOff(c)).toMatchObject({ draining: true });
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    expect(q.movedSurplusUsdc).toBe(400_000n);
    delivered(q);
    await drain(c);
    await drain(c);
    expect(await readWallet(c)).toMatchObject({
      balanceHome: "company_wallet",
      balanceHomeChanging: false,
      confidentialFloatWrittenOffUsdc: 600_000n,
    });
    expect(await float(c, "confidential_account")).toBe(0n);
    expect(await float(c, "company_wallet")).toBe(400_000n);
    expect(await ledger(c)).toEqual(before);
  });

  it("drains an empty account whose float is still recorded, instead of refusing", async () => {
    const c = await company();
    await recordMissingFloat(c);
    expect(await turnOff(c)).toMatchObject({ draining: true });
    expect(await drain(c)).toBeNull();
    expect(await readWallet(c)).toMatchObject({
      balanceHome: "company_wallet",
      balanceHomeChanging: false,
      confidentialFloatWrittenOffUsdc: USDC,
    });
    expect(await float(c, "confidential_account")).toBe(0n);
    expect(await quotes(c)).toHaveLength(0);
  });

  it("recognises the public move-out receipt as internal, before and after turn-off", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, USDC);
    const before = await ledger(c);
    await turnOff(c);
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    const receipt = nearOutcome(
      [
        {
          executorId: TEST_USDC_CONTRACT,
          logs: [
            ftTransferLog([
              {
                from: NEAR_INTENTS_ACCOUNT_ID,
                to: c.wallet.address,
                amount: USDC,
              },
            ]),
          ],
        },
      ],
      { signerId: NEAR_INTENTS_ACCOUNT_ID },
    );
    fakes.chain.state.outcomes.set(receipt.txHash, receipt);
    fastNear.state.index(c.wallet.address, receipt);
    // Not yet listed by 1Click: the unsettled move-out holds the arrival.
    await runtime.runPromise(watchNearDeposits());
    expect(await ledger(c)).toEqual(before);
    delivered(q);
    oneClick.state.setStatus(q.depositAddress, {
      destinationChainTxHashes: [receipt.txHash],
    });
    await drain(c);
    await drain(c);
    await runtime.runPromise(watchNearDeposits());
    expect(await ledger(c)).toEqual(before);
    expect((await readWallet(c))?.balanceHome).toBe("company_wallet");
  });

  it("fences quotes, sends and payouts while draining, and stops move-ins and refills", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, 10n * USDC);
    await turnOff(c);
    expect(
      await runtime.runPromise(
        withScope(scopeOf(c), (tx) => isPaused(tx, c.company.organizationId)),
      ),
    ).toBe(true);
    expect(await runtime.runPromise(startMoveIn(scopeOf(c)))).toBeNull();
    expect(
      await runtime.runPromise(startFeeCover({ ...scopeOf(c), atLeast: 0n })),
    ).toBeNull();
    await expect(insertFundingPayout(db, c)).rejects.toThrow(/query/i);
    await expect(insertOpenSend(db, c, "reserved")).rejects.toThrow(/query/i);
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    // A request that was already quoting cannot sneak in after the flag.
    await expect(
      runInScope(db, scopeOf(c), (tx) =>
        tx.insert(intentQuotes).values({
          organizationId: c.company.organizationId,
          walletId: c.wallet.id,
          quoteKey: "stale-fund-in",
          purpose: "fund_in",
          swapType: "EXACT_INPUT",
          originAsset: q.originAsset,
          destinationAsset: q.destinationAsset,
          amountIn: USDC,
          amountOut: USDC,
          depositAddress: "f".repeat(64),
          recipient: c.wallet.address,
          recipientType: "CONFIDENTIAL_INTENTS",
          refundTo: c.wallet.address,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + 600_000),
          quoteResponse: {},
        }),
      ),
    ).rejects.toThrow(/query/i);
  });

  it("refuses to start while a payout is in flight", async () => {
    const c = await company();
    await insertFundingPayout(db, c);
    await expect(turnOff(c)).rejects.toThrow(/payout is funding/);
    expect((await readWallet(c))?.balanceHomeChanging).toBe(false);
  });

  it("waits for recently settled exact-output buffers before starting rollback", async () => {
    const c = await company();
    const wallet = await readWallet(c);
    if (!wallet?.transitAddress) throw new Error("missing transit wallet");
    const q = await saveQuote(
      runtime,
      db,
      {
        company: c.company,
        walletId: c.wallet.id,
        accountId: c.wallet.address,
        transitAddress: wallet.transitAddress,
      },
      "base_hop",
      {
        intentPaid: true,
        slippageBps: 0,
        row: {
          status: "succeeded",
          settledAt: new Date(),
        },
      },
    );
    await expect(turnOff(c)).rejects.toThrow(/buffer-return quiet period/);
    await runInScope(db, scopeOf(c), (tx) =>
      tx
        .update(intentQuotes)
        .set({
          settledAt: new Date(Date.now() - 6 * 60_000),
        })
        .where(eq(intentQuotes.id, q.id)),
    );
    expect(await turnOff(c)).toMatchObject({ balanceHome: "company_wallet" });
  });

  it("saves one quote under concurrent workers", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, 10n * USDC);
    await turnOff(c);
    await Promise.all([drain(c), drain(c)]);
    expect(await quotes(c)).toHaveLength(1);
    expect(oneClick.state.confidentialBalances.get(c.wallet.address)).toBe(0n);
  });

  it("keeps refunded money confidential, waits before retrying, and writes no ledger entries", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, USDC);
    const before = await ledger(c);
    await turnOff(c);
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    oneClick.state.refundIntentPayout(q.depositAddress);
    expect((await drain(c))?.status).toBe("refunded");
    expect(await drain(c)).toBeNull();
    expect(await quotes(c)).toHaveLength(1);
    expect((await readWallet(c))?.balanceHomeChanging).toBe(true);
    expect(await ledger(c)).toEqual(before);
  });

  it("holds an uncertain signed quote instead of replacing it", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, USDC);
    await turnOff(c);
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    oneClick.state.setStatus(q.depositAddress, { status: "FAILED" });
    expect((await drain(c))?.status).toBe("needs_review");
    await drain(c);
    expect(await quotes(c)).toHaveLength(1);
    expect((await readWallet(c))?.balanceHomeChanging).toBe(true);
  });

  it("refuses a fee-bearing move-out", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, USDC);
    await turnOff(c);
    oneClick.state.costPerQuote = 100n;
    expect(await drain(c)).toBeNull();
    expect(await quotes(c)).toHaveLength(0);
    expect(oneClick.state.confidentialBalances.get(c.wallet.address)).toBe(
      USDC,
    );
  });

  it("does not complete a short delivery, even if the account reads zero", async () => {
    const c = await company();
    oneClick.state.fundConfidential(c.wallet.address, USDC);
    await turnOff(c);
    const q = await drain(c);
    if (!q) throw new Error("missing move-out");
    oneClick.state.setStatus(q.depositAddress, {
      status: "SUCCESS",
      amountIn: USDC,
      amountOut: USDC - 1n,
    });
    expect((await drain(c))?.status).toBe("needs_review");
    await drain(c);
    expect((await readWallet(c))?.balanceHomeChanging).toBe(true);
  });
});

describe("confidential defaults and rollout", () => {
  it("does nothing while the environment switch is off", async () => {
    const c = await company("company_wallet");
    expect(await disabled.runPromise(rolloutConfidentialAccounts())).toEqual({
      enabled: 0,
      waiting: 0,
    });
    expect((await readWallet(c))?.balanceHome).toBe("company_wallet");
  });

  it("turns on one existing company per tick", async () => {
    const first = await company("company_wallet");
    const second = await company("company_wallet");
    expect(await runtime.runPromise(rolloutConfidentialAccounts())).toEqual({
      enabled: 1,
      waiting: 0,
    });
    expect((await readWallet(first))?.balanceHome).toBe("confidential_account");
    expect((await readWallet(second))?.balanceHome).toBe("company_wallet");
  });

  it("reserves relayer funds across companies and concurrent switches", async () => {
    const first = await company("company_wallet");
    const second = await company("company_wallet");
    // Existing suites may leave confidential fixtures; account for their
    // budget, then provide exactly one additional float.
    const reserve = await runtime.runPromise(
      withScope(scopeOf(first), (tx) =>
        query(() =>
          tx.execute<{ required: string }>(
            sql`SELECT confidential_rollout_reserve(${first.wallet.id})::text AS required`,
          ),
        ),
      ),
    );
    fakes.chain.state.balances.set(
      fakes.relayer.accountId,
      BigInt(reserve.rows[0]?.required ?? "0") + USDC,
    );
    const results = await Promise.allSettled(
      [first, second].map((c) =>
        runtime.runPromise(
          changeBalanceHome(c.company.organizationId, "confidential_account"),
        ),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("keeps an explicitly rolled-back company out of the rollout", async () => {
    const c = await company();
    await turnOff(c);
    await runtime.runPromise(rolloutConfidentialAccounts());
    expect(await readWallet(c)).toMatchObject({
      balanceHome: "company_wallet",
      confidentialOptOut: true,
    });
    await runtime.runPromise(
      changeBalanceHome(c.company.organizationId, "confidential_account"),
    );
    expect(await readWallet(c)).toMatchObject({
      balanceHome: "confidential_account",
      confidentialOptOut: false,
    });
  });

  const ensureFor = (
    c: Awaited<ReturnType<typeof createCompany>>,
    on: AppRuntime = runtime,
  ) =>
    on.runPromise(
      ensureCompanyWallet({
        organizationId: c.organizationId,
        actor: { type: "user", id: c.admin.id },
      }),
    );

  it("creates new wallets confidential when the relayer can fund the float", async () => {
    const c = await createCompany(db);
    made.push(c.organizationId);
    expect(await ensureFor(c)).toMatchObject({
      status: "active",
      balanceHome: "confidential_account",
    });
  });

  it("activates a new wallet on the company wallet when the relayer can't fund the float, and rolls it out later", async () => {
    const c = await createCompany(db);
    made.push(c.organizationId);
    fakes.chain.state.balances.set(fakes.relayer.accountId, 0n);
    const wallet = await ensureFor(c);
    expect(wallet).toMatchObject({
      status: "active",
      balanceHome: "company_wallet",
      confidentialOptOut: false,
    });
    fakes.chain.state.fundWithUsdc(fakes.relayer.accountId, 1_000_000n * USDC);
    expect(await runtime.runPromise(rolloutConfidentialAccounts())).toEqual({
      enabled: 1,
      waiting: 0,
    });
    expect(await ensureFor(c)).toMatchObject({
      id: wallet.id,
      balanceHome: "confidential_account",
    });
  });

  it("creates new wallets on the company wallet while the switch is off", async () => {
    const c = await createCompany(db);
    made.push(c.organizationId);
    expect(await ensureFor(c, disabled)).toMatchObject({
      status: "active",
      balanceHome: "company_wallet",
    });
  });
});
