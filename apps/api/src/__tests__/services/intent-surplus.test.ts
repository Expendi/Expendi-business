import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote, NewIntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { SurplusPool } from "../../services/intents/expendi-surplus.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { recordedExpendiSurplus } from "../../services/intents/expendi-surplus.js";
import { ensureFeeCover } from "../../services/intents/fee-cover.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { recordedExpendiSurplus as exportedFromQuoteDeposit } from "../../services/intents/quote-deposit.js";
import { settleOpenQuotes } from "../helpers/confidential-delivery.js";
import { createFundedCompany } from "../helpers/money-in.js";
import { randomNearAccount } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let funded: FundedCompany;
const companies: FundedCompany[] = [];

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

afterEach(async () => {
  for (const company of companies.splice(0)) {
    await settleOpenQuotes(db, company);
  }
});

async function newCompany() {
  funded = await createFundedCompany(db);
  companies.push(funded);
}

const AMOUNT_IN = 5_050_000n;
const AMOUNT_OUT = 5_000_000n;
const STARTED = new Date("2026-11-11T11:50:00.000Z");
const SETTLED = new Date("2026-11-11T11:55:00.000Z");

const intentPaid = {
  depositType: "CONFIDENTIAL_INTENTS",
  refundType: "CONFIDENTIAL_INTENTS",
} as const;

/** A quote of the company's, started, as a hop or payout it covers the cost of. */
async function save(
  overrides: Partial<NewIntentQuote> = {},
): Promise<IntentQuote> {
  const [saved] = await runInScope(
    db,
    { organizationId: funded.company.organizationId },
    (tx) =>
      tx
        .insert(intentQuotes)
        .values({
          organizationId: funded.company.organizationId,
          walletId: funded.walletId,
          quoteKey: `quote:${randomUUID()}`,
          purpose: "base_hop",
          swapType: "EXACT_OUTPUT",
          originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
          amountIn: AMOUNT_IN,
          minAmountIn: AMOUNT_OUT,
          amountOut: AMOUNT_OUT,
          depositAddress: randomNearAccount(),
          recipient: funded.transitAddress,
          refundTo: funded.accountId,
          deadline: new Date("2026-11-11T12:00:00.000Z"),
          quoteResponse: { signature: "ed25519:test" },
          depositStartedAt: STARTED,
          ...overrides,
        })
        .returning(),
  );
  if (!saved) throw new Error("quote insert returned no row");
  return saved;
}

const settled = { settledAt: SETTLED } as const;

/** What the company wallet's pool holds today, with the query as it was before the pool existed. */
const referenceSurplus = (excludeQuoteId?: string) =>
  runInScope(
    db,
    { organizationId: funded.company.organizationId },
    async (tx) => {
      const { rows } = await tx.execute<{ surplus: string }>(sql`
      SELECT coalesce(sum(
        coalesce(fee_cover_usdc, 0) - CASE
          WHEN status = 'succeeded' THEN
            least(greatest(coalesce(swapped_amount_in, amount_in), amount_out), amount_in) - amount_out
          WHEN status = 'refunded' THEN
            amount_in - least(coalesce(refunded_amount, amount_in), amount_in)
          WHEN status = 'failed' AND company_wallet_send_id IS NULL THEN 0
          ELSE amount_in - amount_out
        END), 0)::text AS surplus
      FROM intent_quotes
      WHERE wallet_id = ${funded.walletId}
        AND ${excludeQuoteId === undefined ? sql`true` : sql`id <> ${excludeQuoteId}`}
        AND purpose IN ('base_hop', 'usdc_payout')
        AND deposit_started_at IS NOT NULL`);
      return BigInt(rows[0]?.surplus ?? "0");
    },
  );

const surplus = (
  excludeQuoteId?: string,
  pool?: SurplusPool,
): Promise<bigint> =>
  runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
    runtime.runPromise(
      recordedExpendiSurplus(tx, funded.walletId, excludeQuoteId, pool),
    ),
  );

/** Public rows of every status; their sum is worked out by hand in the test. */
async function savePublicRows() {
  await save({
    status: "succeeded",
    ...settled,
    feeCoverUsdc: 50_000n,
    swappedAmountIn: 5_010_000n,
  });
  await save({
    status: "refunded",
    ...settled,
    feeCoverUsdc: 50_000n,
    refundedAmount: AMOUNT_IN,
  });
  await save({
    status: "refunded",
    ...settled,
    feeCoverUsdc: 50_000n,
    refundedAmount: AMOUNT_OUT,
  });
  await save({ status: "depositing", feeCoverUsdc: 50_000n });
  await save({ status: "failed", ...settled, feeCoverUsdc: 50_000n });
  await save({ status: "quoted", depositStartedAt: null });
  await save({
    purpose: "usdc_payout",
    status: "needs_review",
    feeCoverUsdc: 30_000n,
  });
}

describe("recordedExpendiSurplus", () => {
  it("is the same function from quote-deposit.ts", () => {
    expect(exportedFromQuoteDeposit).toBe(recordedExpendiSurplus);
  });

  it("returns for the company wallet exactly what it always did", async () => {
    // #given quotes of every status that the company wallet covered
    await newCompany();
    await savePublicRows();

    // #when
    const [byDefault, named, expected] = await Promise.all([
      surplus(),
      surplus(undefined, "company_wallet"),
      referenceSurplus(),
    ]);

    // #then 40_000 + 50_000 + 0 + 0 + 50_000 - 20_000, and the old query agrees
    expect([byDefault, named, expected]).toEqual([
      120_000n,
      120_000n,
      120_000n,
    ]);
  });

  it("leaves the quote it is told to exclude out", async () => {
    // #given
    await newCompany();
    await savePublicRows();
    const review = await save({
      status: "needs_review",
      feeCoverUsdc: 70_000n,
    });

    // #when
    const [without, all, expected] = await Promise.all([
      surplus(review.id),
      surplus(),
      referenceSurplus(review.id),
    ]);

    // #then
    expect([without, all - without, expected]).toEqual([
      120_000n,
      20_000n,
      120_000n,
    ]);
  });

  it("never reads a quote paid out of the confidential account for the company wallet", async () => {
    // #given the public rows, and quotes paid by message in review and succeeded
    await newCompany();
    await savePublicRows();
    await save({ ...intentPaid, status: "needs_review" });
    await save({
      ...intentPaid,
      status: "succeeded",
      ...settled,
      swappedAmountIn: 5_010_000n,
    });

    // #when
    const byDefault = await surplus();

    // #then
    expect(byDefault).toBe(120_000n);
  });

  it("counts the float in the confidential account: delivered fee covers, less what paid-out quotes and sweeps cost", async () => {
    // #given
    await newCompany();
    await savePublicRows();
    const inFlight = await save({ ...intentPaid, status: "needs_review" });
    await save({
      purpose: "usdc_payout",
      ...intentPaid,
      status: "succeeded",
      ...settled,
      swappedAmountIn: 5_010_000n,
    });
    await save({ ...intentPaid, status: "failed", ...settled });
    await save({
      ...intentPaid,
      status: "refunded",
      ...settled,
      refundedAmount: AMOUNT_IN,
    });
    const cover = (overrides: Partial<NewIntentQuote>) =>
      save({
        purpose: "fee_cover",
        swapType: "EXACT_INPUT",
        recipientType: "CONFIDENTIAL_INTENTS",
        amountIn: 1_000_000n,
        minAmountIn: null,
        amountOut: 1_000_000n,
        ...overrides,
      });
    await cover({
      status: "succeeded",
      ...settled,
      swappedAmountOut: 1_000_000n,
    });
    await cover({ status: "depositing" });
    await cover({ status: "refunded", ...settled });
    await save({
      purpose: "sweep",
      swapType: "EXACT_INPUT",
      recipientType: "CONFIDENTIAL_INTENTS",
      amountIn: 1_000_000n,
      minAmountIn: null,
      amountOut: 999_798n,
      status: "succeeded",
      ...settled,
    });
    await save({
      purpose: "sweep",
      swapType: "EXACT_INPUT",
      recipientType: "CONFIDENTIAL_INTENTS",
      amountIn: 1_000_000n,
      minAmountIn: null,
      amountOut: 999_798n,
      status: "depositing",
    });

    // #when
    const [float, withoutInFlight] = await Promise.all([
      surplus(undefined, "confidential_account"),
      surplus(inFlight.id, "confidential_account"),
    ]);

    // #then 1_000_000 - 50_000 (in review) - 10_000 - 0 - 0 - 202 (sweep)
    expect([float, withoutInFlight]).toEqual([939_798n, 989_798n]);
  });

  it("is empty for a company with nothing in the account", async () => {
    // #given
    await newCompany();
    await savePublicRows();

    // #when
    const float = await surplus(undefined, "confidential_account");

    // #then
    expect(float).toBe(0n);
  });
});

describe("ensureFeeCover", () => {
  const payout = (overrides: Partial<NewIntentQuote> = {}) =>
    save({
      ...intentPaid,
      status: "quoted",
      depositStartedAt: null,
      ...overrides,
    });

  const deliveredCover = (amount: bigint) =>
    save({
      purpose: "fee_cover",
      swapType: "EXACT_INPUT",
      recipientType: "CONFIDENTIAL_INTENTS",
      amountIn: amount,
      minAmountIn: null,
      amountOut: amount,
      status: "succeeded",
      ...settled,
      swappedAmountOut: amount,
    });

  const answer = (quote: IntentQuote) =>
    runtime.runPromise(ensureFeeCover(quote));

  it.each([
    [0n, "waiting"],
    [49_999n, "waiting"],
    [50_000n, "covered"],
    [1_000_000n, "covered"],
  ] as const)(
    "answers %s of float against a cost of 50000: %s",
    async (float, expected) => {
      // #given
      await newCompany();
      if (float > 0n) await deliveredCover(float);
      const quote = await payout();

      // #when
      const covered = await answer(quote);

      // #then
      expect(covered).toBe(expected);
    },
  );

  it("never counts the quote itself against the float", async () => {
    // #given a quote in flight whose cost is the whole float
    await newCompany();
    await deliveredCover(50_000n);
    const quote = await payout({
      status: "depositing",
      depositStartedAt: STARTED,
    });

    // #when
    const covered = await answer(quote);

    // #then
    expect(covered).toBe("covered");
  });

  it("counts another quote in flight, so two can't spend one float", async () => {
    // #given a float for one quote, spent by one still in flight
    await newCompany();
    await deliveredCover(50_000n);
    await payout({ status: "depositing", depositStartedAt: STARTED });
    const second = await payout();

    // #when
    const covered = await answer(second);

    // #then
    expect(covered).toBe("waiting");
  });

  it("covers a quote that costs nothing, even when sweeps have taken the float below zero", async () => {
    // #given
    await newCompany();
    await save({
      purpose: "sweep",
      swapType: "EXACT_INPUT",
      recipientType: "CONFIDENTIAL_INTENTS",
      amountIn: 1_000_000n,
      minAmountIn: null,
      amountOut: 999_798n,
      status: "succeeded",
      ...settled,
    });
    const free = await payout({
      swapType: "EXACT_INPUT",
      minAmountIn: null,
      amountIn: AMOUNT_OUT,
    });

    // #when
    const covered = await answer(free);

    // #then
    expect(covered).toBe("covered");
  });

  it("never tops up: it only reads", async () => {
    // #given
    await newCompany();
    const quote = await payout();

    // #when
    await answer(quote);

    // #then
    const covers = await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .select({ id: intentQuotes.id })
          .from(intentQuotes)
          .where(sql`${intentQuotes.purpose}::text = 'fee_cover'`),
    );
    expect(covers).toEqual([]);
  });
});
