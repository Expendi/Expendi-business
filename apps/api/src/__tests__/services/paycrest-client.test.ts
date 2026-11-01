import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type { PaycrestError } from "../../services/paycrest/paycrest-client.js";
import { makePaycrest } from "../../services/paycrest/paycrest-client.js";

const API_KEY = "pc_live_secret_key";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function client(respond: () => Promise<Response>) {
  const sent: Sent[] = [];
  const paycrest = makePaycrest(
    {
      apiKey: Redacted.make(API_KEY),
      apiSecret: Redacted.make("pc_secret"),
      baseUrl: "https://api.paycrest.test/v2/",
    },
    (input, init) => {
      sent.push({
        url: input instanceof Request ? input.url : String(input),
        init,
      });
      return respond();
    },
  );
  return { paycrest, sent };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

async function failureOf<A>(
  effect: Effect.Effect<A, PaycrestError>,
): Promise<PaycrestError | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

const ORDER_REQUEST = {
  amount: "11.656824",
  amountIn: "crypto",
  rate: "128.68",
  reference: "payout-1",
  transactionFeePayer: "customer",
  source: {
    type: "crypto",
    currency: "USDC",
    network: "base",
    refundAddress: "0x1111111111111111111111111111111111111111",
  },
  destination: {
    type: "fiat",
    currency: "KES",
    country: "KE",
    providerIds: ["kVMyxKfB"],
    recipient: {
      institution: "SAFAKEPC",
      accountIdentifier: "254712345678",
      accountName: "Jane Wanjiku",
      memo: "Expendi Business payout",
    },
  },
} as const;

describe("makePaycrest", () => {
  it("reads the sell rate for a USDC amount, authenticating with the API key", async () => {
    // #given
    const { paycrest, sent } = client(() =>
      json({
        status: "success",
        data: { sell: { rate: "128.68", providerIds: ["kVMyxKfB"] } },
      }),
    );

    // #when
    const rate = await Effect.runPromise(paycrest.rate("11.656824"));

    // #then
    expect({
      rate,
      url: sent[0]?.url,
      apiKey: new Headers(sent[0]?.init?.headers).get("API-Key"),
    }).toEqual({
      rate: { rate: "128.68", providerIds: ["kVMyxKfB"] },
      url: "https://api.paycrest.test/v2/rates/base/USDC/11.656824/KES?side=sell",
      apiKey: API_KEY,
    });
  });

  it("treats a lost reply to an order as ambiguous: the order may exist", async () => {
    // #given
    const { paycrest } = client(() =>
      Promise.reject(new Error("socket hang up")),
    );

    // #when
    const failure = await failureOf(paycrest.createOrder(ORDER_REQUEST));

    // #then
    expect(failure).toMatchObject({ code: "TRANSPORT_ERROR", ambiguous: true });
  });

  it("treats a 5xx to an order as ambiguous", async () => {
    const { paycrest } = client(() => json({ status: "error" }, 502));
    expect(await failureOf(paycrest.createOrder(ORDER_REQUEST))).toMatchObject({
      status: 502,
      ambiguous: true,
    });
  });

  it("treats a 4xx to an order as a definite refusal", async () => {
    const { paycrest } = client(() => json({ status: "error" }, 400));
    expect(await failureOf(paycrest.createOrder(ORDER_REQUEST))).toMatchObject({
      status: 400,
      ambiguous: false,
    });
  });

  it("treats an order reply it can't read as ambiguous", async () => {
    const { paycrest } = client(() =>
      json({ status: "success", data: { id: 7 } }),
    );
    expect(await failureOf(paycrest.createOrder(ORDER_REQUEST))).toMatchObject({
      code: "INVALID_RESPONSE",
      ambiguous: true,
    });
  });

  it("never marks a failed read as ambiguous", async () => {
    const { paycrest } = client(() => Promise.reject(new Error("timeout")));
    expect(await failureOf(paycrest.getOrder("order-1"))).toMatchObject({
      ambiguous: false,
    });
  });

  it("rejects amounts with more than 6 decimals rather than rounding them", async () => {
    // #given
    const { paycrest } = client(() =>
      json({ data: { sell: { rate: "128.6812345", providerIds: ["p"] } } }),
    );

    // #when
    const failure = await failureOf(paycrest.rate("1"));

    // #then
    expect(failure?.code).toBe("INVALID_RESPONSE");
  });

  it("keeps the API key out of error messages", async () => {
    const { paycrest } = client(() => json({}, 401));
    const failure = await failureOf(paycrest.getOrder("order-1"));
    expect(failure?.message).not.toContain(API_KEY);
  });
});
