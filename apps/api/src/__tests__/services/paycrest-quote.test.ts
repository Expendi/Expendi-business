import { Cause, Effect, Exit, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import { kesCentsFor } from "../../services/paycrest/amounts.js";
import { quoteKesPayout } from "../../services/paycrest/quote.js";
import { makeFakePaycrest } from "../helpers/fakes.js";

const paycrest = makeFakePaycrest();

const quote = (kesCents: bigint) =>
  Effect.runPromiseExit(
    quoteKesPayout(kesCents).pipe(Effect.provide(paycrest.layer)),
  );

beforeEach(() => {
  paycrest.state.reset();
});

describe("quoteKesPayout", () => {
  it("pays KES 1,500 for a KES 1,499.50 claim, and the USDC covers it", async () => {
    // #when
    const exit = await quote(149_950n);

    // #then
    const result = Exit.isSuccess(exit) ? exit.value : null;
    expect({
      payout: result?.payoutKesCents,
      covered: result
        ? kesCentsFor(result.usdcAmount, result.rate) >= 150_000n
        : false,
    }).toEqual({ payout: 150_000n, covered: true });
  });

  it("re-quotes once more when the order size lands in another rate band", async () => {
    // #given rates fall for orders of 10 USDC or more
    paycrest.state.rateFor = (usdc) => (Number(usdc) >= 10 ? "120" : "130");

    // #when KES 1,500 is 11.54 USDC at 130, but 12.5 USDC at 120
    const exit = await quote(150_000n);

    // #then
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      rate: "120",
      usdcAmount: 12_500_000n,
    });
  });

  it("asks for the rate at most three times", async () => {
    // #given a rate that changes on every call
    let calls = 0;
    paycrest.state.rateFor = () => {
      calls += 1;
      return String(120 + calls);
    };

    // #when
    await quote(150_000n);

    // #then
    expect(paycrest.state.rateCalls).toHaveLength(3);
  });

  it("refuses an amount under Paycrest's 0.5 USDC minimum", async () => {
    // #when KES 50 is about 0.39 USDC
    const exit = await quote(5_000n);

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure?._tag).toBe("AmountTooSmall");
  });

  it("fails without a quote when Paycrest is down", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const exit = await quote(150_000n);

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure?._tag).toBe("PaycrestError");
  });
});
