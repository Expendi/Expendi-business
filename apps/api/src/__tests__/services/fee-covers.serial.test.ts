import { and, eq, inArray } from "drizzle-orm";
import { Effect, Layer } from "effect";
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
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { AppRuntime } from "../../runtime.js";
import type {
  OneClickFirmQuote,
  OneClickShape,
} from "../../services/intents/one-click.js";
import type { FundedCompany } from "../helpers/money-in.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  intentQuotes,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { MOVE_IN_MIN_USDC } from "../../services/intents/confidential-account.js";
import { recordedExpendiSurplus } from "../../services/intents/expendi-surplus.js";
import {
  advanceFeeCover,
  coverFees,
  ensureFeeCover,
  FEE_COVER_RETRY_AFTER_MS,
  FEE_FLOAT_LOW_USDC,
  FEE_FLOAT_TARGET_USDC,
  startFeeCover,
} from "../../services/intents/fee-cover.js";
import {
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
  OneClickRefused,
} from "../../services/intents/one-click.js";
import { creditSettledQuote } from "../../services/intents/quote-credit.js";
import { ledgerOf, saveQuote } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { barrier, makeTestRuntime } from "../helpers/runtime.js";

// Serial: the job walks every company wallet in the database.

const fakes = makeNearUsdcFakes();
const { chain } = fakes;
const oneClick = makeFakeOneClick();
const relayerAccount = fakes.relayer.accountId;

let tamper: (quote: OneClickFirmQuote) => OneClickFirmQuote = (quote) => quote;
let signInFails = false;
let beforeQuoteAnswered: (() => Promise<void>) | undefined;
const wrapped: OneClickShape = {
  ...oneClick.service,
  quote: (request, session) =>
    Effect.promise(async () => beforeQuoteAnswered?.()).pipe(
      Effect.flatMap(() => oneClick.service.quote(request, session)),
      Effect.map((quote) => (quote.dry ? quote : tamper(quote))),
    ),
  authenticate: (signed) =>
    signInFails
      ? Effect.fail(
          new OneClickRefused({
            message: "1Click refused sign-in: fake refusal",
            httpStatus: 401,
          }),
        )
      : oneClick.service.authenticate(signed),
};

let runtime: AppRuntime;
let wrappedRuntime: AppRuntime;
let db: Database;
let paying: NearUsdcPayingCompany;
let funded: FundedCompany;
const made: { organizationId: string; walletId: string }[] = [];

beforeAll(async () => {
  runtime = makeTestRuntime(
    { ...fakes.layers, oneClick: oneClick.layer },
    fakes.env,
  );
  wrappedRuntime = makeTestRuntime(
    { ...fakes.layers, oneClick: Layer.succeed(OneClick, wrapped) },
    fakes.env,
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  chain.state.fundWithUsdc(relayerAccount, 1_000n * USDC);
  oneClick.state.costPerQuote = 0n;
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), wrappedRuntime.dispose()]);
});

afterEach(async () => {
  tamper = (quote) => quote;
  signInFails = false;
  beforeQuoteAnswered = undefined;
  oneClick.state.costPerQuote = 0n;
  chain.state.fundWithUsdc(relayerAccount, 0n);
  // Leave nothing a global job would pick up: no confidential company, no
  // unsettled quote.
  for (const company of made.splice(0)) {
    await runInScope(
      db,
      { organizationId: company.organizationId },
      async (tx) => {
        await tx
          .update(intentQuotes)
          .set({ status: "failed", settledAt: new Date() })
          .where(
            and(
              eq(intentQuotes.walletId, company.walletId),
              inArray(intentQuotes.status, [
                "quoted",
                "depositing",
                "needs_review",
              ]),
            ),
          );
        await tx
          .update(wallets)
          .set({ balanceHome: "company_wallet" })
          .where(eq(wallets.id, company.walletId));
      },
    );
  }
});

async function newCompany(
  balanceHome: WalletBalanceHome = "confidential_account",
  balance = 100n * USDC,
) {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    balance,
    undefined,
    balanceHome,
  );
  const [row] = await runInScope(
    db,
    { organizationId: organizationId() },
    (tx) =>
      tx
        .select({ transitAddress: wallets.transitAddress })
        .from(wallets)
        .where(eq(wallets.id, paying.wallet.id)),
  );
  if (!row?.transitAddress) throw new Error("wallet has no transit address");
  funded = {
    company: paying.company,
    walletId: paying.wallet.id,
    accountId: paying.wallet.address,
    transitAddress: row.transitAddress,
  };
  made.push({ organizationId: organizationId(), walletId: funded.walletId });
}

beforeEach(async () => {
  await newCompany();
});

const organizationId = () => paying.company.organizationId;
const account = () => paying.wallet.address;

const topUp = (atLeast = 0n) =>
  runtime.runPromise(
    startFeeCover({ organizationId: organizationId(), atLeast }),
  );

const advance = (quote: IntentQuote, on: AppRuntime = runtime) =>
  on.runPromise(advanceFeeCover(quote));

const feeCovers = (): Promise<IntentQuote[]> =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx
      .select()
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.organizationId, organizationId()),
          eq(intentQuotes.purpose, "fee_cover"),
        ),
      )
      .orderBy(intentQuotes.createdAt),
  );

const floatNow = (): Promise<bigint> =>
  runtime.runPromise(
    withScope({ organizationId: organizationId() }, (tx) =>
      recordedExpendiSurplus(
        tx,
        funded.walletId,
        undefined,
        "confidential_account",
      ),
    ),
  );

/** What 1Click was asked for the company's float. */
const askedFor = () =>
  oneClick.state.quoteRequests.filter(
    (request) =>
      request.recipient === account() &&
      request.recipientType === "CONFIDENTIAL_INTENTS" &&
      request.refundTo === relayerAccount,
  );

const updateQuote = (
  quote: IntentQuote,
  changes: Partial<typeof intentQuotes.$inferInsert>,
) =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx.update(intentQuotes).set(changes).where(eq(intentQuotes.id, quote.id)),
  );

/** Delivers Expendi's `amount` of USDC to the float, as a settled top-up would. */
const seedFloat = (amount: bigint) =>
  saveQuote(runtime, db, funded, "fee_cover", {
    amount,
    row: {
      status: "succeeded",
      settledAt: new Date(),
      depositStartedAt: new Date(),
    },
  });

/**
 * A hop paid out of the confidential account that costs `cost` beyond the
 * amount it delivers, in the given state.
 */
async function hop(
  cost: bigint,
  row: Partial<typeof intentQuotes.$inferInsert> = {},
): Promise<IntentQuote> {
  oneClick.state.costPerQuote = cost;
  const quote = await saveQuote(runtime, db, funded, "base_hop", {
    amount: 5n * USDC,
    slippageBps: 0,
    intentPaid: true,
    row,
  });
  oneClick.state.costPerQuote = 0n;
  expect(quote.amountIn - quote.amountOut).toBe(cost);
  return quote;
}

const inFlight = {
  status: "depositing",
  depositStartedAt: new Date(),
} as const;

/** The deposit address is on chain and registered, so only the transfer is broadcast. */
const registered = (quote: IntentQuote) =>
  chain.state.fundWithUsdc(quote.depositAddress, 0n);

const relayerHolds = () => chain.state.usdcBalanceOf(relayerAccount);

async function ledger() {
  return ledgerOf(db, funded);
}

describe("the gate", () => {
  it("covers a quote the float can carry, and asks 1Click for nothing", async () => {
    // #given
    await seedFloat(FEE_FLOAT_TARGET_USDC);
    const quote = await hop(4_800n);

    // #when
    const answer = await runtime.runPromise(ensureFeeCover(quote));

    // #then
    expect({ answer, asked: askedFor(), topUps: await feeCovers() }).toEqual({
      answer: "covered",
      asked: [],
      topUps: [expect.objectContaining({ status: "succeeded" })],
    });
  });

  it("waits and starts a top-up for what the float is short of, without paying it", async () => {
    // #given no float at all
    const quote = await hop(4_800n);
    const before = relayerHolds();

    // #when
    const answer = await runtime.runPromise(ensureFeeCover(quote));

    // #then it is saved for the job to pay, and the relayer hasn't moved
    const [saved] = await feeCovers();
    expect({
      answer,
      status: saved?.status,
      amountIn: saved?.amountIn,
      relayer: relayerHolds(),
      depositAddress: chain.state.usdcBalanceOf(saved?.depositAddress ?? ""),
    }).toEqual({
      answer: "waiting",
      status: "quoted",
      amountIn: FEE_FLOAT_TARGET_USDC,
      relayer: before,
      depositAddress: 0n,
    });
  });

  it("asks for more than the target when the quote needs more than that", async () => {
    // #given a quote that costs 3 USDC and a float of 0.4
    await seedFloat(400_000n);
    const quote = await hop(3n * USDC);

    // #when
    await runtime.runPromise(ensureFeeCover(quote));

    // #then the top-up brings the float to the quote's cost, not to the target
    const saved = (await feeCovers()).find(({ status }) => status === "quoted");
    expect(saved?.amountIn).toBe(3n * USDC - 400_000n);
  });

  it("covers a quote that costs nothing even when the float is below zero", async () => {
    // #given a sweep that cost more than the float held
    await seedFloat(1_000n);
    await saveQuote(runtime, db, funded, "sweep", {
      amount: 5n * USDC,
      confidential: undefined,
      row: {
        recipientType: "CONFIDENTIAL_INTENTS",
        status: "succeeded",
        settledAt: new Date(),
        swappedAmountOut: 5n * USDC - 10_000n,
      },
    });
    const free = await saveQuote(runtime, db, funded, "base_hop", {
      amount: 5n * USDC,
      slippageBps: 0,
      intentPaid: true,
    });

    // #when
    const answer = await runtime.runPromise(ensureFeeCover(free));

    // #then
    expect({
      float: (await floatNow()) < 0n,
      answer,
      topUps: (await feeCovers()).map(({ status }) => status),
    }).toEqual({ float: true, answer: "covered", topUps: ["succeeded"] });
  });

  it("doesn't let two quotes in flight spend the same float", async () => {
    // #given a float of 1 USDC, one quote in flight that costs 0.6 of it
    await seedFloat(FEE_FLOAT_TARGET_USDC);
    await hop(600_000n, inFlight);
    const second = await hop(600_000n);

    // #when
    const answer = await runtime.runPromise(ensureFeeCover(second));

    // #then the second one waits, and a top-up is started for it
    expect({
      answer,
      started: (await feeCovers()).filter(({ status }) => status === "quoted")
        .length,
    }).toEqual({ answer: "waiting", started: 1 });
  });

  it("covers the second quote once the first is no longer in flight and the float holds", async () => {
    // #given the first quote ended refunded in full, which costs nothing
    await seedFloat(FEE_FLOAT_TARGET_USDC);
    await hop(600_000n, {
      ...inFlight,
      status: "refunded",
      settledAt: new Date(),
      refundedAmount: 5n * USDC + 600_000n,
    });
    const second = await hop(600_000n);

    // #when
    const answer = await runtime.runPromise(ensureFeeCover(second));

    // #then
    expect(answer).toBe("covered");
  });
});

describe("a company whose balance is in its company wallet", () => {
  it("is never read, quoted or topped up", async () => {
    // #given
    await newCompany("company_wallet");
    const quote = await saveQuote(runtime, db, funded, "base_hop", {
      amount: 5n * USDC,
    });
    const signedIn = oneClick.state.signIns.length;
    const calls = oneClick.state.calls.length;
    const relayerBefore = relayerHolds();

    // #when
    const started = await topUp(2n * USDC);
    const answer = await runtime.runPromise(ensureFeeCover(quote));
    await runtime.runPromise(coverFees());

    // #then
    expect({
      started,
      answer,
      topUps: await feeCovers(),
      signIns: oneClick.state.signIns
        .slice(signedIn)
        .filter((signer) => signer === account()),
      oneClickCalls: oneClick.state.calls
        .slice(calls)
        .filter((call) => call.session !== undefined && call.call !== "quote"),
      relayer: relayerHolds(),
    }).toEqual({
      started: null,
      answer: "waiting",
      topUps: [],
      signIns: [],
      oneClickCalls: [],
      relayer: relayerBefore,
    });
    expect(askedFor()).toEqual([]);
  });
});

describe("the top-up quote", () => {
  it("asks 1Click for a free USDC delivery into the company's confidential account, refunding to the relayer", async () => {
    // #given
    const calls = oneClick.state.calls.length;

    // #when
    const quote = await topUp();

    // #then
    const [asked] = askedFor();
    const quoteCall = oneClick.state.calls
      .slice(calls)
      .find((call) => call.call === "quote");
    expect({
      asked: {
        dry: asked?.dry,
        swapType: asked?.swapType,
        originAsset: asked?.originAsset,
        destinationAsset: asked?.destinationAsset,
        amount: asked?.amount,
        depositType: asked?.depositType,
        recipient: asked?.recipient,
        recipientType: asked?.recipientType,
        refundTo: asked?.refundTo,
        refundType: asked?.refundType,
        slippageBps: asked?.slippageBps,
      },
      withSession: quoteCall?.session !== undefined,
      saved: {
        purpose: quote?.purpose,
        status: quote?.status,
        depositType: quote?.depositType,
        recipientType: quote?.recipientType,
        refundType: quote?.refundType,
        recipient: quote?.recipient,
        refundTo: quote?.refundTo,
        amountIn: quote?.amountIn,
        amountOut: quote?.amountOut,
        feeCoverUsdc: quote?.feeCoverUsdc,
      },
    }).toEqual({
      asked: {
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: FEE_FLOAT_TARGET_USDC,
        depositType: "ORIGIN_CHAIN",
        recipient: account(),
        recipientType: "CONFIDENTIAL_INTENTS",
        refundTo: relayerAccount,
        refundType: "ORIGIN_CHAIN",
        slippageBps: 0,
      },
      withSession: true,
      saved: {
        purpose: "fee_cover",
        status: "quoted",
        depositType: "ORIGIN_CHAIN",
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "ORIGIN_CHAIN",
        recipient: account(),
        refundTo: relayerAccount,
        amountIn: FEE_FLOAT_TARGET_USDC,
        amountOut: FEE_FLOAT_TARGET_USDC,
        feeCoverUsdc: null,
      },
    });
  });

  it.each([
    [
      "has nothing below the target to bring up",
      300_000n,
      FEE_FLOAT_TARGET_USDC - 300_000n,
      0n,
    ],
    ["needs more than the target", 0n, 4n * USDC, 4n * USDC],
  ] as const)(
    "brings a float of %s",
    async (_name, float, expected, atLeast) => {
      // #given
      if (float > 0n) await seedFloat(float);

      // #when
      const quote = await topUp(atLeast);

      // #then
      expect(quote?.amountIn).toBe(expected);
    },
  );

  it("is never less than the least worth moving", async () => {
    // #given a float just under the target
    await seedFloat(FEE_FLOAT_TARGET_USDC - 1n);

    // #when
    const quote = await topUp(1n);

    // #then
    expect(quote?.amountIn).toBe(MOVE_IN_MIN_USDC);
  });

  it("is refused when 1Click charges anything, and nothing is saved or sent", async () => {
    // #given
    oneClick.state.costPerQuote = 4_465n;
    const relayerBefore = relayerHolds();

    // #when
    const started = await topUp();

    // #then
    expect({
      started,
      topUps: await feeCovers(),
      relayer: relayerHolds(),
    }).toEqual({ started: null, topUps: [], relayer: relayerBefore });
  });

  it.each([
    [
      "has a memo",
      (quote: OneClickFirmQuote) => ({ ...quote, depositMemo: "memo" }),
    ],
    [
      "names a deposit address that isn't an implicit NEAR account",
      (quote: OneClickFirmQuote) => ({
        ...quote,
        depositAddress: "deposit.near",
      }),
    ],
    [
      "names the company's own account as its deposit address",
      (quote: OneClickFirmQuote) => ({
        ...quote,
        depositAddress: quote.depositAddress.replace(/^.{64}/, account()),
      }),
    ],
    [
      "names the relayer as its deposit address",
      (quote: OneClickFirmQuote) => ({
        ...quote,
        depositAddress: relayerAccount,
      }),
    ],
    [
      "takes a different amount in than asked",
      (quote: OneClickFirmQuote) => ({
        ...quote,
        amountIn: quote.amountIn + 1n,
      }),
    ],
    [
      "delivers less than it takes in",
      (quote: OneClickFirmQuote) => ({
        ...quote,
        amountOut: quote.amountOut - 1n,
      }),
    ],
  ])("is refused when it %s", async (_name, change) => {
    // #given
    tamper = change;

    // #when
    const started = await wrappedRuntime.runPromise(
      startFeeCover({ organizationId: organizationId(), atLeast: 0n }),
    );

    // #then
    expect({ started, topUps: await feeCovers() }).toEqual({
      started: null,
      topUps: [],
    });
  });

  it("starts nothing when 1Click won't quote", async () => {
    // #given
    oneClick.state.failNextQuotes("refused");

    // #when
    const started = await topUp();

    // #then
    expect({ started, topUps: await feeCovers() }).toEqual({
      started: null,
      topUps: [],
    });
  });

  it("starts nothing when the relayer holds less than the top-up, and doesn't ask 1Click", async () => {
    // #given
    const quotesBefore = askedFor().length;

    // #when
    const started = await topUp(relayerHolds() + 1n);

    // #then
    expect({
      started,
      topUps: await feeCovers(),
      asked: askedFor().length - quotesBefore,
    }).toEqual({ started: null, topUps: [], asked: 0 });
  });

  it("starts nothing when the company can't be signed in", async () => {
    // #given
    signInFails = true;

    // #when
    const started = await wrappedRuntime.runPromise(
      startFeeCover({ organizationId: organizationId(), atLeast: 0n }),
    );

    // #then
    expect({ started, topUps: await feeCovers() }).toEqual({
      started: null,
      topUps: [],
    });
  });
});

describe("one top-up at a time", () => {
  it.each(["quoted", "depositing", "needs_review"] as const)(
    "never starts another while one is %s",
    async (status) => {
      // #given
      const first = await topUp();
      if (!first) throw new Error("no top-up was started");
      await updateQuote(first, {
        status,
        ...(status === "quoted" ? {} : { depositStartedAt: new Date() }),
      });

      // #when
      const second = await topUp();

      // #then
      expect({ second, topUps: (await feeCovers()).length }).toEqual({
        second: null,
        topUps: 1,
      });
    },
  );

  it("saves one when two start at once, both having found none open", async () => {
    // #given each is held at 1Click's answer until the other has also checked
    beforeQuoteAnswered = barrier(2);
    const startOnWrapped = () =>
      wrappedRuntime.runPromise(
        startFeeCover({ organizationId: organizationId(), atLeast: 0n }),
      );

    // #when
    const both = await Promise.all([startOnWrapped(), startOnWrapped()]);

    // #then
    expect({
      started: both.filter((quote) => quote !== null).length,
      topUps: (await feeCovers()).length,
    }).toEqual({ started: 1, topUps: 1 });
  });

  it("starts the next once one has succeeded", async () => {
    // #given
    const first = await topUp();
    if (!first) throw new Error("no top-up was started");
    registered(first);
    const paid = await advance(first);
    oneClick.state.deliverConfidential(paid.depositAddress, paid.amountIn);
    const settled = await advance(paid);

    // #when
    const second = await topUp(2n * USDC);

    // #then
    expect({ settled: settled.status, second: second?.status }).toEqual({
      settled: "succeeded",
      second: "quoted",
    });
  });

  it.each(["refunded", "failed"] as const)(
    "rests for a short while after one ended %s, then tops up again",
    async (status) => {
      // #given
      const first = await topUp();
      if (!first) throw new Error("no top-up was started");
      await updateQuote(first, { status, settledAt: new Date() });

      // #when
      const resting = await topUp();
      await updateQuote(first, {
        settledAt: new Date(Date.now() - FEE_COVER_RETRY_AFTER_MS - 60_000),
      });
      const afterRest = await topUp();

      // #then
      expect({ resting, afterRest: afterRest?.status }).toEqual({
        resting: null,
        afterRest: "quoted",
      });
    },
  );
});

describe("paying the top-up", () => {
  it("has the relayer register the deposit address and send the amount, with no ledger entry", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    chain.state.createAccount(quote.depositAddress);
    const ledgerBefore = await ledger();
    const relayerBefore = relayerHolds();

    // #when
    const paid = await advance(quote);

    // #then
    const sends = await runInScope(
      db,
      { organizationId: organizationId() },
      (tx) =>
        tx
          .select()
          .from(companyWalletSends)
          .where(eq(companyWalletSends.organizationId, organizationId())),
    );
    expect({
      status: paid.status,
      registered: chain.state.registered.has(quote.depositAddress),
      registrationSaved: paid.depositRegistrationTxHash !== null,
      hashSaved: paid.depositTxHash !== null,
      relayer: relayerBefore - relayerHolds(),
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
      company: chain.state.usdcBalanceOf(account()),
      companySends: sends.length,
      told: oneClick.state.submitted.some(
        (entry) =>
          entry.depositAddress === quote.depositAddress &&
          entry.txHash === paid.depositTxHash,
      ),
      ledger: await ledger(),
    }).toEqual({
      status: "depositing",
      registered: true,
      registrationSaved: true,
      hashSaved: true,
      relayer: FEE_FLOAT_TARGET_USDC,
      depositAddress: FEE_FLOAT_TARGET_USDC,
      company: 100n * USDC,
      companySends: 0,
      told: true,
      ledger: ledgerBefore,
    });
  });

  it("fills the float when 1Click reports it delivered, and credits the company nothing", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    const paid = await advance(quote);
    const ledgerBefore = await ledger();
    oneClick.state.deliverConfidential(paid.depositAddress, paid.amountIn);

    // #when
    const settled = await advance(paid);
    const credited = await runtime.runPromise(
      creditSettledQuote({
        quoteId: settled.id,
        organizationId: organizationId(),
      }),
    );

    // #then
    expect({
      status: settled.status,
      float: await floatNow(),
      confidential: oneClick.state.confidentialBalances.get(account()),
      credited,
      ledger: await ledger(),
      statusCallsWithSession: oneClick.state.calls
        .filter(
          (call) =>
            call.call === "status" &&
            call.depositAddress === paid.depositAddress,
        )
        .every((call) => call.session !== undefined),
    }).toEqual({
      status: "succeeded",
      float: FEE_FLOAT_TARGET_USDC,
      confidential: FEE_FLOAT_TARGET_USDC,
      credited: "not_creditable",
      ledger: ledgerBefore,
      statusCallsWithSession: true,
    });
  });

  it("saves the relayer's hash before it is broadcast, and never sends again when the broadcast was refused", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    chain.state.nextBroadcasts("reject");
    const broadcastsBefore = chain.state.broadcasts.length;

    // #when
    const first = await advance(quote);
    const second = await advance(first);
    const third = await advance(second);

    // #then the hash was saved, one transaction was ever built, and nothing moved
    expect({
      hashSaved: first.depositTxHash !== null,
      sameHash:
        second.depositTxHash === first.depositTxHash &&
        third.depositTxHash === first.depositTxHash,
      broadcasts: chain.state.broadcasts.length - broadcastsBefore,
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
    }).toEqual({
      hashSaved: true,
      sameHash: true,
      broadcasts: 1,
      depositAddress: 0n,
    });
  });

  it("sends once when the chain doesn't show the outcome yet, and goes on when it does", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    chain.state.nextBroadcasts("withhold");
    const broadcastsBefore = chain.state.broadcasts.length;

    // #when
    const first = await advance(quote);
    const second = await advance(first);
    chain.state.release();
    const third = await advance(second);

    // #then
    expect({
      broadcasts: chain.state.broadcasts.length - broadcastsBefore,
      told: oneClick.state.submitted.filter(
        (entry) => entry.depositAddress === quote.depositAddress,
      ).length,
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
      sameHash: third.depositTxHash === first.depositTxHash,
    }).toEqual({
      broadcasts: 1,
      told: 1,
      depositAddress: FEE_FLOAT_TARGET_USDC,
      sameHash: true,
    });
  });

  it("goes on without sending again when the broadcast's reply was lost but the transfer ran", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    chain.state.nextBroadcasts("lose_reply");
    const broadcastsBefore = chain.state.broadcasts.length;

    // #when
    const first = await advance(quote);
    const second = await advance(first);

    // #then
    expect({
      broadcasts: chain.state.broadcasts.length - broadcastsBefore,
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
      told: second.depositSubmittedAt !== null,
    }).toEqual({
      broadcasts: 1,
      depositAddress: FEE_FLOAT_TARGET_USDC,
      told: true,
    });
  });

  it("sends again only because the chain shows the first transfer failed, and the deposit address gets the amount once", async () => {
    // #given a relayer that held nothing when the transfer ran
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    const held = relayerHolds();
    chain.state.balances.set(relayerAccount, 0n);
    const broadcastsBefore = chain.state.broadcasts.length;

    // #when it is funded again and the top-up is moved on
    const failed = await advance(quote);
    chain.state.balances.set(relayerAccount, held);
    const retried = await advance(failed);
    const after = await advance(retried);

    // #then
    expect({
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
      relayer: held - relayerHolds(),
      moreThanOneBroadcast:
        chain.state.broadcasts.length - broadcastsBefore > 1,
      told: after.depositSubmittedAt !== null,
    }).toEqual({
      depositAddress: FEE_FLOAT_TARGET_USDC,
      relayer: FEE_FLOAT_TARGET_USDC,
      moreThanOneBroadcast: true,
      told: true,
    });
  });

  it("sends nothing and is failed when the deadline is too close with no transfer saved", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    await updateQuote(quote, {
      status: "depositing",
      depositStartedAt: new Date(),
      deadline: new Date(Date.now() + 60_000),
    });

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
    }).toEqual({ status: "failed", depositAddress: 0n });
  });
});

describe("when the top-up can't be completed", () => {
  it("expires a quote whose deadline is too close before anything was sent", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    await updateQuote(quote, { deadline: new Date(Date.now() + 60_000) });
    const relayerBefore = relayerHolds();

    // #when
    const advanced = await advance(quote);

    // #then
    expect({ status: advanced.status, relayer: relayerHolds() }).toEqual({
      status: "expired",
      relayer: relayerBefore,
    });
  });

  it("expires a quote when the balance has moved back to the company wallet", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    await runInScope(db, { organizationId: organizationId() }, (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome: "company_wallet" })
        .where(eq(wallets.id, funded.walletId)),
    );
    const relayerBefore = relayerHolds();

    // #when
    const advanced = await advance(quote);

    // #then
    expect({ status: advanced.status, relayer: relayerHolds() }).toEqual({
      status: "expired",
      relayer: relayerBefore,
    });
  });

  it("is refunded to the relayer when 1Click refunds it, and the company is never credited", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    const paid = await advance(quote);
    const ledgerBefore = await ledger();
    oneClick.state.setStatus(paid.depositAddress, {
      status: "REFUNDED",
      depositedAmount: paid.amountIn,
      refundedAmount: paid.amountIn,
    });

    // #when
    const refunded = await advance(paid);
    const credited = await runtime.runPromise(
      creditSettledQuote({
        quoteId: refunded.id,
        organizationId: organizationId(),
      }),
    );

    // #then
    expect({
      status: refunded.status,
      refundTo: refunded.refundTo,
      refundType: refunded.refundType,
      float: await floatNow(),
      credited,
      ledger: await ledger(),
      creditRows: await runInScope(
        db,
        { organizationId: organizationId() },
        (tx) =>
          tx
            .select({ id: walletTransactions.id })
            .from(walletTransactions)
            .where(eq(walletTransactions.intentQuoteId, refunded.id)),
      ),
    }).toEqual({
      status: "refunded",
      refundTo: relayerAccount,
      refundType: "ORIGIN_CHAIN",
      float: 0n,
      credited: "not_creditable",
      ledger: ledgerBefore,
      creditRows: [],
    });
  });

  it("goes to review when 1Click reports FAILED, and blocks the next top-up", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    const paid = await advance(quote);
    oneClick.state.setStatus(paid.depositAddress, { status: "FAILED" });

    // #when
    const reviewed = await advance(paid);
    const next = await topUp();

    // #then
    expect({ status: reviewed.status, next }).toEqual({
      status: "needs_review",
      next: null,
    });
  });

  it("advances nothing, and sends nothing, when the company can't be signed in", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    signInFails = true;
    const relayerBefore = relayerHolds();

    // #when
    const advanced = await advance(quote, wrappedRuntime);

    // #then
    expect({ status: advanced.status, relayer: relayerHolds() }).toEqual({
      status: "quoted",
      relayer: relayerBefore,
    });
  });
});

describe("the job", () => {
  it("tops up a confidential company whose float is under the low mark, and pays it", async () => {
    // #given the first run saves the quote; its deposit address then exists on chain
    await runtime.runPromise(coverFees());
    const [quoted] = await feeCovers();
    if (!quoted) throw new Error("no top-up was started");
    registered(quoted);

    // #when
    await runtime.runPromise(coverFees());

    // #then
    const [saved] = await feeCovers();
    expect({
      status: saved?.status,
      amountIn: saved?.amountIn,
      depositAddress: chain.state.usdcBalanceOf(saved?.depositAddress ?? ""),
    }).toEqual({
      status: "depositing",
      amountIn: FEE_FLOAT_TARGET_USDC,
      depositAddress: FEE_FLOAT_TARGET_USDC,
    });
  });

  it("leaves a float at the low mark alone", async () => {
    // #given
    await seedFloat(FEE_FLOAT_LOW_USDC);

    // #when
    await runtime.runPromise(coverFees());

    // #then
    expect((await feeCovers()).map(({ status }) => status)).toEqual([
      "succeeded",
    ]);
  });

  it("moves on an open top-up", async () => {
    // #given
    const quote = await topUp();
    if (!quote) throw new Error("no top-up was started");
    registered(quote);
    const paid = await advance(quote);
    oneClick.state.deliverConfidential(paid.depositAddress, paid.amountIn);

    // #when
    await runtime.runPromise(coverFees());

    // #then
    expect((await feeCovers()).map(({ status }) => status)).toEqual([
      "succeeded",
    ]);
  });
});
