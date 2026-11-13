import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { PayeeChain } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { WalletBalanceHome } from "../../db/schema/wallets.js";
import type { AppRuntime } from "../../runtime.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes, wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../../services/intents/one-click.js";
import { openCompanyQuote } from "../../services/intents/quote-deposit.js";
import { settleOpenQuotes } from "../helpers/confidential-delivery.js";
import {
  createNearUsdcPayingCompany,
  makeNearUsdcFakes,
} from "../helpers/near-usdc-payouts.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { USDC } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const fakes = makeNearUsdcFakes();
const oneClick = makeFakeOneClick();
oneClick.state.costPerQuote = 0n;

let runtime: AppRuntime;
let db: Database;
const opened: FundedCompany[] = [];

beforeAll(async () => {
  runtime = makeTestRuntime(
    { ...fakes.layers, oneClick: oneClick.layer },
    fakes.env,
  );
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

afterEach(async () => {
  oneClick.state.costPerQuote = 0n;
  for (const company of opened.splice(0)) await settleOpenQuotes(db, company);
});

async function company(balanceHome: WalletBalanceHome, cap?: bigint) {
  const paying = await createNearUsdcPayingCompany(
    runtime,
    db,
    fakes,
    100n * USDC,
    cap,
    balanceHome,
  );
  const funded: FundedCompany = {
    company: paying.company,
    walletId: paying.wallet.id,
    accountId: paying.wallet.address,
    transitAddress: "",
  };
  opened.push(funded);
  return { paying, funded };
}

const open = (
  organizationId: string,
  destinationChain: PayeeChain,
  amountOut = 5n * USDC,
) =>
  runtime.runPromiseExit(
    openCompanyQuote({
      organizationId,
      quoteKey: `delivery:${crypto.randomUUID()}`,
      purpose: "usdc_payout",
      destinationChain,
      recipient: "0x1111111111111111111111111111111111111111",
      amountOut,
      link: () => Effect.void,
    }),
  );

const failureOf = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) && exit.cause._tag === "Fail" ? exit.cause.error : exit;

const lastRequest = () => {
  const request = oneClick.state.quoteRequests.at(-1);
  if (!request) throw new Error("1Click was asked nothing");
  return request;
};

const lastQuoteCall = () => {
  const call = oneClick.state.calls
    .filter((entry) => entry.call === "quote")
    .at(-1);
  if (!call) throw new Error("no quote call");
  return call;
};

describe("openCompanyQuote for a company whose USDC is in a confidential account", () => {
  it.each(["base", "solana"] as const)(
    "takes an exact-output quote to %s paid from and refunding into the account, with the company's session",
    async (chain) => {
      // #given
      const { paying } = await company("confidential_account");

      // #when
      const exit = await open(paying.company.organizationId, chain);

      // #then
      expect(Exit.isSuccess(exit)).toBe(true);
      expect({
        request: lastRequest(),
        session: lastQuoteCall().session !== undefined,
        saved:
          Exit.isSuccess(exit) &&
          (({
            swapType,
            depositType,
            refundType,
            recipientType,
            refundTo,
          }) => ({
            swapType,
            depositType,
            refundType,
            recipientType,
            refundTo,
          }))(exit.value),
      }).toMatchObject({
        request: {
          swapType: "EXACT_OUTPUT",
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS[chain],
          refundTo: paying.wallet.address,
          depositType: "CONFIDENTIAL_INTENTS",
          refundType: "CONFIDENTIAL_INTENTS",
          slippageBps: 10,
        },
        session: true,
        saved: {
          swapType: "EXACT_OUTPUT",
          depositType: "CONFIDENTIAL_INTENTS",
          refundType: "CONFIDENTIAL_INTENTS",
          recipientType: "DESTINATION_CHAIN",
          refundTo: paying.wallet.address,
        },
      });
    },
  );

  it("takes an exact-input quote for a payee on NEAR, which delivers what it takes in", async () => {
    // #given
    const { paying } = await company("confidential_account");

    // #when
    const exit = await open(paying.company.organizationId, "near", 5n * USDC);

    // #then
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      swapType: "EXACT_INPUT",
      amountIn: 5n * USDC,
      amountOut: 5n * USDC,
      depositType: "CONFIDENTIAL_INTENTS",
      destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
    });
    expect(lastRequest()).toMatchObject({
      swapType: "EXACT_INPUT",
      amount: 5n * USDC,
      slippageBps: 0,
    });
  });

  it("refuses a NEAR quote that costs anything", async () => {
    // #given 1Click charges for the move
    const { paying } = await company("confidential_account");
    oneClick.state.costPerQuote = 4_465n;

    // #when
    const exit = await open(paying.company.organizationId, "near");

    // #then
    expect(failureOf(exit)).toMatchObject({
      _tag: "QuoteNotOpened",
      reason: "untrusted",
    });
  });

  it("is not opened when the company can't be signed in", async () => {
    // #given
    const { paying } = await company("confidential_account");
    fakes.privy.state.nextNearSignings("refused");
    const askedBefore = oneClick.state.quoteRequests.length;

    // #when
    const exit = await open(paying.company.organizationId, "base");

    // #then
    expect({
      failure: failureOf(exit),
      asked: oneClick.state.quoteRequests.length - askedBefore,
    }).toMatchObject({
      failure: { _tag: "QuoteNotOpened", reason: "one_click_unavailable" },
      asked: 0,
    });
  });

  it("still refuses a quote over the wallet's per-transaction maximum", async () => {
    // #given
    const { paying } = await company("confidential_account", 1n * USDC);

    // #when
    const exit = await open(paying.company.organizationId, "base", 5n * USDC);

    // #then
    expect(failureOf(exit)).toMatchObject({
      _tag: "QuoteNotOpened",
      reason: "over_cap",
    });
  });
});

describe("openCompanyQuote for every other company", () => {
  it("sends the request it always sent, with no session", async () => {
    // #given
    const { paying } = await company("company_wallet");

    // #when
    const exit = await open(paying.company.organizationId, "base");

    // #then
    expect(Exit.isSuccess(exit)).toBe(true);
    expect(lastRequest()).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
      destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
      amount: 5n * USDC,
      recipient: "0x1111111111111111111111111111111111111111",
      refundTo: paying.wallet.address,
      deadline: expect.any(Date) as Date,
      slippageBps: 10,
    });
    expect(lastQuoteCall().session).toBeUndefined();
    const [saved] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select()
          .from(intentQuotes)
          .where(eq(intentQuotes.walletId, paying.wallet.id)),
    );
    expect(saved).toMatchObject({
      depositType: "ORIGIN_CHAIN",
      refundType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
    });
  });

  it("refuses a payee on NEAR, which a company wallet pays by a direct transfer", async () => {
    // #given
    const { paying } = await company("company_wallet");
    const askedBefore = oneClick.state.quoteRequests.length;

    // #when
    const exit = await open(paying.company.organizationId, "near");

    // #then
    expect({
      failure: failureOf(exit),
      asked: oneClick.state.quoteRequests.length - askedBefore,
    }).toMatchObject({
      failure: { _tag: "QuoteNotOpened", reason: "unsupported_route" },
      asked: 0,
    });
  });

  it("returns the quote already saved under its key, whatever the wallet's balance home is now", async () => {
    // #given a quote opened for a company that was then switched
    const { paying, funded } = await company("confidential_account");
    const quoteKey = `delivery:${crypto.randomUUID()}`;
    const again = () =>
      runtime.runPromise(
        openCompanyQuote({
          organizationId: paying.company.organizationId,
          quoteKey,
          purpose: "usdc_payout",
          destinationChain: "base",
          recipient: "0x1111111111111111111111111111111111111111",
          amountOut: 5n * USDC,
          link: () => Effect.void,
        }),
      );
    const first = await again();
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(wallets)
          .set({ balanceHome: "company_wallet" })
          .where(eq(wallets.id, funded.walletId)),
    );
    const askedBefore = oneClick.state.quoteRequests.length;

    // #when
    const second = await again();

    // #then
    expect({
      sameQuote: second.id === first.id,
      depositType: second.depositType,
      asked: oneClick.state.quoteRequests.length - askedBefore,
    }).toEqual({
      sameQuote: true,
      depositType: "CONFIDENTIAL_INTENTS",
      asked: 0,
    });
  });
});
