import { Cause, Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { CashOutProvider } from "../../services/cash-out/provider.js";
import {
  cashOutLimitsNow,
  paycrestMinKesCents,
} from "../../services/cash-out/active-limits.js";
import { quoteKesCashOut } from "../../services/cash-out/quote.js";
import { makeFakePaycrest, makeFakePretium } from "../helpers/fakes.js";

const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();
const layer = Layer.merge(paycrest.layer, pretium.layer);

const limitsOf = (provider: CashOutProvider) =>
  Effect.runPromise(cashOutLimitsNow(provider).pipe(Effect.provide(layer)));

/** What the pay-time quote says of `kesCents`: payable, or why not. */
async function atPayTime(
  provider: CashOutProvider,
  kesCents: bigint,
): Promise<string> {
  const exit = await Effect.runPromiseExit(
    quoteKesCashOut(provider, kesCents).pipe(Effect.provide(layer)),
  );
  return Exit.isSuccess(exit)
    ? "payable"
    : (Option.getOrNull(Cause.failureOption(exit.cause))?._tag ?? "died");
}

beforeEach(() => {
  paycrest.state.reset();
  pretium.state.reset();
});

describe("paycrestMinKesCents", () => {
  it("is 0.5 USDC at the rate, rounded up to a whole shilling", () => {
    expect(paycrestMinKesCents("127.75")).toBe(6_400n);
  });

  it("is exactly 0.5 USDC when that is a whole number of shillings", () => {
    expect(paycrestMinKesCents("128")).toBe(6_400n);
  });
});

describe("cashOutLimitsNow", () => {
  it("has Pretium's fixed range without asking for a rate", async () => {
    // #when
    const limits = await limitsOf("pretium");

    // #then
    expect({
      limits,
      paycrest: paycrest.state.rateCalls,
      pretium: pretium.state.rateCalls,
    }).toEqual({
      limits: { minKesCents: 2_000n, maxKesCents: 25_000_000n },
      paycrest: [],
      pretium: 0,
    });
  });

  it("prices Paycrest's minimum at its rate for a 0.5 USDC order", async () => {
    // #given
    paycrest.state.rateFor = () => "127.75";

    // #when
    const limits = await limitsOf("paycrest");

    // #then
    expect({ limits, asked: paycrest.state.rateCalls }).toEqual({
      limits: { minKesCents: 6_400n, maxKesCents: 30_000_000n },
      asked: ["0.5"],
    });
  });

  it("leaves Paycrest's minimum unknown while its rate is unavailable", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const limits = await limitsOf("paycrest");

    // #then
    expect(limits).toEqual({ minKesCents: null, maxKesCents: 30_000_000n });
  });
});

describe("the stated limits at pay time", () => {
  it.each(["127.75", "128", "129.5", "131.123457", "99.999999"])(
    "Paycrest at %s pays its stated minimum and refuses a shilling less",
    async (rate) => {
      // #given
      paycrest.state.rateFor = () => rate;
      const { minKesCents } = await limitsOf("paycrest");
      if (minKesCents === null) throw new Error("minimum unknown");

      // #then
      expect({
        minimum: await atPayTime("paycrest", minKesCents),
        lessOne: await atPayTime("paycrest", minKesCents - 100n),
      }).toEqual({ minimum: "payable", lessOne: "AmountTooSmall" });
    },
  );

  it("Pretium pays its stated minimum and refuses a shilling less", async () => {
    // #given
    const { minKesCents } = await limitsOf("pretium");
    if (minKesCents === null) throw new Error("minimum unknown");

    // #then
    expect({
      minimum: await atPayTime("pretium", minKesCents),
      lessOne: await atPayTime("pretium", minKesCents - 100n),
    }).toEqual({ minimum: "payable", lessOne: "AmountTooSmall" });
  });

  it("Pretium pays its stated maximum and refuses a cent more", async () => {
    // #given
    const { maxKesCents } = await limitsOf("pretium");

    // #then
    expect({
      maximum: await atPayTime("pretium", maxKesCents),
      moreOne: await atPayTime("pretium", maxKesCents + 1n),
    }).toEqual({ maximum: "payable", moreOne: "AmountTooLarge" });
  });
});
