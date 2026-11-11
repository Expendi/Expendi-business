import { Effect, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type { FastNearSettings } from "../../services/chain/fast-near.js";
import {
  FAST_NEAR_DEFAULT_TRANSFERS_URL,
  fastNearTransfersBody,
  makeFastNear,
} from "../../services/chain/fast-near.js";
import {
  randomNearAccount,
  randomNearTxHash,
  TEST_USDC_CONTRACT,
} from "../helpers/near.js";

const SETTINGS: FastNearSettings = {
  transfersUrl: FAST_NEAR_DEFAULT_TRANSFERS_URL,
  apiKey: Option.none(),
  usdcContractId: TEST_USDC_CONTRACT,
};

interface Sent {
  readonly url: string;
  readonly method: string | undefined;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** A FastNEAR that answers every request with `answer` and records what it was sent. */
function answering(answer: unknown, status = 200) {
  const sent: Sent[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    sent.push({
      url:
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url,
      method: init?.method,
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(typeof init?.body === "string" ? init.body : "null"),
    });
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
  return { sent, fetchImpl };
}

const row = (overrides: Record<string, unknown> = {}) => ({
  block_height: 171_000_123,
  transaction_id: randomNearTxHash(),
  receipt_id: randomNearTxHash(),
  log_index: 0,
  signer_id: "intents.near",
  other_account_id: "intents.near",
  amount: "5000000",
  ...overrides,
});

const page = (
  fastNear: ReturnType<typeof makeFastNear>,
  resumeToken: string | null = null,
  accountId = randomNearAccount(),
) =>
  Effect.runPromise(
    Effect.either(
      fastNear.usdcTransfersTo({ accountId, limit: 100, resumeToken }),
    ),
  );

describe("FastNear.usdcTransfersTo", () => {
  it("asks for the USDC an account received, oldest first, from the start", async () => {
    // #given
    const { sent, fetchImpl } = answering({
      transfers: [],
      resume_token: "t0",
    });
    const accountId = randomNearAccount();

    // #when
    await page(makeFastNear(SETTINGS, fetchImpl), null, accountId);

    // #then
    expect(sent).toEqual([
      {
        url: FAST_NEAR_DEFAULT_TRANSFERS_URL,
        method: "POST",
        headers: { "content-type": "application/json" },
        body: {
          account_id: accountId,
          direction: "receiver",
          asset_id: `nep141:${TEST_USDC_CONTRACT}`,
          limit: 100,
        },
      },
    ]);
  });

  it("continues from a resume token", async () => {
    // #given
    const { sent, fetchImpl } = answering({
      transfers: [],
      resume_token: "t2",
    });

    // #when
    await page(makeFastNear(SETTINGS, fetchImpl), "t1");

    // #then
    expect(sent[0]?.body).toMatchObject({ resume_token: "t1" });
  });

  it("sends the API key as a bearer token when there is one", async () => {
    // #given
    const { sent, fetchImpl } = answering({ transfers: [] });
    const fastNear = makeFastNear(
      { ...SETTINGS, apiKey: Option.some(Redacted.make("fn-test-key")) },
      fetchImpl,
    );

    // #when
    await page(fastNear);

    // #then
    expect(sent[0]?.headers.authorization).toBe("Bearer fn-test-key");
  });

  it("returns each row and the page's resume token, hashes exactly as given", async () => {
    // #given
    const transfer = row({ block_height: "171000124", log_index: 3 });
    const { fetchImpl } = answering({
      transfers: [transfer],
      resume_token: "next",
    });

    // #when
    const result = await page(makeFastNear(SETTINGS, fetchImpl));

    // #then
    expect(result).toMatchObject({
      _tag: "Right",
      right: {
        transfers: [
          {
            blockHeight: 171_000_124n,
            transactionId: transfer.transaction_id,
            receiptId: transfer.receipt_id,
            logIndex: 3,
            signerId: "intents.near",
            otherAccountId: "intents.near",
            amount: 5_000_000n,
          },
        ],
        resumeToken: "next",
      },
    });
  });

  it("gives no resume token when the answer has none", async () => {
    // #given
    const { fetchImpl } = answering({ transfers: [], resume_token: null });

    // #when
    const result = await page(makeFastNear(SETTINGS, fetchImpl));

    // #then
    expect(result).toMatchObject({ right: { resumeToken: null } });
  });

  it.each([
    ["an HTTP error", { transfers: [] }, 503],
    ["no list of transfers", { rows: [] }, 200],
    [
      "an amount that isn't a whole number",
      { transfers: [row({ amount: "1.5" })] },
      200,
    ],
    [
      "a row without its receipt",
      { transfers: [row({ receipt_id: "" })] },
      200,
    ],
  ])("fails on %s rather than guessing", async (_name, answer, status) => {
    // #given
    const { fetchImpl } = answering(answer, status);

    // #when
    const result = await page(makeFastNear(SETTINGS, fetchImpl));

    // #then
    expect(result).toMatchObject({
      _tag: "Left",
      left: { _tag: "FastNearError" },
    });
  });

  it("never names the API key in a failure", async () => {
    // #given
    const { fetchImpl } = answering({}, 500);
    const fastNear = makeFastNear(
      { ...SETTINGS, apiKey: Option.some(Redacted.make("fn-secret-key")) },
      fetchImpl,
    );

    // #when
    const result = await page(fastNear);

    // #then
    expect(JSON.stringify(result)).not.toContain("fn-secret-key");
  });
});

describe("fastNearTransfersBody", () => {
  it.each([0, 101, 1.5])("refuses a page size of %s", (limit) => {
    expect(() =>
      fastNearTransfersBody({
        accountId: randomNearAccount(),
        usdcContractId: TEST_USDC_CONTRACT,
        limit,
        resumeToken: null,
      }),
    ).toThrow(RangeError);
  });

  it("never asks for newest first", () => {
    expect(
      fastNearTransfersBody({
        accountId: randomNearAccount(),
        usdcContractId: TEST_USDC_CONTRACT,
        limit: 1,
        resumeToken: null,
      }),
    ).not.toHaveProperty("desc");
  });
});
