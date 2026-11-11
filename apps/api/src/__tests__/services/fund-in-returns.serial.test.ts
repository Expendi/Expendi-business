import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { NearUsdcPayingCompany } from "../helpers/near-usdc-payouts.js";
import { DatabaseService } from "../../db/client.js";
import { companyWalletSends, intentQuotes } from "../../db/schema/index.js";
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
