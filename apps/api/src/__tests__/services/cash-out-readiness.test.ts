import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";

import type { CashOutProvider } from "../../services/cash-out/provider.js";
import { cashOutProviderReadiness } from "../../services/cash-out/readiness.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { makeFakePaycrest, makeFakePretium } from "../helpers/fakes.js";

const paycrest = makeFakePaycrest();
const pretium = makeFakePretium();

const readiness = (provider: CashOutProvider) =>
  Effect.runPromise(
    cashOutProviderReadiness(provider).pipe(
      Effect.provide(Layer.merge(paycrest.layer, pretium.layer)),
    ),
  );

beforeEach(() => {
  paycrest.state.reset();
  pretium.state.reset();
});

describe("cashOutProviderReadiness for Paycrest", () => {
  it("is ready when Paycrest quotes a rate", async () => {
    expect(await readiness("paycrest")).toEqual({ ready: true, problems: [] });
  });

  it("reports Paycrest not answering", async () => {
    paycrest.state.failRate = true;
    expect(await readiness("paycrest")).toEqual({
      ready: false,
      problems: ["Paycrest didn't answer a request for its rate."],
    });
  });
});

describe("cashOutProviderReadiness for Pretium", () => {
  it("is ready when configured and settling to the pinned address", async () => {
    expect(await readiness("pretium")).toEqual({ ready: true, problems: [] });
  });

  it("accepts the pinned address in any letter case", async () => {
    pretium.state.settlementAddress =
      PRETIUM_BASE_SETTLEMENT_ADDRESS.toUpperCase().replace("0X", "0x");
    expect((await readiness("pretium")).ready).toBe(true);
  });

  it("reports a missing API key without asking Pretium anything", async () => {
    // #given
    pretium.state.configured = false;

    // #when
    const result = await readiness("pretium");

    // #then
    expect({ result, rateCalls: pretium.state.rateCalls }).toEqual({
      result: {
        ready: false,
        problems: ["Pretium's API key (PRETIUM_API_KEY) isn't set."],
      },
      rateCalls: 0,
    });
  });

  it("reports a missing signing key", async () => {
    pretium.state.signingKeyConfigured = false;
    expect(await readiness("pretium")).toEqual({
      ready: false,
      problems: [
        "Pretium's webhook signing key (PRETIUM_WEBHOOK_SIGNING_KEY) isn't set, so its callbacks can't be trusted.",
      ],
    });
  });

  it("reports a missing callback URL", async () => {
    pretium.state.callbackUrl = null;
    expect(await readiness("pretium")).toEqual({
      ready: false,
      problems: [
        "Pretium's callback URL (PRETIUM_CALLBACK_URL) isn't set, so Pretium can't report back when a cash-out finishes.",
      ],
    });
  });

  it("reports Pretium not answering for its rate", async () => {
    pretium.state.failRate = true;
    expect(await readiness("pretium")).toEqual({
      ready: false,
      problems: ["Pretium didn't answer a request for its rate."],
    });
  });

  it("reports Pretium not giving its settlement address", async () => {
    pretium.state.settlementAddress = null;
    expect(await readiness("pretium")).toEqual({
      ready: false,
      problems: ["Pretium didn't give its Base USDC settlement address."],
    });
  });

  it("reports a settlement address that isn't the pinned one", async () => {
    pretium.state.settlementAddress =
      "0x1111111111111111111111111111111111111111";
    expect(await readiness("pretium")).toEqual({
      ready: false,
      problems: [
        `Pretium's Base USDC settlement address is 0x1111111111111111111111111111111111111111, not ${PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase()} where Expendi sends cash-out USDC. Don't send cash-outs through Pretium until someone checks this.`,
      ],
    });
  });

  it("collects every problem at once", async () => {
    // #given
    pretium.state.signingKeyConfigured = false;
    pretium.state.callbackUrl = null;
    pretium.state.failRate = true;
    pretium.state.settlementAddress = null;

    // #when
    const result = await readiness("pretium");

    // #then
    expect({ ready: result.ready, count: result.problems.length }).toEqual({
      ready: false,
      count: 4,
    });
  });
});
