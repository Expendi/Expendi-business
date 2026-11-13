import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  intentQuotes,
  wallets,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  returnFundIns,
  startFundInReturn,
} from "../../services/intents/fund-in-return.js";
import {
  createFundIn,
  getFundIn,
  refreshOpenFundIns,
} from "../../services/intents/fund-in.js";
import { ONE_CLICK_FUND_IN_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { creditSettledQuotes } from "../../services/intents/quote-credit.js";
import { ledgerOf } from "../helpers/money-in.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

// Serial: the job walks every company wallet in the database.

const ARBITRUM_USDC = ONE_CLICK_FUND_IN_USDC_ASSET_IDS.arbitrum;
const SOLANA_USDC = ONE_CLICK_FUND_IN_USDC_ASSET_IDS.solana;

const fakes = makeNearUsdcFakes();
const { chain } = fakes;
const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let paying: NearUsdcPayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ ...fakes.layers, oneClick: oneClick.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createNearUsdcPayingCompany(runtime, db, fakes);
});

const organizationId = () => paying.company.organizationId;
const account = () => paying.wallet.address;

const run = () => runtime.runPromise(returnFundIns());

const returns = (): Promise<IntentQuote[]> =>
  runInScope(db, { organizationId: organizationId() }, (tx) =>
    tx
      .select()
      .from(intentQuotes)
      .where(
        and(
          eq(intentQuotes.organizationId, organizationId()),
          eq(intentQuotes.purpose, "fund_in_return"),
        ),
      )
      .orderBy(asc(intentQuotes.createdAt)),
  );

/** A fund-in 1Click refunded into the company's NEAR Intents account. */
async function refundedFundIn(amount = 40n * USDC) {
  const fundIn = await runtime.runPromise(
    createFundIn({
      organizationId: organizationId(),
      actor: { type: "user", id: paying.company.admin.id },
      chain: "arbitrum",
      amount,
    }),
  );
  oneClick.state.setStatus(fundIn.depositAddress, { status: "REFUNDED" });
  await runtime.runPromise(refreshOpenFundIns());
  chain.state.fundIntents(account(), ARBITRUM_USDC, amount);
  return fundIn;
}

const shown = (fundInId: string) =>
  runtime
    .runPromise(getFundIn(organizationId(), fundInId))
    .then((view) => view.status);

describe("returnFundIns", () => {
  it("returns a refunded fund-in from the company's NEAR Intents account, paid from inside NEAR Intents", async () => {
    // #given
    const fundIn = await refundedFundIn();

    // #when
    await run();

    // #then
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    const asked = oneClick.state.quotes.get(back.depositAddress)?.request;
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
      asked: {
        depositType: asked?.depositType,
        refundType: asked?.refundType,
        recipient: asked?.recipient,
        refundTo: asked?.refundTo,
        amount: asked?.amount,
      },
      saved: {
        status: back.status,
        depositType: back.depositType,
        refundType: back.refundType,
        originAsset: back.originAsset,
        paid: back.companyWalletSendId === send?.id,
      },
      send: {
        kind: send?.kind,
        tokenId: send?.tokenId,
        to: send?.receiverAccountId,
        status: send?.status,
      },
      intents: {
        company: chain.state.intentsBalanceOf(account(), ARBITRUM_USDC),
        depositAccount: chain.state.intentsBalanceOf(
          back.depositAddress,
          ARBITRUM_USDC,
        ),
      },
      shown: await shown(fundIn.id),
    }).toEqual({
      asked: {
        depositType: "INTENTS",
        refundType: "INTENTS",
        recipient: account(),
        refundTo: account(),
        amount: 40n * USDC,
      },
      saved: {
        status: "depositing",
        depositType: "INTENTS",
        refundType: "INTENTS",
        originAsset: ARBITRUM_USDC,
        paid: true,
      },
      send: {
        kind: "intents_transfer",
        tokenId: ARBITRUM_USDC,
        to: back.depositAddress,
        status: "executed",
      },
      intents: { company: 0n, depositAccount: 40n * USDC },
      shown: "returning",
    });
  });

  it("shows the fund-in as returned once 1Click delivers its return", async () => {
    // #given
    const fundIn = await refundedFundIn();
    await run();
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    oneClick.state.setStatus(back.depositAddress, { status: "SUCCESS" });

    // #when
    await run();

    // #then
    const [settled] = await returns();
    expect({
      status: settled?.status,
      shown: await shown(fundIn.id),
    }).toEqual({ status: "succeeded", shown: "returned" });
  });

  it("starts nothing while the company's NEAR Intents account is empty", async () => {
    // #when
    await run();

    // #then
    expect(await returns()).toEqual([]);
  });

  it("returns at most the wallet's per-transaction maximum at a time", async () => {
    // #given
    paying = await createNearUsdcPayingCompany(
      runtime,
      db,
      fakes,
      100n * USDC,
      10n * USDC,
    );
    chain.state.fundIntents(account(), SOLANA_USDC, 25n * USDC);

    // #when
    await run();

    // #then
    const [back] = await returns();
    expect({
      amountIn: back?.amountIn,
      left: chain.state.intentsBalanceOf(account(), SOLANA_USDC),
    }).toEqual({ amountIn: 10n * USDC, left: 15n * USDC });
  });

  it("runs one return at a time for a company", async () => {
    // #given
    chain.state.fundIntents(account(), ARBITRUM_USDC, 5n * USDC);
    chain.state.fundIntents(account(), SOLANA_USDC, 5n * USDC);

    // #when
    await run();
    await run();

    // #then
    expect((await returns()).map((back) => back.originAsset)).toEqual([
      ARBITRUM_USDC,
    ]);
  });

  it("waits before returning an asset again after its return was refunded", async () => {
    // #given
    chain.state.fundIntents(account(), ARBITRUM_USDC, 5n * USDC);
    await run();
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    oneClick.state.setStatus(back.depositAddress, { status: "REFUNDED" });
    await run();
    chain.state.fundIntents(account(), ARBITRUM_USDC, 5n * USDC);

    // #when
    await run();

    // #then
    expect((await returns()).map((quote) => quote.status)).toEqual([
      "refunded",
    ]);
  });

  it("leaves the balance where it is when 1Click won't quote the return", async () => {
    // #given
    chain.state.fundIntents(account(), ARBITRUM_USDC, 5n * USDC);
    oneClick.state.failNextQuotes("refused");

    // #when
    await runtime.runPromise(
      startFundInReturn({ organizationId: organizationId() }),
    );

    // #then
    expect({
      returns: await returns(),
      held: chain.state.intentsBalanceOf(account(), ARBITRUM_USDC),
    }).toEqual({ returns: [], held: 5n * USDC });
  });
});

describe("returnFundIns, for a company that keeps its USDC in a confidential account", () => {
  beforeEach(async () => {
    paying = await createNearUsdcPayingCompany(
      runtime,
      db,
      fakes,
      undefined,
      undefined,
      "confidential_account",
    );
  });

  const ledger = () =>
    ledgerOf(db, {
      company: paying.company,
      walletId: paying.wallet.id,
      accountId: account(),
      transitAddress: "",
    }).then((rows) => rows.filter((row) => row.intentQuoteId !== null));

  it("is quoted paid from inside NEAR Intents and delivered to the confidential account, with the company's session", async () => {
    // #given
    chain.state.fundIntents(account(), ARBITRUM_USDC, 40n * USDC);

    // #when
    await run();

    // #then
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    const asked = oneClick.state.quotes.get(back.depositAddress)?.request;
    const call = oneClick.state.calls.filter((entry) => entry.call === "quote")[
      oneClick.state.quoteRequests.findIndex(
        (request) => request.recipient === account(),
      )
    ];
    expect({
      asked: {
        depositType: asked?.depositType,
        recipientType: asked?.recipientType,
        recipient: asked?.recipient,
        refundType: asked?.refundType,
        refundTo: asked?.refundTo,
      },
      sessionSent: call?.session !== undefined,
      saved: {
        depositType: back.depositType,
        recipientType: back.recipientType,
        refundType: back.refundType,
        status: back.status,
      },
    }).toEqual({
      asked: {
        depositType: "INTENTS",
        recipientType: "CONFIDENTIAL_INTENTS",
        recipient: account(),
        refundType: "INTENTS",
        refundTo: account(),
      },
      sessionSent: true,
      saved: {
        depositType: "INTENTS",
        recipientType: "CONFIDENTIAL_INTENTS",
        refundType: "INTENTS",
        status: "depositing",
      },
    });
  });

  it("is credited when 1Click reports it delivered, for what it delivered, and not before", async () => {
    // #given
    const fundIn = await refundedFundIn();
    await run();
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    oneClick.state.deliverConfidential(back.depositAddress, 39_900_000n);

    // #when
    await run();
    const beforeCredit = await ledger();
    await runtime.runPromise(creditSettledQuotes());

    // #then
    const [settled] = await returns();
    expect({
      status: settled?.status,
      statusCalls: oneClick.state.calls
        .filter(
          (entry) =>
            entry.call === "status" &&
            entry.depositAddress === back.depositAddress,
        )
        .every((entry) => entry.session !== undefined),
      beforeCredit,
      credited: (await ledger()).map((row) => ({
        usdcAmount: row.usdcAmount,
        intentQuoteId: row.intentQuoteId,
        txHash: row.txHash,
      })),
      shown: await shown(fundIn.id),
    }).toEqual({
      status: "succeeded",
      statusCalls: true,
      beforeCredit: [],
      credited: [
        { usdcAmount: 39_900_000n, intentQuoteId: back.id, txHash: null },
      ],
      shown: "returned",
    });
  });

  it("starts nothing, and sends nothing, when the company can't be signed in", async () => {
    // #given
    chain.state.fundIntents(account(), ARBITRUM_USDC, 40n * USDC);
    fakes.privy.state.nextNearSignings("refused");

    // #when
    await runtime.runPromise(
      startFundInReturn({ organizationId: organizationId() }),
    );

    // #then
    expect({
      returns: await returns(),
      held: chain.state.intentsBalanceOf(account(), ARBITRUM_USDC),
    }).toEqual({ returns: [], held: 40n * USDC });
  });

  it("returns a refunded fund-in to the company wallet as before when the quote was made before the switch", async () => {
    // #given
    paying = await createNearUsdcPayingCompany(runtime, db, fakes);
    chain.state.fundIntents(account(), ARBITRUM_USDC, 40n * USDC);
    await run();
    await runInScope(db, { organizationId: organizationId() }, (tx) =>
      tx
        .update(wallets)
        .set({ balanceHome: "confidential_account" })
        .where(eq(wallets.id, paying.wallet.id)),
    );
    const [back] = await returns();
    if (!back) throw new Error("no return was started");
    oneClick.state.setStatus(back.depositAddress, { status: "SUCCESS" });

    // #when
    await run();
    await runtime.runPromise(creditSettledQuotes());

    // #then
    const asked = oneClick.state.quotes.get(back.depositAddress)?.request;
    expect({
      recipientType: back.recipientType,
      askedRecipientType: asked?.recipientType,
      status: (await returns())[0]?.status,
      credited: await ledger(),
      askedWithoutSession: oneClick.state.calls
        .filter(
          (entry) =>
            entry.call === "status" &&
            entry.depositAddress === back.depositAddress,
        )
        .every((entry) => entry.session === undefined),
    }).toEqual({
      recipientType: "DESTINATION_CHAIN",
      askedRecipientType: undefined,
      status: "succeeded",
      credited: [],
      askedWithoutSession: true,
    });
  });
});
