import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type {
  NewCompanyWalletSend,
  NewIntentQuote,
  NewPayout,
} from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
  UNSETTLED_INTENT_QUOTE_STATUSES,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { createActiveNearWallet, createCompany } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { saveTreasuryMove } from "../helpers/money-in.js";
import { randomNearAccount, randomNearTxHash } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;
let walletA: TestWallet;
let walletB: TestWallet;
let nextNonce = 1n;

const nearWallet = () => ({
  privyWalletId: `near-wallet-${randomUUID()}`,
  accountId: randomNearAccount(),
});

const transitAddress = () => `0x${randomBytes(20).toString("hex")}`;

/** A Base hop quote as it is saved, before anything is sent to it. */
function hop(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
): NewIntentQuote {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    quoteKey: `hop:${randomUUID()}`,
    purpose: "base_hop",
    swapType: "EXACT_OUTPUT",
    originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
    amountIn: 5_053_815n,
    minAmountIn: 5_003_276n,
    amountOut: 5_000_000n,
    depositAddress: randomNearAccount(),
    recipient: transitAddress(),
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

async function saved(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewIntentQuote> = {},
) {
  const [quote] = await insertAs(company, hop(company, wallet, overrides));
  if (!quote) throw new Error("quote insert returned no row");
  return quote;
}

async function companyWithWallet() {
  const company = await createCompany(db);
  return {
    company,
    wallet: await createActiveNearWallet(db, company, nearWallet()),
  };
}

/** A company wallet send that has run, so it doesn't hold its wallet. */
async function executedSend(company: TestCompany, wallet: TestWallet) {
  nextNonce += 1n;
  const row: NewCompanyWalletSend = {
    organizationId: company.organizationId,
    walletId: wallet.id,
    sendKey: `hop-${randomUUID()}`,
    kind: "transfer",
    status: "executed",
    senderAccountId: wallet.address,
    receiverAccountId: randomNearAccount(),
    usdcAmount: 5_053_815n,
    nonce: nextNonce,
    maxBlockHeight: 1_000n,
    signedDelegate: "c2lnbmVk",
    txHash: randomNearTxHash(),
    blockHeight: 900n,
  };
  const [send] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.insert(companyWalletSends).values(row).returning(),
  );
  if (!send) throw new Error("send insert returned no row");
  return send;
}

function payout(
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewPayout> = {},
): NewPayout {
  return {
    organizationId: company.organizationId,
    walletId: wallet.id,
    subjectType: "claim",
    subjectId: randomUUID(),
    idempotencyKey: `claim:${randomUUID()}:1`,
    provider: "paycrest",
    method: "mpesa_phone",
    recipient: {
      method: "mpesa_phone",
      phone: "+254712345678",
      accountName: "Jane Wanjiku",
    },
    requestedKesCents: 150_000n,
    amountKes: 150_000n,
    quotedRate: "128.68",
    quotedUsdc: 11_656_823n,
    maxDebitUsdc: 11_965_108n,
    ...overrides,
  };
}

const usdcPayout = (
  company: TestCompany,
  wallet: TestWallet,
  overrides: Partial<NewPayout> = {},
) =>
  payout(company, wallet, {
    subjectType: "bill",
    provider: "onchain",
    method: "usdc",
    recipient: {
      method: "usdc",
      chain: "solana",
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      accountName: "Acme Ltd",
    },
    ...overrides,
  });

const insertPayoutAs = (company: TestCompany, row: NewPayout) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.insert(payouts).values(row).returning(),
  );

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
  [walletA, walletB] = await Promise.all([
    createActiveNearWallet(db, fixture.companyA, nearWallet()),
    createActiveNearWallet(db, fixture.companyB, nearWallet()),
  ]);
  await saved(fixture.companyA, walletA);
  await saved(fixture.companyB, walletB);
});

afterAll(async () => {
  await runtime.dispose();
});

describe("intent_quotes", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "intent_quotes");
  });

  it("starts a quote as quoted, with nothing known from 1Click yet", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const quote = await saved(company, wallet);

    // #then
    expect(quote).toMatchObject({
      status: "quoted",
      oneClickStatus: null,
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      depositedAmount: null,
      refundedAmount: null,
      settledAt: null,
    });
  });

  it("holds an amount too large for a 64-bit column", async () => {
    // #given 100 NEAR in yoctoNEAR, as a fund-in from NEAR would quote
    const { company, wallet } = await companyWithWallet();
    const hundredNear = 100n * 10n ** 24n;

    // #when
    const quote = await saved(company, wallet, {
      purpose: "fund_in",
      swapType: "EXACT_INPUT",
      originAsset: "nep141:wrap.near",
      amountIn: hundredNear,
      minAmountIn: null,
      minAmountOut: 4_900_000n,
    });

    // #then
    expect(quote.amountIn).toBe(hundredNear);
  });

  it("can't record a quote against another company's wallet", async () => {
    // #when
    const crossed = insertAs(fixture.companyA, hop(fixture.companyA, walletB));

    // #then
    await expect(crossed).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_wallet_organization_fk" },
    });
  });

  it("gives a deposit address to one quote only, whichever company asks", async () => {
    // #given
    const first = await companyWithWallet();
    const second = await companyWithWallet();
    const depositAddress = randomNearAccount();
    await saved(first.company, first.wallet, { depositAddress });

    // #when
    const reused = insertAs(
      second.company,
      hop(second.company, second.wallet, { depositAddress }),
    );

    // #then
    await expect(reused).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_deposit_address_unique" },
    });
  });

  it("never gives one key a second quote", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quoteKey = `hop:${randomUUID()}`;
    await saved(company, wallet, { quoteKey });

    // #when
    const again = insertAs(company, hop(company, wallet, { quoteKey }));

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_quote_key_unique" },
    });
  });

  it("lets two companies use the same key", async () => {
    // #given
    const first = await companyWithWallet();
    const second = await companyWithWallet();
    await saved(first.company, first.wallet, { quoteKey: "hop:1" });

    // #when
    const other = await saved(second.company, second.wallet, {
      quoteKey: "hop:1",
    });

    // #then
    expect(other.quoteKey).toBe("hop:1");
  });

  it("links a quote to the company wallet send that paid it", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const send = await executedSend(company, wallet);

    // #when
    const quote = await saved(company, wallet, {
      status: "depositing",
      companyWalletSendId: send.id,
    });

    // #then
    expect(quote.companyWalletSendId).toBe(send.id);
  });

  it("can't link a quote to another company's send", async () => {
    // #given
    const mine = await companyWithWallet();
    const theirs = await companyWithWallet();
    const send = await executedSend(theirs.company, theirs.wallet);

    // #when
    const crossed = insertAs(
      mine.company,
      hop(mine.company, mine.wallet, { companyWalletSendId: send.id }),
    );

    // #then
    await expect(crossed).rejects.toMatchObject({
      cause: {
        constraint: "intent_quotes_company_wallet_send_organization_fk",
      },
    });
  });

  it("lets one send pay one quote only", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const send = await executedSend(company, wallet);
    await saved(company, wallet, { companyWalletSendId: send.id });

    // #when
    const second = insertAs(
      company,
      hop(company, wallet, { companyWalletSendId: send.id }),
    );

    // #then
    await expect(second).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_company_wallet_send_unique" },
    });
  });

  it.each([
    ["for nothing in", { amountIn: 0n }, "intent_quotes_amounts_positive"],
    ["for nothing out", { amountOut: 0n }, "intent_quotes_amounts_positive"],
    [
      "whose least amount in is more than its amount in",
      { minAmountIn: 5_053_816n },
      "intent_quotes_amounts_positive",
    ],
    [
      "whose least amount out is more than its amount out",
      { minAmountOut: 5_000_001n },
      "intent_quotes_amounts_positive",
    ],
    [
      "settled without the time it settled",
      { status: "succeeded" as const },
      "intent_quotes_settled_has_time",
    ],
    [
      "still open but marked with a settling time",
      { settledAt: new Date() },
      "intent_quotes_settled_has_time",
    ],
    [
      "with a fee cover that a company wallet doesn't fund",
      { purpose: "sweep" as const, feeCoverUsdc: 53_815n },
      "intent_quotes_fee_cover_is_for_a_company_send",
    ],
    [
      "with a fee cover of nothing",
      { feeCoverUsdc: 0n },
      "intent_quotes_fee_cover_is_for_a_company_send",
    ],
    [
      "with a fee cover transaction but no amount",
      { feeCoverTxHash: randomNearTxHash() },
      "intent_quotes_fee_cover_is_for_a_company_send",
    ],
    [
      "expired although a deposit was started",
      {
        status: "expired" as const,
        settledAt: new Date(),
        depositStartedAt: new Date(),
      },
      "intent_quotes_expired_never_deposited",
    ],
  ])("rejects a quote %s", async (_name, overrides, constraint) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, hop(company, wallet, overrides));

    // #then
    await expect(insert).rejects.toMatchObject({ cause: { constraint } });
  });

  it("rejects a sweep paid by a company wallet send", async () => {
    // #given a sweep starts from the transit wallet, never the company wallet
    const { company, wallet } = await companyWithWallet();
    const send = await executedSend(company, wallet);

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        purpose: "sweep",
        swapType: "EXACT_INPUT",
        companyWalletSendId: send.id,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_send_is_from_company_wallet" },
    });
  });

  it("finds the company's quote a NEAR transaction belongs to, by its exact hash", async () => {
    // #given a quote whose status lists a refund on NEAR and a delivery on Base
    const { company, wallet } = await companyWithWallet();
    const refundTxHash = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    const quote = await saved(company, wallet, {
      status: "depositing",
      nearTxHashes: [randomNearTxHash(), refundTxHash],
      destinationChainTxHashes: [`0x${"ab".repeat(32)}`],
    });
    const belongsTo = (txHash: string) =>
      runInScope(db, { organizationId: company.organizationId }, (tx) =>
        tx
          .select({ id: intentQuotes.id })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.organizationId, company.organizationId),
              sql`(${intentQuotes.nearTxHashes} @> ARRAY[${txHash}]::text[] OR ${intentQuotes.destinationChainTxHashes} @> ARRAY[${txHash}]::text[])`,
            ),
          ),
      );

    // #when
    const [exact, lowercased, delivery, unrelated] = await Promise.all([
      belongsTo(refundTxHash),
      belongsTo(refundTxHash.toLowerCase()),
      belongsTo(`0x${"ab".repeat(32)}`),
      belongsTo(randomNearTxHash()),
    ]);

    // #then
    expect({ exact, lowercased, delivery, unrelated }).toEqual({
      exact: [{ id: quote.id }],
      lowercased: [],
      delivery: [{ id: quote.id }],
      unrelated: [],
    });
  });

  it("counts a quote as unsettled until it reaches a final status", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const settledAt = new Date();
    await saved(company, wallet, { status: "quoted" });
    await saved(company, wallet, { status: "depositing" });
    await saved(company, wallet, { status: "needs_review" });
    await saved(company, wallet, { status: "succeeded", settledAt });
    await saved(company, wallet, { status: "refunded", settledAt });
    await saved(company, wallet, { status: "failed", settledAt });
    await saved(company, wallet, { status: "expired", settledAt });

    // #when
    const unsettled = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ status: intentQuotes.status })
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.organizationId, company.organizationId),
              inArray(intentQuotes.status, UNSETTLED_INTENT_QUOTE_STATUSES),
            ),
          ),
    );

    // #then
    expect(unsettled.map((row) => row.status).sort()).toEqual([
      "depositing",
      "needs_review",
      "quoted",
    ]);
  });

  it("can't be deleted by the API", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quote = await saved(company, wallet);

    // #when
    const remove = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.delete(intentQuotes).where(eq(intentQuotes.id, quote.id)),
    );

    // #then
    await expect(remove).rejects.toMatchObject({ cause: { code: "42501" } });
  });
});

describe("a quote paid out of a confidential account", () => {
  const paid = {
    depositType: "CONFIDENTIAL_INTENTS",
    refundType: "CONFIDENTIAL_INTENTS",
  } as const;
  // Final, so a job that walks every company never picks these rows up.
  const started = {
    ...paid,
    status: "refunded",
    settledAt: new Date("2026-11-11T11:52:00.000Z"),
    depositStartedAt: new Date("2026-11-11T11:50:00.000Z"),
  } as const;
  const done = {
    status: "refunded",
    settledAt: new Date("2026-11-11T11:52:00.000Z"),
  } as const;
  const message = { standard: "nep413", payload: { message: "{}" } };
  const messageDeadline = new Date("2026-11-14T11:50:00.000Z");
  const signed = {
    ...started,
    signedIntent: message,
    intentDeadline: messageDeadline,
  } as const;
  const treasuryMove = (company: TestCompany, wallet: TestWallet) =>
    saveTreasuryMove(db, { company, walletId: wallet.id });

  it.each([
    ["a Base hop", { purpose: "base_hop" as const }],
    ["a USDC payout", { purpose: "usdc_payout" as const }],
  ])("accepts %s, which refunds into the account too", async (_name, row) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, { ...paid, ...done, ...row }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it("accepts a move to Treasury", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const move = await treasuryMove(company, wallet);

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...paid,
        ...done,
        purpose: "to_treasury",
        swapType: "EXACT_INPUT",
        treasuryMoveId: move.id,
      }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it.each([
    [
      "a sweep",
      { purpose: "sweep" as const, swapType: "EXACT_INPUT" as const },
    ],
    [
      "a fund-in",
      {
        purpose: "fund_in" as const,
        swapType: "EXACT_INPUT" as const,
        refundType: "INTENTS" as const,
      },
    ],
    [
      "a move-in",
      {
        purpose: "move_in" as const,
        swapType: "EXACT_INPUT" as const,
        recipientType: "CONFIDENTIAL_INTENTS" as const,
      },
    ],
    [
      "a fee cover",
      {
        purpose: "fee_cover" as const,
        swapType: "EXACT_INPUT" as const,
        recipientType: "CONFIDENTIAL_INTENTS" as const,
      },
    ],
  ])("rejects %s paid out of the account", async (_name, row) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, { depositType: "CONFIDENTIAL_INTENTS", ...row }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_intents_side_matches_purpose" },
    });
  });

  it.each([
    [
      "paid on chain but refunding into the account",
      { refundType: "CONFIDENTIAL_INTENTS" as const },
    ],
    [
      "paid from the account but refunding on chain",
      { depositType: "CONFIDENTIAL_INTENTS" as const },
    ],
    [
      "a fund-in refunding into the account",
      {
        purpose: "fund_in" as const,
        swapType: "EXACT_INPUT" as const,
        refundType: "CONFIDENTIAL_INTENTS" as const,
      },
    ],
    [
      "a payout refunding into NEAR Intents",
      { refundType: "INTENTS" as const },
    ],
  ])("rejects a quote %s", async (_name, row) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(company, hop(company, wallet, row));

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_intents_side_matches_purpose" },
    });
  });

  it("accepts a signed message once its deposit has started", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const [row] = await insertAs(company, hop(company, wallet, signed));

    // #then
    expect(row).toMatchObject({ signedIntent: message });
  });

  it.each([
    ["on chain", { depositStartedAt: new Date() }],
    ["before its deposit started", { ...paid }],
  ])("rejects a signed message on a quote paid %s", async (_name, row) => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...row,
        signedIntent: message,
        intentDeadline: messageDeadline,
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_signed_intent_is_confidential" },
    });
  });

  it.each([
    ["a company wallet send", "send"],
    ["a deposit transaction", "deposit"],
    ["a registration transaction", "registration"],
    ["a fee cover", "fee cover"],
  ] as const)("rejects one with %s", async (_name, kind) => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const send = await executedSend(company, wallet);
    const overrides: Partial<NewIntentQuote> = {
      send: { companyWalletSendId: send.id },
      deposit: { depositTxHash: randomNearTxHash() },
      registration: { depositRegistrationTxHash: randomNearTxHash() },
      "fee cover": { feeCoverUsdc: 53_815n },
    }[kind];

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, { ...paid, ...overrides }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_confidential_deposit_has_no_send" },
    });
  });

  it("fails only after its signed message's own deadline", async () => {
    // #given a quote whose message is still live, and one whose is dead
    const live = await companyWithWallet();
    const dead = await companyWithWallet();

    // #when
    const early = insertAs(
      live.company,
      hop(live.company, live.wallet, {
        ...signed,
        status: "failed",
        settledAt: new Date("2026-11-13T00:00:00.000Z"),
      }),
    );
    const late = insertAs(
      dead.company,
      hop(dead.company, dead.wallet, {
        ...signed,
        status: "failed",
        settledAt: new Date("2026-11-14T11:50:01.000Z"),
      }),
    );

    // #then
    await expect(early).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_signed_fails_after_its_deadline" },
    });
    await expect(late).resolves.toHaveLength(1);
  });

  it("fails when nothing was signed, at any time", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...started,
        status: "failed",
        settledAt: new Date("2026-11-11T11:52:00.000Z"),
      }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it("can't be expired once a message was signed", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...signed,
        status: "expired",
        settledAt: new Date("2026-11-11T11:52:00.000Z"),
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_expired_never_deposited" },
    });
  });
});

describe("a fee cover quote", () => {
  const cover = {
    purpose: "fee_cover",
    swapType: "EXACT_INPUT",
    recipientType: "CONFIDENTIAL_INTENTS",
  } as const;

  it("is delivered into the company's confidential account", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...cover,
        status: "refunded",
        settledAt: new Date("2026-11-11T11:52:00.000Z"),
      }),
    );

    // #then
    await expect(insert).resolves.toHaveLength(1);
  });

  it("can't be anywhere else", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, { ...cover, recipientType: "DESTINATION_CHAIN" }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "intent_quotes_recipient_type_matches_purpose" },
    });
  });

  it("can't be credited to the ledger", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();

    // #when
    const insert = insertAs(
      company,
      hop(company, wallet, {
        ...cover,
        status: "succeeded",
        settledAt: new Date(),
        ledgerCreditedAt: new Date(),
      }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: {
        constraint: "intent_quotes_ledger_credit_is_confidential_delivery",
      },
    });
  });
});

describe("a payout's quotes", () => {
  it("lets every cash-out of a payroll run share one Base hop", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quote = await saved(company, wallet);

    // #when
    const [first] = await insertPayoutAs(
      company,
      payout(company, wallet, { baseHopQuoteId: quote.id }),
    );
    const [second] = await insertPayoutAs(
      company,
      payout(company, wallet, { baseHopQuoteId: quote.id }),
    );

    // #then
    expect([first?.baseHopQuoteId, second?.baseHopQuoteId]).toEqual([
      quote.id,
      quote.id,
    ]);
  });

  it("links a USDC payout to the quote that delivered it", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quote = await saved(company, wallet, { purpose: "usdc_payout" });

    // #when
    const [paid] = await insertPayoutAs(
      company,
      usdcPayout(company, wallet, { deliveryQuoteId: quote.id }),
    );

    // #then
    expect(paid?.deliveryQuoteId).toBe(quote.id);
  });

  it("lets one quote deliver one payout only", async () => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quote = await saved(company, wallet, { purpose: "usdc_payout" });
    await insertPayoutAs(
      company,
      usdcPayout(company, wallet, { deliveryQuoteId: quote.id }),
    );

    // #when
    const second = insertPayoutAs(
      company,
      usdcPayout(company, wallet, { deliveryQuoteId: quote.id }),
    );

    // #then
    await expect(second).rejects.toMatchObject({
      cause: { constraint: "payouts_delivery_quote_id_unique" },
    });
  });

  it.each([
    [
      "a Base hop on a USDC payout",
      "baseHopQuoteId" as const,
      usdcPayout,
      "payouts_base_hop_is_for_a_cash_out",
    ],
    [
      "a delivery quote on a cash-out",
      "deliveryQuoteId" as const,
      payout,
      "payouts_delivery_quote_is_for_usdc",
    ],
  ])("rejects %s", async (_name, column, make, constraint) => {
    // #given
    const { company, wallet } = await companyWithWallet();
    const quote = await saved(company, wallet);

    // #when
    const insert = insertPayoutAs(
      company,
      make(company, wallet, { [column]: quote.id }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({ cause: { constraint } });
  });

  it.each([
    [
      "Base hop",
      "baseHopQuoteId" as const,
      payout,
      "payouts_base_hop_quote_organization_fk",
    ],
    [
      "delivery quote",
      "deliveryQuoteId" as const,
      usdcPayout,
      "payouts_delivery_quote_organization_fk",
    ],
  ])(
    "can't use another company's %s",
    async (_name, column, make, constraint) => {
      // #given
      const mine = await companyWithWallet();
      const theirs = await companyWithWallet();
      const quote = await saved(theirs.company, theirs.wallet);

      // #when
      const crossed = insertPayoutAs(
        mine.company,
        make(mine.company, mine.wallet, { [column]: quote.id }),
      );

      // #then
      await expect(crossed).rejects.toMatchObject({ cause: { constraint } });
    },
  );
});
