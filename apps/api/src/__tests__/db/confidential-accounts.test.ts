import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewIntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import { randomNearAccount } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

function quote(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
): NewIntentQuote {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    quoteKey: `quote:${randomUUID()}`,
    purpose: "usdc_payout",
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amountIn: 5_053_815n,
    minAmountIn: 5_003_276n,
    amountOut: 5_000_000n,
    depositAddress: randomNearAccount(),
    recipient: randomNearAccount(),
    refundTo: wallet.address,
    deadline: new Date("2026-11-11T12:00:00.000Z"),
    quoteResponse: { signature: "ed25519:test" },
    ...overrides,
  };
}

const insertAs = (company: TestCompany, row: NewIntentQuote) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(intentQuotes).values(row).returning(),
  );

async function companyWithWallet() {
  const company = await createCompany(db);
  const wallet = await createActiveNearWallet(db, company, {
    privyWalletId: `near-wallet-${randomUUID()}`,
    accountId: randomNearAccount(),
  });
  return { company, wallet };
}

const signedIntent = { standard: "nep413", payload: { message: "{}" } };
const deadline = new Date("2026-11-11T12:00:00.000Z");

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("a wallet's balance home", () => {
  it("is the company wallet unless told otherwise", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ balanceHome: wallets.balanceHome })
          .from(wallets)
          .where(eq(wallets.id, wallet.id)),
    );

    // #then
    expect(row?.balanceHome).toBe("company_wallet");
  });
});

describe("a quote's recipient type", () => {
  it("is the destination chain unless told otherwise", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(company, quote(company, wallet));

    // #then
    expect(row?.recipientType).toBe("DESTINATION_CHAIN");
  });

  it("accepts a move into a confidential account", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(
      company,
      quote(company, wallet, {
        purpose: "move_in",
        swapType: "EXACT_INPUT",
        recipientType: "CONFIDENTIAL_INTENTS",
      }),
    );

    // #then
    expect(row).toMatchObject({
      purpose: "move_in",
      recipientType: "CONFIDENTIAL_INTENTS",
      signedIntent: null,
      intentHash: null,
      intentDeadline: null,
      intentSubmittedAt: null,
    });
  });
});

describe("a quote's signed intent", () => {
  it("saves the message with its deadline, hash and submission time", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(
      company,
      quote(company, wallet, {
        signedIntent,
        intentDeadline: deadline,
        intentHash: "hash-from-1click",
        intentSubmittedAt: deadline,
      }),
    );

    // #then
    expect(row).toMatchObject({
      signedIntent,
      intentDeadline: deadline,
      intentHash: "hash-from-1click",
    });
  });

  it("accepts a signed intent not yet submitted", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      quote(company, wallet, { signedIntent, intentDeadline: deadline }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it.each([
    ["a signed intent without a deadline", { signedIntent }],
    ["a deadline without a signed intent", { intentDeadline: deadline }],
  ])("rejects %s", async (_name, overrides) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, quote(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_signed_intent_has_deadline" },
    });
  });

  it.each([
    ["a hash", { intentHash: "hash-from-1click" }],
    ["a submission time", { intentSubmittedAt: deadline }],
  ])("rejects %s without a signed intent", async (_name, overrides) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, quote(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_intent_submitted_is_signed" },
    });
  });
});
