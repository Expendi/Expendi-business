import Anthropic from "@anthropic-ai/sdk";
import { Cause, ConfigProvider, Effect, Exit, Layer, Option } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ReceiptExtraction } from "../../services/extraction/receipt-extractor.js";
import type { ReceiptReply } from "../../services/extraction/receipt-schema.js";
import {
  makeClaudeReceiptExtractor,
  MAX_RECEIPT_IMAGE_BYTES,
  RECEIPT_SYSTEM_PROMPT,
  ReceiptExtractor,
  ReceiptExtractorLive,
} from "../../services/extraction/receipt-extractor.js";
import { makeFakeReceiptExtractor } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const API_KEY = "sk-ant-test-receipt-key";
const MODEL = "claude-opus-5-5";
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const JPEG_BASE64 = Buffer.from(JPEG).toString("base64");

const REPLY: ReceiptReply = {
  readable: true,
  unreadableReason: null,
  kind: "mpesa_screenshot",
  merchant: "Java House Kimathi Street",
  amount: "1,234.50",
  currency: "KES",
  date: "2026-10-30",
  mpesaCode: "SLK4H7XY2Z",
  etimsInvoiceNumber: null,
  supplierKraPin: null,
  uncertainFields: [],
};

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function message(
  text: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "msg_test_receipt",
    type: "message",
    role: "assistant",
    model: MODEL,
    content: [
      { type: "thinking", thinking: "", signature: "sig_test" },
      { type: "text", text },
    ],
    stop_reason: "end_turn",
    stop_sequence: null,
    stop_details: null,
    container: null,
    context_management: null,
    usage: {
      input_tokens: 2_600,
      output_tokens: 310,
      cache_read_input_tokens: 820,
      cache_creation_input_tokens: 0,
    },
    ...overrides,
  };
}

const json = (status: number, body: unknown) => () =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "request-id": `req_test_${status}`,
      },
    }),
  );

const replying = (reply: unknown, overrides: Record<string, unknown> = {}) =>
  json(200, message(JSON.stringify(reply), overrides));

const apiError = (status: number, type: string) =>
  json(status, {
    type: "error",
    error: { type, message: `upstream said no to ${API_KEY}` },
  });

/** Never answers; rejects once the SDK gives up on it. */
const hanging = (_url: string, init: RequestInit | undefined) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      reject(new DOMException("The operation was aborted.", "AbortError"));
    });
  });

function claude(
  respond: (url: string, init: RequestInit | undefined) => Promise<Response>,
  timeout = 5_000,
) {
  const sent: Sent[] = [];
  const client = new Anthropic({
    apiKey: API_KEY,
    maxRetries: 0,
    timeout,
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      sent.push({ url, init });
      return respond(url, init);
    },
  });
  return {
    extractor: makeClaudeReceiptExtractor(client, { model: MODEL }),
    sent,
  };
}

const extract = (
  extractor: ReturnType<typeof claude>["extractor"],
  image: { bytes: Uint8Array; mediaType: string } = {
    bytes: JPEG,
    mediaType: "image/jpeg",
  },
): Promise<ReceiptExtraction> => Effect.runPromise(extractor.extract(image));

async function failureOf<A, E>(effect: Effect.Effect<A, E>): Promise<E | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

const bodyOf = (request: Sent | undefined): Record<string, unknown> => {
  const body = request?.init?.body;
  const parsed: unknown = typeof body === "string" ? JSON.parse(body) : null;
  return typeof parsed === "object" && parsed !== null
    ? Object.fromEntries(Object.entries(parsed))
    : {};
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("makeClaudeReceiptExtractor: the request", () => {
  it("sends one message: the image, the field rules, and the reply schema", async () => {
    // #given
    const { extractor, sent } = claude(replying(REPLY));

    // #when
    await extract(extractor);

    // #then
    expect(sent).toHaveLength(1);
    const [request] = sent;
    expect(request?.url).toContain("https://api.anthropic.com/v1/messages");
    expect(new Headers(request?.init?.headers).get("anthropic-beta")).toBe(
      "server-side-fallback-2026-07-01",
    );
    expect(bodyOf(request)).toMatchObject({
      model: MODEL,
      fallbacks: "default",
      system: [
        {
          type: "text",
          text: RECEIPT_SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: {
        effort: "low",
        format: {
          type: "json_schema",
          schema: { type: "object", additionalProperties: false },
        },
      },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: JPEG_BASE64,
              },
            },
            { type: "text", text: "Read this receipt." },
          ],
        },
      ],
    });
  });
});

describe("makeClaudeReceiptExtractor: replies", () => {
  it("parses a valid reply into claim fields and keeps the raw reply", async () => {
    // #given
    const { extractor } = claude(replying(REPLY));

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toEqual({
      status: "read",
      flags: [],
      fields: {
        kind: "mpesa_screenshot",
        merchant: "Java House Kimathi Street",
        amountCents: "123450",
        currency: "KES",
        date: "2026-10-30",
        mpesaCode: "SLK4H7XY2Z",
        etimsInvoiceNumber: null,
        supplierKraPin: null,
        confidence: {
          merchant: "high",
          amount: "high",
          currency: "high",
          date: "high",
          mpesaCode: "high",
        },
      },
      raw: {
        model: MODEL,
        messageId: "msg_test_receipt",
        stopReason: "end_turn",
        reply: REPLY,
        usage: {
          inputTokens: 2_600,
          outputTokens: 310,
          cacheReadInputTokens: 820,
          cacheCreationInputTokens: 0,
        },
      },
    });
  });

  it("flags a receipt in another currency instead of reading it as KES", async () => {
    // #given
    const { extractor } = claude(
      replying({ ...REPLY, amount: "45.00", currency: "USD" }),
    );

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toMatchObject({
      status: "read",
      flags: ["currency_not_kes"],
      fields: { amountCents: "4500", currency: "USD" },
    });
  });

  it.each([
    ["an impossible date", { date: "2026-02-30" }],
    ["a date in the future", { date: "2031-10-30" }],
    ["a phone number read as the amount", { amount: "712,345,678" }],
    ["an amount with three decimals", { amount: "1,234.505" }],
  ])(
    "returns unreadable for %s, keeping the raw reply",
    async (_label, change) => {
      // #given
      const reply = { ...REPLY, ...change };
      const { extractor } = claude(replying(reply));

      // #when
      const result = await extract(extractor);

      // #then
      expect(result).toMatchObject({
        status: "unreadable",
        reason: "invalid_reply",
        raw: { reply },
      });
    },
  );

  it("returns unreadable for a reply that isn't JSON, keeping its text", async () => {
    // #given
    const { extractor } = claude(json(200, message("Total: KES 1,234.50")));

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toMatchObject({
      status: "unreadable",
      reason: "invalid_reply",
      raw: { reply: "Total: KES 1,234.50" },
    });
  });

  it("returns unreadable for a reply cut off at max_tokens", async () => {
    // #given
    const partial = JSON.stringify(REPLY).slice(0, 60);
    const { extractor } = claude(
      json(200, message(partial, { stop_reason: "max_tokens" })),
    );

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toMatchObject({
      status: "unreadable",
      reason: "incomplete_reply",
      raw: { stopReason: "max_tokens", reply: partial },
    });
  });

  it("returns unreadable when Claude declines", async () => {
    // #given
    const { extractor } = claude(
      json(
        200,
        message("", {
          content: [],
          stop_reason: "refusal",
          stop_details: { type: "refusal", category: null, explanation: null },
        }),
      ),
    );

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toMatchObject({ status: "unreadable", reason: "refused" });
  });

  it("returns Claude's own verdict when the image isn't a receipt", async () => {
    // #given
    const { extractor } = claude(
      replying({
        ...REPLY,
        readable: false,
        unreadableReason: "not_a_receipt",
        merchant: null,
        amount: null,
        date: null,
        mpesaCode: null,
      }),
    );

    // #when
    const result = await extract(extractor);

    // #then
    expect(result).toMatchObject({
      status: "unreadable",
      reason: "not_a_receipt",
    });
  });
});

describe("makeClaudeReceiptExtractor: failures", () => {
  it.each([
    [429, "rate_limit_error", "RATE_LIMITED"],
    [500, "api_error", "UNAVAILABLE"],
    [529, "overloaded_error", "UNAVAILABLE"],
    [401, "authentication_error", "NOT_CONFIGURED"],
    [404, "not_found_error", "NOT_CONFIGURED"],
    [400, "invalid_request_error", "API_ERROR"],
  ])("maps HTTP %i (%s) to %s", async (status, type, code) => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor } = claude(apiError(status, type));

    // #when
    const error = await failureOf(
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    );

    // #then
    expect(error).toMatchObject({
      _tag: "ReceiptExtractionError",
      code,
      message: `Claude answered HTTP ${status} (${type}), request req_test_${status}`,
    });
  });

  it("fails with TIMEOUT when Claude doesn't answer in time", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor } = claude(hanging, 20);

    // #when
    const error = await failureOf(
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    );

    // #then
    expect(error).toMatchObject({
      code: "TIMEOUT",
      message: "Claude didn't answer in time",
    });
  });

  it("fails with UNAVAILABLE when Claude can't be reached", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor } = claude(() =>
      Promise.reject(new TypeError("fetch failed")),
    );

    // #when
    const error = await failureOf(
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    );

    // #then
    expect(error).toMatchObject({
      code: "UNAVAILABLE",
      message: "Claude unreachable",
    });
  });

  it("keeps the key, the image and the reply out of errors and logs", async () => {
    // #given
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor } = claude(apiError(500, "api_error"));

    // #when
    const error = await failureOf(
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    );

    // #then
    const logged = [error?.message, ...warn.mock.calls.flat().map(String)].join(
      "\n",
    );
    expect(logged).toContain("HTTP 500");
    expect(logged).not.toContain(API_KEY);
    expect(logged).not.toContain(JPEG_BASE64);
    expect(logged).not.toContain("upstream said no");
  });

  it("refuses an image over the size limit without calling Claude", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor, sent } = claude(replying(REPLY));
    const bytes = new Uint8Array(MAX_RECEIPT_IMAGE_BYTES + 1);
    bytes.set(JPEG);

    // #when
    const error = await failureOf(
      extractor.extract({ bytes, mediaType: "image/jpeg" }),
    );

    // #then
    expect(error?.code).toBe("IMAGE_TOO_LARGE");
    expect(sent).toHaveLength(0);
  });

  it.each([
    ["a HEIC photo", { bytes: JPEG, mediaType: "image/heic" }],
    ["a PDF", { bytes: JPEG, mediaType: "application/pdf" }],
    ["an empty file", { bytes: new Uint8Array(), mediaType: "image/png" }],
  ])("refuses %s without calling Claude", async (_label, image) => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { extractor, sent } = claude(replying(REPLY));

    // #when
    const error = await failureOf(extractor.extract(image));

    // #then
    expect(error?.code).toBe("UNSUPPORTED_IMAGE");
    expect(sent).toHaveLength(0);
  });
});

describe("ReceiptExtractorLive", () => {
  it("starts without ANTHROPIC_API_KEY, and every receipt then fails as not set up", async () => {
    // #given
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const extractWithoutKey = Effect.flatMap(ReceiptExtractor, (extractor) =>
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    ).pipe(
      Effect.provide(
        ReceiptExtractorLive.pipe(
          Layer.provide(
            Layer.setConfigProvider(ConfigProvider.fromMap(new Map())),
          ),
        ),
      ),
    );

    // #when
    const error = await failureOf(extractWithoutKey);

    // #then
    expect(error).toMatchObject({ code: "NOT_CONFIGURED" });
    expect(warn.mock.calls.flat().join("\n")).toContain(
      "ANTHROPIC_API_KEY isn't set",
    );
  });
});

describe("the test runtime", () => {
  it("reads receipts with the fake extractor, which tests can steer", async () => {
    // #given
    const fake = makeFakeReceiptExtractor();
    fake.state.nextUnreadable("illegible");
    const runtime = makeTestRuntime({ receiptExtractor: fake.layer });
    const read = Effect.flatMap(ReceiptExtractor, (extractor) =>
      extractor.extract({ bytes: JPEG, mediaType: "image/jpeg" }),
    );

    // #when
    const outcomes = await runtime
      .runPromise(Effect.all([read, read]))
      .finally(() => runtime.dispose());

    // #then
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "unreadable",
      "read",
    ]);
    expect(fake.state.calls).toEqual([
      { mediaType: "image/jpeg", byteLength: JPEG.byteLength },
      { mediaType: "image/jpeg", byteLength: JPEG.byteLength },
    ]);
  });
});
