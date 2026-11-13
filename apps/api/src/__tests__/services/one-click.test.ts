import type { OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { quoteHash } from "@defuse-protocol/one-click-sdk-typescript";
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted } from "effect";
import { baseEncode, KeyPair } from "near-api-js";
import { describe, expect, it } from "vitest";

import type {
  OneClickQuoteRequest,
  OneClickSignedIntent,
} from "../../services/intents/one-click.js";
import {
  makeOneClick,
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
  OneClickLive,
  oneClickQuoteBody,
} from "../../services/intents/one-click.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/one-click",
);

/** A dry quote 1Click really signed, captured from its public API. */
const realQuote = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(FIXTURES, name), "utf8"));

const COMPANY_WALLET =
  "3f9b4c1d2e5a6b7c8d9e0f1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e";
const TRANSIT_WALLET = "0x1111111111111111111111111111111111111111";
const DEPOSIT_ADDRESS = "ab".repeat(32);
const DEADLINE = new Date("2026-11-11T12:00:00.000Z");
const API_KEY = "one-click-test-key";
const SESSION_TOKEN = "company-session-token";
const SESSION = Redacted.make(SESSION_TOKEN);

const baseHop: OneClickQuoteRequest = {
  dry: false,
  swapType: "EXACT_OUTPUT",
  originAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  destinationAsset: ONE_CLICK_USDC_ASSET_IDS.base,
  amount: 5_000_000n,
  recipient: TRANSIT_WALLET,
  refundTo: COMPANY_WALLET,
  deadline: DEADLINE,
  slippageBps: 100,
};

const sweep: OneClickQuoteRequest = {
  dry: false,
  swapType: "EXACT_INPUT",
  originAsset: ONE_CLICK_USDC_ASSET_IDS.base,
  destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
  amount: 5_000_000n,
  recipient: COMPANY_WALLET,
  refundTo: TRANSIT_WALLET,
  deadline: DEADLINE,
  slippageBps: 100,
};

type Json = Record<string, unknown>;

interface QuoteParts {
  readonly quoteRequest?: Json;
  readonly quote?: Json;
}

/** 1Click's signing key in these tests, and somebody else's. */
const oneClickKey = KeyPair.fromRandom("ed25519");
const strangerKey = KeyPair.fromRandom("ed25519");

/** 1Click's answer to `request`, with `parts` laid over it, before signing. */
function quoteResponse(
  request: OneClickQuoteRequest,
  parts: QuoteParts = {},
): OneClickQuoteResponse {
  const exactOutput = request.swapType === "EXACT_OUTPUT";
  const response = {
    correlationId: "599e3b55-4e90-4f34-915b-413eda22a91c",
    timestamp: "2026-11-10T19:50:46.265Z",
    signature: "",
    quoteRequest: {
      ...oneClickQuoteBody(request),
      depositMode: "SIMPLE",
      quoteWaitingTimeMs: 0,
      ...parts.quoteRequest,
    },
    quote: {
      amountIn: exactOutput ? "5053815" : "5000000",
      minAmountIn: exactOutput ? "5003276" : "5000000",
      amountOut: exactOutput ? "5000000" : "4994525",
      minAmountOut: exactOutput ? "5000000" : "4944579",
      timeEstimate: 22,
      ...(!request.dry && {
        depositAddress: DEPOSIT_ADDRESS,
        deadline: "2026-11-11T12:00:00.000Z",
        timeWhenInactive: "2026-11-11T12:00:00.000Z",
      }),
      ...parts.quote,
    },
  };
  return JSON.parse(JSON.stringify(response)) as OneClickQuoteResponse;
}

/** `response` signed the way 1Click documents, by `key`. */
function signed(
  response: OneClickQuoteResponse,
  key: KeyPair = oneClickKey,
): OneClickQuoteResponse {
  const message = new TextEncoder().encode(quoteHash(response));
  const { signature } = key.sign(message);
  return { ...response, signature: `ed25519:${baseEncode(signature)}` };
}

interface Call {
  readonly url: URL;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

type Answer =
  | { readonly json: unknown; readonly httpStatus?: number }
  | { readonly text: string; readonly httpStatus: number }
  | { readonly fails: Error };

/** A 1Click that answers every request with `answer`. */
function oneClickAnswering(
  answer: Answer,
  options: { readonly apiKey?: string; readonly realSigner?: boolean } = {},
) {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({
      url: new URL(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
    });
    if ("fails" in answer) return Promise.reject(answer.fails);
    return Promise.resolve(
      "json" in answer
        ? new Response(JSON.stringify(answer.json), {
            status: answer.httpStatus ?? 200,
          })
        : new Response(answer.text, { status: answer.httpStatus }),
    );
  };
  const oneClick = makeOneClick(
    {
      baseUrl: "https://1click.test",
      apiKey:
        options.apiKey === undefined
          ? Option.none()
          : Option.some(Redacted.make(options.apiKey)),
      ...(!options.realSigner && {
        quoteSignerPublicKey: oneClickKey.getPublicKey().toString(),
      }),
    },
    fetchImpl,
  );
  return { oneClick, calls };
}

const failureOf = async <A, E>(effect: Effect.Effect<A, E>): Promise<E> => {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) throw new Error("expected a failure");
  const failure = Exit.isFailure(exit) && exit.cause;
  if (!failure || failure._tag !== "Fail") {
    throw new Error("expected a typed failure");
  }
  return failure.error;
};

describe("OneClick.quote", () => {
  it("asks 1Click for a quote on the assets' own chains", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering({
      json: signed(quoteResponse(baseHop)),
      httpStatus: 201,
    });

    // #when
    await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/quote");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      slippageTolerance: 100,
      originAsset:
        "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
      depositType: "ORIGIN_CHAIN",
      destinationAsset:
        "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      amount: "5000000",
      refundTo: COMPANY_WALLET,
      refundType: "ORIGIN_CHAIN",
      recipient: TRANSIT_WALLET,
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-11T12:00:00.000Z",
    });
  });

  it("asks for a deposit or a refund inside NEAR Intents when the quote says so", async () => {
    // #given
    const back = {
      ...sweep,
      originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS.arbitrum,
      recipient: COMPANY_WALLET,
      refundTo: COMPANY_WALLET,
      depositType: "INTENTS",
      refundType: "INTENTS",
    } as const;
    const { oneClick, calls } = oneClickAnswering({
      json: signed(quoteResponse(back)),
      httpStatus: 201,
    });

    // #when
    await Effect.runPromise(oneClick.quote(back));

    // #then
    expect(calls[0]?.body).toMatchObject({
      depositType: "INTENTS",
      refundTo: COMPANY_WALLET,
      refundType: "INTENTS",
      recipientType: "DESTINATION_CHAIN",
    });
  });

  it("refuses a signed quote that refunds on the origin chain when NEAR Intents was asked", async () => {
    // #given
    const fundIn = {
      ...sweep,
      refundTo: COMPANY_WALLET,
      refundType: "INTENTS",
    } as const;
    const { oneClick } = oneClickAnswering({
      json: signed(
        quoteResponse(fundIn, { quoteRequest: { refundType: "ORIGIN_CHAIN" } }),
      ),
    });

    // #when
    const error = await failureOf(oneClick.quote(fundIn));

    // #then
    expect(error).toMatchObject({
      _tag: "OneClickQuoteUntrusted",
      reason: "request_mismatch",
    });
    expect(error.message).toContain("refundType");
  });

  it("passes on how long 1Click may wait for a better quote", async () => {
    // #given
    const patient = { ...sweep, quoteWaitingTimeMs: 3_000 };
    const { oneClick, calls } = oneClickAnswering({
      json: signed(
        quoteResponse(patient, { quoteRequest: { quoteWaitingTimeMs: 3000 } }),
      ),
    });

    // #when
    await Effect.runPromise(oneClick.quote(patient));

    // #then
    expect(calls[0]?.body).toMatchObject({
      swapType: "EXACT_INPUT",
      quoteWaitingTimeMs: 3_000,
    });
  });

  it("sends the API key as X-API-Key and never as a bearer token", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: signed(quoteResponse(baseHop)) },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("sends a company's session as the bearer token beside the API key", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: signed(quoteResponse(baseHop)) },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.quote(baseHop, SESSION));

    // #then
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });

  it("asks for delivery into a confidential account when the request says so", async () => {
    // #given
    const confidential = {
      ...baseHop,
      recipient: COMPANY_WALLET,
      recipientType: "CONFIDENTIAL_INTENTS",
    } as const;
    const { oneClick, calls } = oneClickAnswering({
      json: signed(quoteResponse(confidential)),
    });

    // #when
    await Effect.runPromise(oneClick.quote(confidential, SESSION));

    // #then
    expect(calls[0]?.body).toMatchObject({
      recipientType: "CONFIDENTIAL_INTENTS",
    });
  });

  it("refuses a signed quote that delivers on the chain when a confidential account was asked", async () => {
    // #given
    const confidential = {
      ...baseHop,
      recipientType: "CONFIDENTIAL_INTENTS",
    } as const;
    const { oneClick } = oneClickAnswering({
      json: signed(
        quoteResponse(confidential, {
          quoteRequest: { recipientType: "DESTINATION_CHAIN" },
        }),
      ),
    });

    // #when
    const error = await failureOf(oneClick.quote(confidential, SESSION));

    // #then
    expect(error).toMatchObject({
      _tag: "OneClickQuoteUntrusted",
      reason: "request_mismatch",
    });
    expect(error.message).toContain("recipientType");
  });

  it("sends no authorization without an API key", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering({
      json: signed(quoteResponse(baseHop)),
    });

    // #when
    await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("returns a firm exact-output quote with its deposit address", async () => {
    // #given
    const answer = signed(quoteResponse(baseHop));
    const { oneClick } = oneClickAnswering({ json: answer });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(quote).toEqual({
      dry: false,
      swapType: "EXACT_OUTPUT",
      amountIn: 5_053_815n,
      minAmountIn: 5_003_276n,
      amountOut: 5_000_000n,
      minAmountOut: 5_000_000n,
      timeEstimateSeconds: 22,
      correlationId: "599e3b55-4e90-4f34-915b-413eda22a91c",
      depositAddress: DEPOSIT_ADDRESS,
      depositMemo: null,
      deadline: DEADLINE,
      timeWhenInactive: DEADLINE,
      signedResponse: answer,
    });
  });

  it("returns a firm exact-input quote", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: signed(quoteResponse(sweep)),
    });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(sweep));

    // #then
    expect(quote).toMatchObject({
      dry: false,
      swapType: "EXACT_INPUT",
      amountIn: 5_000_000n,
      amountOut: 4_994_525n,
      minAmountOut: 4_944_579n,
      depositAddress: DEPOSIT_ADDRESS,
    });
  });

  it("returns a dry quote without a deposit address", async () => {
    // #given
    const dry = { ...baseHop, dry: true };
    const { oneClick } = oneClickAnswering({
      json: signed(quoteResponse(dry)),
    });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(dry));

    // #then
    expect(quote.dry).toBe(true);
    expect(quote).not.toHaveProperty("depositAddress");
    expect(quote.amountIn).toBe(5_053_815n);
  });

  it.each([
    [
      "an exact-output quote from NEAR to Base",
      "dry-exact-output-near-to-base.json",
      { ...baseHop, dry: true },
      { amountIn: 5_053_815n, minAmountIn: 5_003_276n, amountOut: 5_000_000n },
    ],
    [
      "an exact-input quote from Base to NEAR",
      "dry-exact-input-base-to-near.json",
      { ...sweep, dry: true, quoteWaitingTimeMs: 3_000 },
      { amountIn: 5_000_000n, amountOut: 4_994_525n, minAmountOut: 4_944_579n },
    ],
  ])(
    "accepts %s that 1Click really signed",
    async (_name, fixture, request, amounts) => {
      // #given
      const { oneClick } = oneClickAnswering(
        { json: realQuote(fixture) },
        { realSigner: true },
      );

      // #when
      const quote = await Effect.runPromise(oneClick.quote(request));

      // #then
      expect(quote).toMatchObject({ dry: true, ...amounts });
    },
  );

  it("refuses a real quote once its recipient has been changed", async () => {
    // #given
    const tampered = realQuote("dry-exact-output-near-to-base.json") as {
      quoteRequest: Json;
    };
    const attacker = "0x2222222222222222222222222222222222222222";
    tampered.quoteRequest.recipient = attacker;
    const { oneClick } = oneClickAnswering(
      { json: tampered },
      { realSigner: true },
    );

    // #when
    const error = await failureOf(
      oneClick.quote({ ...baseHop, dry: true, recipient: attacker }),
    );

    // #then
    expect(error).toMatchObject({
      _tag: "OneClickQuoteUntrusted",
      reason: "bad_signature",
    });
  });

  it("refuses a quote signed by someone other than 1Click", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: signed(quoteResponse(baseHop), strangerKey),
    });

    // #when
    const error = await failureOf(oneClick.quote(baseHop));

    // #then
    expect(error).toMatchObject({
      _tag: "OneClickQuoteUntrusted",
      reason: "bad_signature",
    });
  });

  it.each([
    ["deposit address", { depositAddress: "cd".repeat(32) }],
    ["amount in", { amountIn: "1" }],
    ["deadline", { deadline: "2027-01-01T00:00:00.000Z" }],
  ])(
    "refuses a quote whose %s was changed after it was signed",
    async (_name, change) => {
      // #given
      const answer = signed(quoteResponse(baseHop));
      const tampered = { ...answer, quote: { ...answer.quote, ...change } };
      const { oneClick } = oneClickAnswering({ json: tampered });

      // #when
      const error = await failureOf(oneClick.quote(baseHop));

      // #then
      expect(error).toMatchObject({
        _tag: "OneClickQuoteUntrusted",
        reason: "bad_signature",
      });
    },
  );

  it.each([
    ["no signature", { signature: "" }],
    ["a signature that isn't base58", { signature: "ed25519:0OIl" }],
    ["a signature of the wrong length", { signature: "ed25519:2222" }],
  ])("refuses a quote with %s", async (_name, change) => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: { ...signed(quoteResponse(baseHop)), ...change },
    });

    // #when
    const error = await failureOf(oneClick.quote(baseHop));

    // #then
    expect(error._tag).not.toBe("OneClickRefused");
    expect(["OneClickQuoteUntrusted", "OneClickOutcomeUnknown"]).toContain(
      error._tag,
    );
  });

  it.each([
    ["recipient", { recipient: "0x2222222222222222222222222222222222222222" }],
    ["refundTo", { refundTo: "cd".repeat(32) }],
    ["amount", { amount: "4000000" }],
    ["originAsset", { originAsset: ONE_CLICK_USDC_ASSET_IDS.solana }],
    ["destinationAsset", { destinationAsset: ONE_CLICK_USDC_ASSET_IDS.solana }],
    ["swapType", { swapType: "EXACT_INPUT" }],
    ["dry", { dry: true }],
    ["deadline", { deadline: "2026-11-12T12:00:00.000Z" }],
    ["slippageTolerance", { slippageTolerance: 5_000 }],
    ["depositType", { depositType: "INTENTS" }],
    ["refundType", { refundType: "INTENTS" }],
    ["recipientType", { recipientType: "INTENTS" }],
  ])(
    "refuses a signed quote for a different %s than was asked",
    async (field, echoed) => {
      // #given
      const { oneClick } = oneClickAnswering({
        json: signed(quoteResponse(baseHop, { quoteRequest: echoed })),
      });

      // #when
      const error = await failureOf(oneClick.quote(baseHop));

      // #then
      expect(error).toMatchObject({
        _tag: "OneClickQuoteUntrusted",
        reason: "request_mismatch",
      });
      expect(error.message).toContain(field);
    },
  );

  it("refuses a signed quote that delivers a different amount than asked", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: signed(quoteResponse(baseHop, { quote: { amountOut: "4999999" } })),
    });

    // #when
    const error = await failureOf(oneClick.quote(baseHop));

    // #then
    expect(error).toMatchObject({
      _tag: "OneClickQuoteUntrusted",
      reason: "request_mismatch",
    });
  });

  it("accepts the deadline written another way", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: signed(
        quoteResponse(baseHop, {
          quoteRequest: { deadline: "2026-11-11T12:00:00Z" },
        }),
      ),
    });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(quote.dry).toBe(false);
  });

  it("keeps the deadline it asked for when 1Click's runs days later", async () => {
    // #given 1Click keeps the deposit address open three days past our deadline
    const { oneClick } = oneClickAnswering({
      json: signed(
        quoteResponse(baseHop, {
          quote: {
            deadline: new Date(
              DEADLINE.getTime() + 3 * 24 * 60 * 60_000,
            ).toISOString(),
          },
        }),
      ),
    });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(quote.dry ? null : quote.deadline).toEqual(DEADLINE);
  });

  it("keeps 1Click's deadline when it is earlier than the one asked for", async () => {
    // #given
    const earlier = new Date(DEADLINE.getTime() - 60_000);
    const { oneClick } = oneClickAnswering({
      json: signed(
        quoteResponse(baseHop, { quote: { deadline: earlier.toISOString() } }),
      ),
    });

    // #when
    const quote = await Effect.runPromise(oneClick.quote(baseHop));

    // #then
    expect(quote.dry ? null : quote.deadline).toEqual(earlier);
  });

  it("doesn't hand back a firm quote that has no deposit address", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: signed(quoteResponse(baseHop, { quote: { depositAddress: null } })),
    });

    // #when
    const error = await failureOf(oneClick.quote(baseHop));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it.each([
    [400, "recipient is not valid"],
    [401, "Unauthorized"],
    [429, "Too many requests"],
  ])("reports HTTP %i as a refusal", async (httpStatus, message) => {
    // #given
    const { oneClick } = oneClickAnswering(
      { json: { message, path: "/v0/quote" }, httpStatus },
      { apiKey: API_KEY },
    );

    // #when
    const error = await failureOf(oneClick.quote(baseHop));

    // #then
    expect(error).toMatchObject({ _tag: "OneClickRefused", httpStatus });
    expect(error.message).toContain(message);
    expect(error.message).not.toContain(API_KEY);
  });

  it.each([
    ["HTTP 500", { text: "Internal Server Error", httpStatus: 500 }],
    ["HTTP 503", { text: "", httpStatus: 503 }],
    ["a timeout", { fails: new DOMException("timed out", "TimeoutError") }],
    ["a dropped connection", { fails: new TypeError("fetch failed") }],
    ["a reply that isn't JSON", { text: "<html>", httpStatus: 200 }],
    ["a reply of another shape", { json: { quote: {} } }],
  ] satisfies [string, Answer][])(
    "reports %s as an unknown outcome",
    async (_name, answer) => {
      // #given
      const { oneClick } = oneClickAnswering(answer);

      // #when
      const error = await failureOf(oneClick.quote(baseHop));

      // #then
      expect(error._tag).toBe("OneClickOutcomeUnknown");
    },
  );
});

describe("OneClick.status", () => {
  const settled = {
    correlationId: "c1",
    status: "SUCCESS",
    updatedAt: "2026-11-10T19:51:30.000Z",
    quoteResponse: { quote: { depositAddress: DEPOSIT_ADDRESS } },
    swapDetails: {
      intentHashes: ["Fq3d"],
      nearTxHashes: [
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        "6ZMcXvGrmnEBcZLTU4wbBBmbHvNUmWUm4ou2ipVbdC1D",
      ],
      amountIn: "5003276",
      amountOut: "5000000",
      depositedAmount: "5053815",
      refundedAmount: "50539",
      refundReason: "PARTIAL_DEPOSIT",
      originChainTxHashes: [
        {
          hash: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
          explorerUrl: "",
        },
      ],
      destinationChainTxHashes: [
        { hash: `0x${"Ab".repeat(32)}`, explorerUrl: "https://basescan.org" },
      ],
    },
  };

  it("asks about one deposit address", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: settled },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.pathname).toBe("/v0/status");
    expect([...(calls[0]?.url.searchParams.entries() ?? [])]).toEqual([
      ["depositAddress", DEPOSIT_ADDRESS],
    ]);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("asks as the company when given its session", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: settled },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.status(DEPOSIT_ADDRESS, SESSION));

    // #then
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });

  it("can't be made to ask about anything else by the address", async () => {
    // #given
    const hostile = "abc&depositMemo=1#/../v0/quote";
    const { oneClick, calls } = oneClickAnswering({
      json: { ...settled, quoteResponse: {} },
    });

    // #when
    await Effect.runPromise(oneClick.status(hostile));

    // #then
    expect(calls[0]?.url.pathname).toBe("/v0/status");
    expect([...(calls[0]?.url.searchParams.entries() ?? [])]).toEqual([
      ["depositAddress", hostile],
    ]);
  });

  it("reads a settled swap, keeping every hash exactly as given", async () => {
    // #given
    const { oneClick } = oneClickAnswering({ json: settled });

    // #when
    const status = await Effect.runPromise(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(status).toEqual({
      status: "SUCCESS",
      updatedAt: new Date("2026-11-10T19:51:30.000Z"),
      depositedAmount: 5_053_815n,
      amountIn: 5_003_276n,
      amountOut: 5_000_000n,
      refundedAmount: 50_539n,
      refundReason: "PARTIAL_DEPOSIT",
      nearTxHashes: [
        "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
        "6ZMcXvGrmnEBcZLTU4wbBBmbHvNUmWUm4ou2ipVbdC1D",
      ],
      originChainTxHashes: ["9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"],
      destinationChainTxHashes: [`0x${"Ab".repeat(32)}`],
    });
  });

  it.each([
    [
      "null",
      {
        amountIn: null,
        amountOut: null,
        depositedAmount: null,
        refundedAmount: null,
        refundReason: null,
      },
    ],
    ["missing", {}],
  ])(
    "reads a swap in progress whose amounts are %s",
    async (_name, amounts) => {
      // #given
      const { oneClick } = oneClickAnswering({
        json: {
          status: "PROCESSING",
          updatedAt: "2026-11-10T19:51:00.000Z",
          swapDetails: {
            intentHashes: [],
            nearTxHashes: [],
            originChainTxHashes: [],
            destinationChainTxHashes: [],
            ...amounts,
          },
        },
      });

      // #when
      const status = await Effect.runPromise(oneClick.status(DEPOSIT_ADDRESS));

      // #then
      expect(status).toEqual({
        status: "PROCESSING",
        updatedAt: new Date("2026-11-10T19:51:00.000Z"),
        depositedAmount: null,
        amountIn: null,
        amountOut: null,
        refundedAmount: null,
        refundReason: null,
        nearTxHashes: [],
        originChainTxHashes: [],
        destinationChainTxHashes: [],
      });
    },
  );

  it.each([
    ["PENDING_DEPOSIT"],
    ["KNOWN_DEPOSIT_TX"],
    ["INCOMPLETE_DEPOSIT"],
    ["PROCESSING"],
    ["SUCCESS"],
    ["REFUNDED"],
    ["FAILED"],
  ] as const)("knows the status %s", async (reported) => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: { status: reported, swapDetails: {} },
    });

    // #when
    const status = await Effect.runPromise(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(status.status).toBe(reported);
  });

  it.each([
    ["a status it doesn't know", { status: "SETTLING", swapDetails: {} }],
    ["no swap details", { status: "SUCCESS" }],
    [
      "an amount that isn't a whole number",
      { status: "SUCCESS", swapDetails: { amountOut: "5.0" } },
    ],
    [
      "a negative amount",
      { status: "REFUNDED", swapDetails: { refundedAmount: "-1" } },
    ],
    [
      "another deposit address",
      {
        ...settled,
        quoteResponse: { quote: { depositAddress: "cd".repeat(32) } },
      },
    ],
  ])("doesn't guess at an answer with %s", async (_name, json) => {
    // #given
    const { oneClick } = oneClickAnswering({ json });

    // #when
    const error = await failureOf(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it("reports a deposit address 1Click doesn't know as a refusal", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: { message: "Deposit address not found" },
      httpStatus: 404,
    });

    // #when
    const error = await failureOf(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(error).toMatchObject({ _tag: "OneClickRefused", httpStatus: 404 });
  });

  it("reports a server error as an unknown outcome", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      text: "bad gateway",
      httpStatus: 502,
    });

    // #when
    const error = await failureOf(oneClick.status(DEPOSIT_ADDRESS));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });
});

describe("OneClick.submitDeposit", () => {
  const TX_HASH = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";

  it("tells 1Click which transaction paid the deposit address", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering({
      json: { status: "KNOWN_DEPOSIT_TX" },
    });

    // #when
    await Effect.runPromise(oneClick.submitDeposit(DEPOSIT_ADDRESS, TX_HASH));

    // #then
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/deposit/submit");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({
      txHash: TX_HASH,
      depositAddress: DEPOSIT_ADDRESS,
    });
  });

  it("reports a refusal", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: { message: "Deposit address not found" },
      httpStatus: 400,
    });

    // #when
    const error = await failureOf(
      oneClick.submitDeposit(DEPOSIT_ADDRESS, TX_HASH),
    );

    // #then
    expect(error).toMatchObject({ _tag: "OneClickRefused", httpStatus: 400 });
  });

  it("reports a lost reply as an unknown outcome", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      fails: new DOMException("timed out", "TimeoutError"),
    });

    // #when
    const error = await failureOf(
      oneClick.submitDeposit(DEPOSIT_ADDRESS, TX_HASH),
    );

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });
});

const fixtureLegs = (
  JSON.parse(
    readFileSync(path.join(FIXTURES, "confidential-intents.json"), "utf8"),
  ) as { legs: { generated: Json }[] }
).legs;

const SIGNED_INTENT: OneClickSignedIntent = {
  standard: "nep413",
  payload: {
    message: '{"signer_id":"abc","deadline":"2026-11-16T08:19:27.521Z"}',
    nonce: "Vij2xgDhEPMXQKrcWrR46BiC3wIETEPvXnOFhLItR5w=",
    recipient: "intents.far",
  },
  public_key: "ed25519:11111111111111111111111111111111",
  signature: "ed25519:2222222222222222222222222222222222222222222222",
};

const failureCases = [
  ["a refusal", { json: { message: "Invalid token" }, httpStatus: 401 }],
  ["HTTP 500", { text: "Internal Server Error", httpStatus: 500 }],
  ["a timeout", { fails: new DOMException("timed out", "TimeoutError") }],
] satisfies [string, Answer][];

describe("OneClick.authenticate", () => {
  const answer = {
    accessToken: "access-secret",
    refreshToken: "refresh-secret",
    expiresIn: 900,
    refreshExpiresIn: 86_400,
  };

  it("signs in with the signed intent and sends the partner key alone", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: answer },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.authenticate(SIGNED_INTENT));

    // #then
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/auth/authenticate");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toEqual({ signedData: SIGNED_INTENT });
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(calls[0]?.headers).not.toHaveProperty("authorization");
  });

  it("counts the session's lifetime from when the answer arrived and drops the refresh token", async () => {
    // #given
    const { oneClick } = oneClickAnswering({ json: answer });
    const before = Date.now();

    // #when
    const result = await Effect.runPromise(
      oneClick.authenticate(SIGNED_INTENT),
    );

    // #then
    const after = Date.now();
    expect(Redacted.value(result.session)).toBe("access-secret");
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 900_000);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(after + 900_000);
    expect(Object.keys(result).sort()).toEqual(["expiresAt", "session"]);
    expect(JSON.stringify(result)).not.toContain("refresh-secret");
    expect(JSON.stringify(result)).not.toContain("access-secret");
  });

  it.each([
    ["no access token", { expiresIn: 900 }],
    ["no lifetime", { accessToken: "a" }],
  ])("doesn't guess at an answer with %s", async (_name, json) => {
    // #given
    const { oneClick } = oneClickAnswering({ json });

    // #when
    const error = await failureOf(oneClick.authenticate(SIGNED_INTENT));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it.each(failureCases)("reports %s", async (_name, reply) => {
    // #given
    const { oneClick } = oneClickAnswering(reply);

    // #when
    const error = await failureOf(oneClick.authenticate(SIGNED_INTENT));

    // #then
    expect(error._tag).toBe(
      "httpStatus" in reply && reply.httpStatus === 401
        ? "OneClickRefused"
        : "OneClickOutcomeUnknown",
    );
  });
});

describe("OneClick.balances", () => {
  it("reads the company's private balances with its session", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      {
        json: {
          balances: [
            { tokenId: "nep141:usdc", available: "1500000", source: "private" },
            { tokenId: "nep141:other", available: "0", source: "private" },
          ],
        },
      },
      { apiKey: API_KEY },
    );

    // #when
    const balances = await Effect.runPromise(oneClick.balances(SESSION));

    // #then
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/account/balances");
    expect(calls[0]?.body).toBeNull();
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(balances).toEqual([
      { tokenId: "nep141:usdc", available: 1_500_000n },
      { tokenId: "nep141:other", available: 0n },
    ]);
  });

  it.each([
    ["an amount that isn't a whole number", { tokenId: "t", available: "1.5" }],
    ["no token", { available: "1" }],
  ])("doesn't guess at a balance with %s", async (_name, balance) => {
    // #given
    const { oneClick } = oneClickAnswering({ json: { balances: [balance] } });

    // #when
    const error = await failureOf(oneClick.balances(SESSION));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it.each(failureCases)("reports %s", async (_name, reply) => {
    // #given
    const { oneClick } = oneClickAnswering(reply);

    // #when
    const error = await failureOf(oneClick.balances(SESSION));

    // #then
    expect(error._tag).toBe(
      "httpStatus" in reply && reply.httpStatus === 401
        ? "OneClickRefused"
        : "OneClickOutcomeUnknown",
    );
  });
});

describe("OneClick.generateIntent", () => {
  const input = { depositAddress: DEPOSIT_ADDRESS, signerId: COMPANY_WALLET };
  const generated = (): { intent: { standard: string; payload: Json } } =>
    structuredClone(fixtureLegs[0]?.generated) as {
      intent: { standard: string; payload: Json };
    };

  it("asks for a swap transfer message with the session", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: generated() },
      { apiKey: API_KEY },
    );

    // #when
    await Effect.runPromise(oneClick.generateIntent(input, SESSION));

    // #then
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/generate-intent");
    expect(calls[0]?.body).toEqual({
      type: "swap_transfer",
      standard: "nep413",
      signerId: COMPANY_WALLET,
      depositAddress: DEPOSIT_ADDRESS,
    });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
  });

  it.each(fixtureLegs.map((leg, index) => [index, leg.generated] as const))(
    "returns the payload 1Click generated, byte for byte (fixture leg %i)",
    async (_index, body) => {
      // #given
      const { oneClick } = oneClickAnswering({ json: body });

      // #when
      const intent = await Effect.runPromise(
        oneClick.generateIntent(input, SESSION),
      );

      // #then
      const expected = (body as { intent: { payload: Json } }).intent.payload;
      expect(intent).toEqual(expected);
      expect(intent.message).toBe(expected.message);
    },
  );

  it("rejects a payload with a key beyond message, nonce and recipient", async () => {
    // #given
    const body = generated();
    body.intent.payload.callbackUrl = "https://attacker.example";
    const { oneClick } = oneClickAnswering({ json: body });

    // #when
    const error = await failureOf(oneClick.generateIntent(input, SESSION));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
    expect(error.message).toContain("unexpected shape");
  });

  it("rejects a standard other than nep413", async () => {
    // #given
    const body = generated();
    body.intent.standard = "erc191";
    const { oneClick } = oneClickAnswering({ json: body });

    // #when
    const error = await failureOf(oneClick.generateIntent(input, SESSION));

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it.each(failureCases)("reports %s", async (_name, reply) => {
    // #given
    const { oneClick } = oneClickAnswering(reply);

    // #when
    const error = await failureOf(oneClick.generateIntent(input, SESSION));

    // #then
    expect(error._tag).toBe(
      "httpStatus" in reply && reply.httpStatus === 401
        ? "OneClickRefused"
        : "OneClickOutcomeUnknown",
    );
  });
});

describe("OneClick.submitIntent", () => {
  const accepted = { intentHash: "Fq3dHash", correlationId: "c1" };

  it("posts the signed intent with the session and returns its hash", async () => {
    // #given
    const { oneClick, calls } = oneClickAnswering(
      { json: accepted },
      { apiKey: API_KEY },
    );

    // #when
    const result = await Effect.runPromise(
      oneClick.submitIntent(SIGNED_INTENT, SESSION),
    );

    // #then
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url.href).toBe("https://1click.test/v0/submit-intent");
    expect(calls[0]?.body).toEqual({
      type: "swap_transfer",
      signedData: SIGNED_INTENT,
    });
    expect(calls[0]?.headers.authorization).toBe(`Bearer ${SESSION_TOKEN}`);
    expect(calls[0]?.headers["x-api-key"]).toBe(API_KEY);
    expect(result).toEqual({ intentHash: "Fq3dHash" });
  });

  it("doesn't guess at an answer without an intent hash", async () => {
    // #given
    const { oneClick } = oneClickAnswering({ json: { correlationId: "c1" } });

    // #when
    const error = await failureOf(
      oneClick.submitIntent(SIGNED_INTENT, SESSION),
    );

    // #then
    expect(error._tag).toBe("OneClickOutcomeUnknown");
  });

  it.each(failureCases)("reports %s", async (_name, reply) => {
    // #given
    const { oneClick } = oneClickAnswering(reply);

    // #when
    const error = await failureOf(
      oneClick.submitIntent(SIGNED_INTENT, SESSION),
    );

    // #then
    expect(error._tag).toBe(
      "httpStatus" in reply && reply.httpStatus === 401
        ? "OneClickRefused"
        : "OneClickOutcomeUnknown",
    );
  });

  it("never puts the session in an error", async () => {
    // #given
    const { oneClick } = oneClickAnswering({
      json: { message: "Invalid token" },
      httpStatus: 401,
    });

    // #when
    const error = await failureOf(
      oneClick.submitIntent(SIGNED_INTENT, SESSION),
    );

    // #then
    expect(error.message).not.toContain(SESSION_TOKEN);
  });
});

describe("OneClickLive", () => {
  it("needs no configuration", async () => {
    // #given
    const noEnvironment = Layer.setConfigProvider(
      ConfigProvider.fromMap(new Map()),
    );

    // #when
    const oneClick = await Effect.runPromise(
      OneClick.pipe(
        Effect.provide(OneClickLive.pipe(Layer.provide(noEnvironment))),
      ),
    );

    // #then
    expect(oneClick.quote).toBeTypeOf("function");
  });
});
