import { and, eq } from "drizzle-orm";
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
  organizations,
  treasuryMoves,
  wallets,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { MOVE_IN_MIN_USDC } from "../../services/intents/confidential-account.js";
import {
  advanceMoveIn,
  MOVE_IN_RETRY_AFTER_MS,
  moveIn,
  startMoveIn,
} from "../../services/intents/move-in.js";
import {
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
  OneClickRefused,
} from "../../services/intents/one-click.js";
import { insertFundingPayout, insertOpenSend } from "../helpers/in-flight.js";
import { ledgerOf, saveQuote, saveTreasuryMove } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

// Serial: the job walks every company wallet in the database.

const fakes = makeNearUsdcFakes();
const { chain } = fakes;
const oneClick = makeFakeOneClick();

let tamper: (quote: OneClickFirmQuote) => OneClickFirmQuote = (quote) => quote;
let signInFails = false;
const wrapped: OneClickShape = {
  ...oneClick.service,
  quote: (request, session) =>
    oneClick.service
      .quote(request, session)
      .pipe(Effect.map((quote) => (quote.dry ? quote : tamper(quote)))),
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
  chain.state.fundWithUsdc(fakes.relayer.accountId, 1_000n * USDC);
  oneClick.state.costPerQuote = 0n;
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), wrappedRuntime.dispose()]);
});

afterEach(() => {
  tamper = (quote) => quote;
  signInFails = false;
  oneClick.state.costPerQuote = 0n;
});

async function newCompany(
  balance = 100n * USDC,
  perTransactionMaxUsdc?: bigint,
  balanceHome: WalletBalanceHome = "confidential_account",
) {
  paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    balance,
    perTransactionMaxUsdc,
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
}

beforeEach(async () => {
  await newCompany();
});

const organizationId = () => paying.company.organizationId;
const account = () => paying.wallet.address;

const start = () =>
  runtime.runPromise(startMoveIn({ organizationId: organizationId() }));

const advance = (quote: IntentQuote, on: AppRuntime = runtime) =>
  on.runPromise(advanceMoveIn(quote));

const moveIns = (): Promise<IntentQuote[]> =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx
      .select()
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.organizationId, organizationId()),
          eq(intentQuotes.purpose, "move_in"),
        ),
      )
      .orderBy(intentQuotes.createdAt),
  );

/** The move-in 1Click was asked for, if any. */
const askedFor = () =>
  oneClick.state.quoteRequests.filter(
    (request) =>
      request.recipient === account() &&
      request.recipientType === "CONFIDENTIAL_INTENTS",
  );

/**
 * Starts a move-in and pays it. On the real chain the USDC contract
 * registers a deposit address that doesn't exist yet; the fake chain wants
 * the account to exist, as receiving NEAR makes it.
 */
async function startAndPay(): Promise<IntentQuote> {
  const quote = await start();
  if (!quote) throw new Error("no move-in was started");
  chain.state.createAccount(quote.depositAddress);
  return advance(quote);
}

const updateWallet = (changes: Partial<typeof wallets.$inferInsert>) =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx.update(wallets).set(changes).where(eq(wallets.id, paying.wallet.id)),
  );

const updateMoveIn = (
  quote: IntentQuote,
  changes: Partial<typeof intentQuotes.$inferInsert>,
) =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx.update(intentQuotes).set(changes).where(eq(intentQuotes.id, quote.id)),
  );

describe("who is moved in", () => {
  it("never quotes or reads a company whose balance is in its company wallet", async () => {
    // #given
    await newCompany(100n * USDC, undefined, "company_wallet");
    const signedIn = oneClick.state.signIns.length;

    // #when
    const started = await start();
    await runtime.runPromise(moveIn());

    // #then
    expect({
      started,
      moveIns: await moveIns(),
      asked: askedFor(),
      signedInAs: oneClick.state.signIns
        .slice(signedIn)
        .filter((signer) => signer === account()),
    }).toEqual({ started: null, moveIns: [], asked: [], signedInAs: [] });
    expect(chain.state.usdcBalanceOf(account())).toBe(100n * USDC);
  });

  it("moves a confidential company's USDC in when the job runs", async () => {
    // #when
    await runtime.runPromise(moveIn());

    // #then
    const [saved] = await moveIns();
    expect(saved?.status).toBe("quoted");
    expect(saved?.amountIn).toBe(100n * USDC);
  });
});

describe("the quote", () => {
  it("asks 1Click for a free USDC move to the company's own confidential account, with its session", async () => {
    // #given
    const calls = oneClick.state.calls.length;

    // #when
    const quote = await start();

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
      signedInAs: oneClick.state.signIns.at(-1),
      saved: {
        purpose: quote?.purpose,
        status: quote?.status,
        recipientType: quote?.recipientType,
        depositType: quote?.depositType,
        refundType: quote?.refundType,
        recipient: quote?.recipient,
        refundTo: quote?.refundTo,
        amountIn: quote?.amountIn,
        amountOut: quote?.amountOut,
      },
    }).toEqual({
      asked: {
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: 100n * USDC,
        depositType: "ORIGIN_CHAIN",
        recipient: account(),
        recipientType: "CONFIDENTIAL_INTENTS",
        refundTo: account(),
        refundType: "ORIGIN_CHAIN",
        slippageBps: 0,
      },
      withSession: true,
      signedInAs: account(),
      saved: {
        purpose: "move_in",
        status: "quoted",
        recipientType: "CONFIDENTIAL_INTENTS",
        depositType: "ORIGIN_CHAIN",
        refundType: "ORIGIN_CHAIN",
        recipient: account(),
        refundTo: account(),
        amountIn: 100n * USDC,
        amountOut: 100n * USDC,
      },
    });
  });

  it("is refused when 1Click charges anything, and nothing is saved or sent", async () => {
    // #given
    oneClick.state.costPerQuote = 4_465n;

    // #when
    const started = await start();

    // #then
    expect({
      started,
      moveIns: await moveIns(),
      held: chain.state.usdcBalanceOf(account()),
    }).toEqual({ started: null, moveIns: [], held: 100n * USDC });
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
      startMoveIn({ organizationId: organizationId() }),
    );

    // #then
    expect({ started, moveIns: await moveIns() }).toEqual({
      started: null,
      moveIns: [],
    });
  });

  it("starts nothing when 1Click won't quote", async () => {
    // #given
    oneClick.state.failNextQuotes("refused");

    // #when
    const started = await start();

    // #then
    expect({ started, moveIns: await moveIns() }).toEqual({
      started: null,
      moveIns: [],
    });
  });
});

describe("the amount", () => {
  it("is what the company wallet holds less Expendi's recorded surplus", async () => {
    // #given a hop that was covered with more than it cost
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: {
        status: "succeeded",
        settledAt: new Date(),
        depositStartedAt: new Date(),
        feeCoverUsdc: 2n * USDC,
      },
    });
    const surplus = 2n * USDC - (hop.amountIn - hop.amountOut);

    // #when
    const quote = await start();

    // #then
    expect(quote?.amountIn).toBe(100n * USDC - surplus);
  });

  it("is split into even parts no larger than the spend cap", async () => {
    // #given
    await newCompany(100n * USDC, 40n * USDC);

    // #when
    const quote = await start();

    // #then 100 over a cap of 40 is three parts, not 40 + 40 + 20
    expect(quote?.amountIn).toBe(33_333_334n);
  });

  it("moves one part per run and the rest in the runs after", async () => {
    // #given
    await newCompany(100n * USDC, 30n * USDC);

    // #when
    const first = await startAndPay();
    oneClick.state.deliverConfidential(first.depositAddress, first.amountIn);
    const settled = await advance(first);
    const second = await start();

    // #then
    expect({
      first: first.amountIn,
      status: settled.status,
      second: second?.amountIn,
    }).toEqual({
      first: 25n * USDC,
      status: "succeeded",
      second: 25n * USDC,
    });
  });

  it("leaves dust below the minimum where it is", async () => {
    // #given
    await newCompany(MOVE_IN_MIN_USDC - 1n);

    // #when
    const started = await start();

    // #then
    expect({ started, asked: askedFor() }).toEqual({
      started: null,
      asked: [],
    });
  });

  it("moves exactly the minimum", async () => {
    // #given
    await newCompany(MOVE_IN_MIN_USDC);

    // #when
    const quote = await start();

    // #then
    expect(quote?.amountIn).toBe(MOVE_IN_MIN_USDC);
  });

  it("leaves what surplus would take it below the minimum", async () => {
    // #given
    await newCompany(3n * USDC);
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      amount: 1n * USDC,
      row: {
        status: "succeeded",
        settledAt: new Date(),
        depositStartedAt: new Date(),
        feeCoverUsdc: 3n * USDC,
      },
    });
    expect(hop.amountIn - hop.amountOut).toBeLessThan(MOVE_IN_MIN_USDC);

    // #when
    const started = await start();

    // #then
    expect(started).toBeNull();
  });
});

describe("one at a time", () => {
  it("starts nothing while a move-in is open", async () => {
    // #given
    const first = await start();

    // #when
    const second = await start();

    // #then
    expect({
      second,
      moveIns: (await moveIns()).map(({ id }) => id),
    }).toEqual({ second: null, moveIns: [first?.id] });
  });

  it("starts nothing while a move-in is in review, which waits for a person", async () => {
    // #given
    const first = await startAndPay();
    oneClick.state.setStatus(first.depositAddress, { status: "FAILED" });
    const reviewed = await advance(first);
    chain.state.fundWithUsdc(account(), first.amountIn);

    // #when
    const second = await start();

    // #then
    expect({ status: reviewed.status, second }).toEqual({
      status: "needs_review",
      second: null,
    });
  });

  it("starts the next once one has succeeded", async () => {
    // #given
    await newCompany(100n * USDC, 60n * USDC);
    const first = await startAndPay();
    oneClick.state.deliverConfidential(first.depositAddress, first.amountIn);
    await advance(first);

    // #when
    const second = await start();

    // #then
    expect(second?.id).not.toBe(first.id);
  });
});

describe("what else is moving the company wallet's USDC", () => {
  it.each([
    ["a Base hop", "base_hop"],
    ["a USDC payout", "usdc_payout"],
  ] as const)("starts nothing while %s is open", async (_name, purpose) => {
    // #given
    await saveQuote(runtime, db, funded, purpose);

    // #when
    const started = await start();

    // #then
    expect({ started, asked: askedFor() }).toEqual({
      started: null,
      asked: [],
    });
  });

  it.each([
    ["a Base hop", "depositing", "base_hop"],
    ["a Base hop", "needs_review", "base_hop"],
    ["a USDC payout", "depositing", "usdc_payout"],
    ["a USDC payout", "needs_review", "usdc_payout"],
  ] as const)(
    "isn't blocked by %s paid out of the confidential account that is %s",
    async (_name, status, purpose) => {
      // #given it never touched the company wallet
      const paidFromAccount = await saveQuote(runtime, db, funded, purpose, {
        intentPaid: true,
        row: { status, depositStartedAt: new Date() },
      });

      // #when
      const started = await start();
      await updateMoveIn(paidFromAccount, {
        status: "failed",
        settledAt: new Date(),
      });

      // #then
      expect(started?.status).toBe("quoted");
    },
  );

  it("starts nothing while a move to Treasury is open", async () => {
    // #given
    const treasuryMove = await saveTreasuryMove(db, funded);
    await saveQuote(runtime, db, funded, "to_treasury", {
      row: { treasuryMoveId: treasuryMove.id },
    });

    // #when
    const started = await start();
    // The treasury-moves job walks every company's open moves, so this one
    // must not outlive the test.
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(treasuryMoves)
          .set({ status: "failed", settledAt: new Date() })
          .where(eq(treasuryMoves.id, treasuryMove.id)),
    );

    // #then
    expect(started).toBeNull();
  });

  it.each(["reserved", "signed"] as const)(
    "starts nothing while a company wallet send is %s",
    async (status) => {
      // #given
      await insertOpenSend(db, paying, status);

      // #when
      const started = await start();

      // #then
      expect(started).toBeNull();
    },
  );

  it("starts nothing while a payout is being funded", async () => {
    // #given
    await insertFundingPayout(db, paying);

    // #when
    const started = await start();

    // #then
    expect(started).toBeNull();
  });

  it("starts nothing while payouts are paused", async () => {
    // #given
    await runInScope(db, { organizationId: organizationId() }, (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, organizationId())),
    );

    // #when
    const started = await start();

    // #then
    expect(started).toBeNull();
  });

  it("is not held by a hop that has ended", async () => {
    // #given
    await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "succeeded", settledAt: new Date() },
    });

    // #when
    const started = await start();

    // #then
    expect(started?.status).toBe("quoted");
  });
});

describe("paying the move-in", () => {
  it("sends the amount to the deposit address from the company wallet, with no ledger entry", async () => {
    // #given
    const ledgerBefore = await ledgerOf(db, funded);

    // #when
    const quote = await startAndPay();

    // #then
    const [send] = await runInScope(
      db,
      { organizationId: organizationId() },
      (tx) =>
        tx
          .select()
          .from(companyWalletSends)
          .where(eq(companyWalletSends.organizationId, organizationId())),
    );
    expect({
      status: quote.status,
      paid: quote.companyWalletSendId === send?.id,
      send: {
        kind: send?.kind,
        to: send?.receiverAccountId,
        amount: send?.usdcAmount,
        status: send?.status,
      },
      company: chain.state.usdcBalanceOf(account()),
      depositAddress: chain.state.usdcBalanceOf(quote.depositAddress),
      ledger: await ledgerOf(db, funded),
    }).toEqual({
      status: "depositing",
      paid: true,
      send: {
        kind: "transfer",
        to: quote.depositAddress,
        amount: 100n * USDC,
        status: "executed",
      },
      company: 0n,
      depositAddress: 100n * USDC,
      ledger: ledgerBefore,
    });
  });

  it("asks 1Click about the deposit with the company's session and writes no ledger entry when it succeeds", async () => {
    // #given
    const ledgerBefore = await ledgerOf(db, funded);
    const paid = await startAndPay();
    oneClick.state.deliverConfidential(paid.depositAddress, paid.amountIn);

    // #when
    const settled = await advance(paid);

    // #then
    const statusCalls = oneClick.state.calls.filter(
      (call) =>
        call.call === "status" && call.depositAddress === paid.depositAddress,
    );
    expect({
      status: settled.status,
      confidential: oneClick.state.confidentialBalances.get(account()),
      sessionOnEveryStatusCall: statusCalls.every(
        (call) => call.session !== undefined,
      ),
      told: oneClick.state.submitted.some(
        (entry) => entry.depositAddress === paid.depositAddress,
      ),
      ledger: await ledgerOf(db, funded),
    }).toEqual({
      status: "succeeded",
      confidential: 100n * USDC,
      sessionOnEveryStatusCall: true,
      told: true,
      ledger: ledgerBefore,
    });
  });

  it("expires a quote when the balance has moved back to the company wallet before the deposit", async () => {
    // #given
    const quote = await start();
    if (!quote) throw new Error("no move-in was started");
    chain.state.createAccount(quote.depositAddress);
    await updateWallet({ balanceHome: "company_wallet" });

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      held: chain.state.usdcBalanceOf(account()),
    }).toEqual({ status: "expired", held: 100n * USDC });
  });

  it("expires a quote when payouts were paused before the deposit", async () => {
    // #given
    const quote = await start();
    if (!quote) throw new Error("no move-in was started");
    chain.state.createAccount(quote.depositAddress);
    await runInScope(db, { organizationId: organizationId() }, (tx) =>
      tx
        .update(organizations)
        .set({ payoutsPaused: true })
        .where(eq(organizations.id, organizationId())),
    );

    // #when
    const advanced = await advance(quote);

    // #then
    expect({
      status: advanced.status,
      held: chain.state.usdcBalanceOf(account()),
    }).toEqual({ status: "expired", held: 100n * USDC });
  });

  it("is failed with nothing moved when the company wallet refuses the send, and rests", async () => {
    // #given the spend cap came down after the quote
    const quote = await start();
    if (!quote) throw new Error("no move-in was started");
    chain.state.createAccount(quote.depositAddress);
    await updateWallet({ perTransactionMaxUsdc: 10n * USDC });

    // #when
    const advanced = await advance(quote);
    const next = await start();

    // #then
    expect({
      status: advanced.status,
      held: chain.state.usdcBalanceOf(account()),
      next,
    }).toEqual({ status: "failed", held: 100n * USDC, next: null });
  });
});

describe("when 1Click refunds or fails the move-in", () => {
  it("rests for 30 minutes after a refund, then moves in again", async () => {
    // #given the USDC came back to the company wallet
    const paid = await startAndPay();
    oneClick.state.setStatus(paid.depositAddress, {
      status: "REFUNDED",
      refundedAmount: paid.amountIn,
    });
    const refunded = await advance(paid);
    chain.state.fundWithUsdc(account(), paid.amountIn);

    // #when
    const resting = await start();
    await updateMoveIn(refunded, {
      settledAt: new Date(Date.now() - MOVE_IN_RETRY_AFTER_MS - 60_000),
    });
    const afterRest = await start();

    // #then
    expect({
      status: refunded.status,
      resting,
      afterRest: afterRest?.status,
    }).toEqual({ status: "refunded", resting: null, afterRest: "quoted" });
  });

  it("rests for 30 minutes after a failure, then moves in again", async () => {
    // #given
    const quote = await start();
    if (!quote) throw new Error("no move-in was started");
    await updateMoveIn(quote, { status: "failed", settledAt: new Date() });

    // #when
    const resting = await start();
    await updateMoveIn(quote, {
      settledAt: new Date(Date.now() - MOVE_IN_RETRY_AFTER_MS - 60_000),
    });
    const afterRest = await start();

    // #then
    expect({ resting, afterRest: afterRest?.status }).toEqual({
      resting: null,
      afterRest: "quoted",
    });
  });

  it("sends a FAILED move-in for review and stops moving that company in", async () => {
    // #given
    const paid = await startAndPay();
    oneClick.state.setStatus(paid.depositAddress, { status: "FAILED" });

    // #when
    const reviewed = await advance(paid);
    chain.state.fundWithUsdc(account(), paid.amountIn);
    const next = await start();
    await runtime.runPromise(moveIn());

    // #then
    expect({
      status: reviewed.status,
      next,
      moveIns: (await moveIns()).map(({ status }) => status),
    }).toEqual({
      status: "needs_review",
      next: null,
      moveIns: ["needs_review"],
    });
  });
});

describe("when the company can't be signed in", () => {
  it("starts nothing", async () => {
    // #given
    signInFails = true;

    // #when
    const started = await wrappedRuntime.runPromise(
      startMoveIn({ organizationId: organizationId() }),
    );

    // #then
    expect({
      started,
      moveIns: await moveIns(),
      held: chain.state.usdcBalanceOf(account()),
    }).toEqual({ started: null, moveIns: [], held: 100n * USDC });
  });

  it("advances nothing, and sends nothing for a quote already saved", async () => {
    // #given
    const quote = await start();
    if (!quote) throw new Error("no move-in was started");
    chain.state.createAccount(quote.depositAddress);
    signInFails = true;
    const statusCalls = oneClick.state.calls.filter(
      (call) => call.call === "status",
    ).length;

    // #when
    const advanced = await advance(quote, wrappedRuntime);

    // #then
    expect({
      status: advanced.status,
      held: chain.state.usdcBalanceOf(account()),
      statusCalls:
        oneClick.state.calls.filter((call) => call.call === "status").length -
        statusCalls,
    }).toEqual({ status: "quoted", held: 100n * USDC, statusCalls: 0 });
  });
});
