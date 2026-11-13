import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { CashOutProvider } from "../../services/cash-out/provider.js";
import {
  AmountTooLarge,
  cashOutLimits,
  cashOutRate,
  quoteKesCashOut,
} from "../../services/cash-out/quote.js";
import { kesCentsFor } from "../../services/paycrest/amounts.js";
import { quoteKesPayout } from "../../services/paycrest/quote.js";
import { MAX_KES_PER_ORDER_CENTS } from "../../services/payroll/split.js";
import { makeFakePaycrest, makeFakePretium } from "../helpers/fakes.js";

const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
const layer = Layer.merge(paycrest.layer, pretium.layer);

const quote = (provider: CashOutProvider, kesCents: bigint) =>
  Effect.runPromiseExit(
    quoteKesCashOut(provider, kesCents).pipe(Effect.provide(layer)),
  );

const failureTag = (exit: Exit.Exit<unknown, { _tag: string }>) =>
  Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))?._tag
    : null;

beforeEach(() => {
  paycrest.state.reset();
  pretium.state.reset();
});

describe("cashOutRate", () => {
  it("probes Paycrest with 1 USDC, as Paycrest quotes do", async () => {
    // #given
    paycrest.state.rateFor = () => "128.5";

    // #when
    const rate = await Effect.runPromise(
      cashOutRate("paycrest").pipe(Effect.provide(layer)),
    );

    // #then
    expect({ rate, probes: paycrest.state.rateCalls }).toEqual({
      rate: "128.5",
      probes: ["1"],
    });
  });

  it("asks Pretium for its rate", async () => {
    pretium.state.rate = "129.5";
    expect(
      await Effect.runPromise(
        cashOutRate("pretium").pipe(Effect.provide(layer)),
      ),
    ).toBe("129.5");
  });
});

describe("quoteKesCashOut through Pretium", () => {
  it("rounds the payout up to a shilling and the USDC up to a micro-USDC", async () => {
    // #given KES 1,500 / 129.5 = 11.583011583… USDC
    pretium.state.rate = "129.5";

    // #when
    const exit = await quote("pretium", 149_950n);

    // #then
    const result = Exit.isSuccess(exit) ? exit.value : null;
    expect({
      result,
      covered: result
        ? kesCentsFor(result.usdcAmount, result.rate) >= 150_000n
        : false,
      oneLessShort: result
        ? kesCentsFor(result.usdcAmount - 1n, result.rate) < 150_000n
        : false,
    }).toEqual({
      result: {
        requestedKesCents: 149_950n,
        payoutKesCents: 150_000n,
        usdcAmount: 11_583_012n,
        rate: "129.5",
        providerIds: [],
      },
      covered: true,
      oneLessShort: true,
    });
  });

  it("takes no extra USDC when the rate divides exactly", async () => {
    pretium.state.rate = "125";
    const exit = await quote("pretium", 250_000n);
    expect(Exit.isSuccess(exit) && exit.value.usdcAmount).toBe(20_000_000n);
  });

  it("allows Pretium's KES 20 minimum and KES 250,000 maximum", async () => {
    const exits = await Promise.all([
      quote("pretium", 2_000n),
      quote("pretium", 25_000_000n),
    ]);
    expect(exits.map(Exit.isSuccess)).toEqual([true, true]);
  });

  it("allows KES 19.50, since it pays out as KES 20", async () => {
    const exit = await quote("pretium", 1_950n);
    expect(Exit.isSuccess(exit) && exit.value.payoutKesCents).toBe(2_000n);
  });

  it("refuses less than KES 20 as too small", async () => {
    expect(failureTag(await quote("pretium", 1_900n))).toBe("AmountTooSmall");
  });

  it("refuses more than KES 250,000 as too large", async () => {
    // #when
    const exit = await quote("pretium", 25_000_001n);

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure).toEqual(
      new AmountTooLarge({
        payoutKesCents: 25_000_100n,
        maxKesCents: 25_000_000n,
      }),
    );
  });

  it("fails without a quote when Pretium is down", async () => {
    pretium.state.failRate = true;
    expect(failureTag(await quote("pretium", 150_000n))).toBe("PretiumError");
  });
});

describe("quoteKesCashOut through Paycrest", () => {
  it("is exactly today's Paycrest quote", async () => {
    // #given rates fall for orders of 10 USDC or more
    paycrest.state.rateFor = (usdc) => (Number(usdc) >= 10 ? "120" : "130");

    // #when
    const viaCashOut = await quote("paycrest", 150_000n);
    const callsViaCashOut = [...paycrest.state.rateCalls];
    paycrest.state.rateCalls.length = 0;
    const direct = await Effect.runPromiseExit(
      quoteKesPayout(150_000n).pipe(Effect.provide(paycrest.layer)),
    );

    // #then
    expect({
      viaCashOut,
      callsViaCashOut,
      pretiumRateAsked: pretium.state.rateCalls,
    }).toEqual({
      viaCashOut: direct,
      callsViaCashOut: paycrest.state.rateCalls,
      pretiumRateAsked: 0,
    });
  });

  it("keeps Paycrest's 0.5 USDC minimum", async () => {
    expect(failureTag(await quote("paycrest", 5_000n))).toBe("AmountTooSmall");
  });
});

describe("cashOutLimits", () => {
  it("states each provider's limits in KES cents", () => {
    expect({
      paycrest: cashOutLimits("paycrest"),
      pretium: cashOutLimits("pretium"),
    }).toEqual({
      paycrest: { minKesCents: null, maxKesCents: MAX_KES_PER_ORDER_CENTS },
      pretium: { minKesCents: 2_000n, maxKesCents: 25_000_000n },
    });
  });
});
