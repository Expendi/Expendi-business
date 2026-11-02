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

/** Order c0bc8726 as Paycrest returned it once refunded, trimmed. */
const REFUNDED_ORDER = {
  id: "c0bc8726-30a8-4638-9f4f-4c5e8bc2ab02",
  status: "refunded",
  direction: "offramp",
  amount: "0.777062",
  rate: "128.69",
  reference: "e7a3189b-93a4-4498-b8de-70cfc1470dab",
  transactionFee: "0.02",
  senderFee: "0",
  source: {
    type: "crypto",
    currency: "USDC",
    network: "base",
    refundAddress: "0x69685f698f002120af8185722a3c364a265bd0c3",
  },
  destination: {
    type: "fiat",
    currency: "KES",
    country: "KE",
    recipient: {
      institution: "SAFAKEPC",
      accountIdentifier: "254700000000",
      accountName: "Forced Failure",
    },
  },
  txHash: "0x2cf51a57c72d3a1e9a8c4e4797e9aa97d573f23b8489a7c5d37adc44ae61240d",
} as const;

const GATEWAY_ID =
  "0xe5f673d6acc1f3f317e121ad1c35835e3d5fc512ef1187ee757b75b0ef7835b0";

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

  it("reads an order's transaction logs, whatever their status", async () => {
    // #given
    const { paycrest } = client(() =>
      json({
        status: "success",
        data: {
          ...REFUNDED_ORDER,
          transactionLogs: [
            { status: "crypto_deposited", gateway_id: "", tx_hash: "0x01" },
            { status: "order_created", gateway_id: GATEWAY_ID },
            { status: "a_status_paycrest_adds_later", gateway_id: null },
            { gateway_id: GATEWAY_ID, created_at: "2026-11-01T22:20:35Z" },
          ],
        },
      }),
    );

    // #when
    const order = await Effect.runPromise(paycrest.getOrder(REFUNDED_ORDER.id));

    // #then
    expect(order.transactionLogs?.map((log) => log.gateway_id)).toEqual([
      "",
      GATEWAY_ID,
      null,
      GATEWAY_ID,
    ]);
  });

  it("still reads an order whose transaction logs it can't read", async () => {
    // #given
    const { paycrest } = client(() =>
      json({
        status: "success",
        data: { ...REFUNDED_ORDER, transactionLogs: [{ gateway_id: 42 }] },
      }),
    );

    // #when
    const order = await Effect.runPromise(paycrest.getOrder(REFUNDED_ORDER.id));

    // #then
    expect({ status: order.status, logs: order.transactionLogs }).toEqual({
      status: "refunded",
      logs: null,
    });
  });
});
