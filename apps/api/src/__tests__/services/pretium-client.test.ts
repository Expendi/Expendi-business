import { createHmac } from "node:crypto";
import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { describe, expect, it } from "vitest";

import type {
  PretiumError,
  PretiumPayRequest,
  PretiumSettings,
} from "../../services/pretium/pretium-client.js";
import { makePretium } from "../../services/pretium/pretium-client.js";

const API_KEY = "pretium_live_secret_key";
const SIGNING_KEY = "pretium_signing_key";
const CALLBACK_URL = "https://api.expendi.test/webhooks/pretium";
const TX_HASH =
  "0x2cf51a57c72d3a1e9a8c4e4797e9aa97d573f23b8489a7c5d37adc44ae61240d";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

type Responder = (sent: Sent) => Promise<Response>;

function client(
  respond: Responder,
  overrides: Partial<Omit<PretiumSettings, "fetch">> = {},
) {
  const sent: Sent[] = [];
  const pretium = makePretium({
    apiKey: Redacted.make(API_KEY),
    baseUrl: "https://api.pretium.test/",
    signingKey: Redacted.make(SIGNING_KEY),
    callbackUrl: CALLBACK_URL,
    now: () => new Date("2026-11-13T10:00:00Z"),
    ...overrides,
    fetch: (input, init) => {
      const request = {
        url: input instanceof Request ? input.url : String(input),
        init,
      };
      sent.push(request);
      return respond(request);
    },
  });
  return { pretium, sent };
}

const json = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );

const text = (body: string, status: number) =>
  Promise.resolve(new Response(body, { status }));

function bodyOf(sent: Sent | undefined): unknown {
  const body = sent?.init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON body");
  return JSON.parse(body);
}

async function failureOf<A>(
  effect: Effect.Effect<A, PretiumError>,
): Promise<PretiumError | null> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? Option.getOrNull(Cause.failureOption(exit.cause))
    : null;
}

const MOBILE_PAY: PretiumPayRequest = {
  recipient: {
    type: "MOBILE",
    shortcode: "254712345678",
    mobileNetwork: "Safaricom",
  },
  amountShillings: 1_500n,
  transactionHash: TX_HASH,
  reference: "payout-1",
};

const ACCEPTED = {
  code: 200,
  message: "Disburse initiated",
  data: { status: "PENDING", transaction_code: "TSALX", message: "Queued" },
};

const STATUS_TRANSACTION = {
  transaction_code: "DCS3E45D",
  status: "COMPLETE",
  amount: "287541",
  receipt_number: "TI292XGAY9",
  public_name: "PUBLIC NAME",
  transaction_hash: null,
  message: "Transaction processed successfully.",
  currency_code: "KES",
};

describe("makePretium transport", () => {
  it("POSTs JSON with the API key header and refuses redirects", async () => {
    // #given
    const { pretium, sent } = client(() =>
      json({ code: 200, data: { buying_rate: 129.5, selling_rate: 131.2 } }),
    );

    // #when
    await Effect.runPromise(pretium.rate());

    // #then
    const headers = new Headers(sent[0]?.init?.headers);
    expect({
      url: sent[0]?.url,
      method: sent[0]?.init?.method,
      apiKey: headers.get("x-api-key"),
      contentType: headers.get("content-type"),
      redirect: sent[0]?.init?.redirect,
      hasSignal: sent[0]?.init?.signal instanceof AbortSignal,
      body: bodyOf(sent[0]),
    }).toEqual({
      url: "https://api.pretium.test/v1/exchange-rate",
      method: "POST",
      apiKey: API_KEY,
      contentType: "application/json",
      redirect: "error",
      hasSignal: true,
      body: { currency_code: "KES" },
    });
  });

  it("keeps the API key out of error messages", async () => {
    const { pretium } = client(() => json({ message: API_KEY }, 401));
    const failure = await failureOf(pretium.rate());
    expect({
      message: failure?.message.includes(API_KEY),
      code: failure?.code,
    }).toEqual({ message: false, code: "HTTP_401" });
  });

  it("never marks a failed read as ambiguous", async () => {
    const { pretium } = client(() => Promise.reject(new Error("timeout")));
    expect(await failureOf(pretium.status("DCS3E45D"))).toMatchObject({
      code: "TRANSPORT_ERROR",
      ambiguous: false,
    });
  });
});

describe("makePretium without an API key", () => {
  it("fails every call as not configured, without calling Pretium", async () => {
    // #given
    const { pretium, sent } = client(() => json(ACCEPTED), { apiKey: null });

    // #when
    const failures = await Promise.all([
      failureOf(pretium.rate()),
      failureOf(pretium.baseSettlementAddress()),
      failureOf(pretium.banks()),
      failureOf(pretium.pay(MOBILE_PAY)),
      failureOf(pretium.status("TSALX")),
      failureOf(
        pretium.findByHash({ txHash: TX_HASH, since: new Date("2026-11-12") }),
      ),
      failureOf(pretium.refund(TX_HASH)),
    ]);

    // #then
    expect({
      codes: failures.map((failure) => failure?.code),
      ambiguous: failures.some((failure) => failure?.ambiguous !== false),
      calls: sent.length,
      configured: pretium.configured,
    }).toEqual({
      codes: Array.from({ length: 7 }, () => "NOT_CONFIGURED"),
      ambiguous: false,
      calls: 0,
      configured: false,
    });
  });
});

describe("rate", () => {
  it("prefers the quoted rate", async () => {
    const { pretium } = client(() =>
      json({ code: 200, data: { quoted_rate: "130.25", buying_rate: 129.5 } }),
    );
    expect(await Effect.runPromise(pretium.rate())).toBe("130.25");
  });

  it("falls back to the buying rate", async () => {
    const { pretium } = client(() =>
      json({
        code: 200,
        message: "Exchange rates",
        data: { buying_rate: 129.5, selling_rate: 131.2 },
      }),
    );
    expect(await Effect.runPromise(pretium.rate())).toBe("129.5");
  });

  it.each([129.4567891, "129.4567891"])(
    "rounds a rate with more than 6 decimals down, so Expendi never sends less USDC (%s)",
    async (rate) => {
      const { pretium } = client(() =>
        json({ code: 200, data: { buying_rate: rate } }),
      );
      expect(await Effect.runPromise(pretium.rate())).toBe("129.456789");
    },
  );

  it("rejects a rate that rounds down to zero", async () => {
    const { pretium } = client(() =>
      json({ code: 200, data: { buying_rate: "0.0000009" } }),
    );
    expect((await failureOf(pretium.rate()))?.code).toBe("INVALID_RESPONSE");
  });

  it.each([
    ["an overflowing number", '{"code":200,"data":{"buying_rate":1e400}}'],
    ["Infinity", '{"code":200,"data":{"buying_rate":Infinity}}'],
    ["NaN", '{"code":200,"data":{"buying_rate":NaN}}'],
  ])("rejects %s for a rate", async (_, body) => {
    const { pretium } = client(() =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    expect(await failureOf(pretium.rate())).toMatchObject({
      code: "INVALID_RESPONSE",
      ambiguous: false,
    });
  });

  it("rejects a zero rate", async () => {
    const { pretium } = client(() =>
      json({ code: 200, data: { buying_rate: 0 } }),
    );
    expect((await failureOf(pretium.rate()))?.code).toBe("INVALID_RESPONSE");
  });
});

describe("baseSettlementAddress", () => {
  it("picks Base's USDC settlement wallet, lowercased", async () => {
    // #given
    const { pretium, sent } = client(() =>
      json({
        code: 200,
        data: {
          networks: [
            {
              name: "Celo",
              settlement_wallet_address:
                "0x1111111111111111111111111111111111111111",
              assets: [{ name: "USDC" }],
            },
            {
              name: "BASE",
              settlement_wallet_address:
                "0x2222222222222222222222222222222222222222",
              assets: [{ name: "USDT" }],
            },
            {
              name: "base",
              settlement_wallet_address:
                "0x8005ee53E57aB11E11eAA4EFe07Ee3835Dc02F98",
              assets: [{ name: "USDT" }, { name: "USDC" }],
            },
          ],
        },
      }),
    );

    // #when
    const address = await Effect.runPromise(pretium.baseSettlementAddress());

    // #then
    expect({
      address,
      url: sent[0]?.url,
      body: bodyOf(sent[0]),
    }).toEqual({
      address: "0x8005ee53e57ab11e11eaa4efe07ee3835dc02f98",
      url: "https://api.pretium.test/account/detail",
      body: {},
    });
  });

  it("fails, not ambiguously, when Base has no USDC wallet", async () => {
    const { pretium } = client(() =>
      json({
        code: 200,
        data: {
          networks: [
            {
              name: "Celo",
              settlement_wallet_address:
                "0x1111111111111111111111111111111111111111",
              assets: [{ name: "USDC" }],
            },
          ],
        },
      }),
    );
    expect(await failureOf(pretium.baseSettlementAddress())).toMatchObject({
      code: "NO_BASE_SETTLEMENT_ADDRESS",
      ambiguous: false,
    });
  });

  it("rejects a Base wallet that isn't an EVM address", async () => {
    const { pretium } = client(() =>
      json({
        code: 200,
        data: {
          networks: [
            {
              name: "Base",
              settlement_wallet_address: "0x8005ee53e57ab11e",
              assets: [{ name: "USDC" }],
            },
          ],
        },
      }),
    );
    expect(await failureOf(pretium.baseSettlementAddress())).toMatchObject({
      code: "NO_BASE_SETTLEMENT_ADDRESS",
      ambiguous: false,
    });
  });
});

describe("banks", () => {
  it("reads numeric codes as strings and leaves names as sent", async () => {
    // #given the live reply's shape
    const { pretium } = client(() =>
      json({
        code: 200,
        message: "Supported Banks",
        data: [
          { Name: "Equity Bank", Code: 247247, PesalinkCode: "0068" },
          { Name: "I&amp;M Bank", Code: 542542, PesalinkCode: "0057" },
        ],
      }),
    );

    // #when
    const banks = await Effect.runPromise(pretium.banks());

    // #then
    expect(banks).toEqual([
      { code: "247247", name: "Equity Bank" },
      { code: "542542", name: "I&amp;M Bank" },
    ]);
  });

  it("lists Pretium's KES banks", async () => {
    const { pretium, sent } = client(() =>
      json({
        code: 200,
        data: [
          { Code: "68", Name: "Equity Bank" },
          { Code: "1", Name: "KCB" },
        ],
      }),
    );
    expect({
      banks: await Effect.runPromise(pretium.banks()),
      url: sent[0]?.url,
      body: bodyOf(sent[0]),
    }).toEqual({
      banks: [
        { code: "68", name: "Equity Bank" },
        { code: "1", name: "KCB" },
      ],
      url: "https://api.pretium.test/v1/banks/KES",
      body: {},
    });
  });
});

describe("pay", () => {
  it.each<[string, PretiumPayRequest["recipient"], Record<string, unknown>]>([
    [
      "an M-Pesa number",
      { type: "MOBILE", shortcode: "254712345678", mobileNetwork: "Safaricom" },
      { shortcode: "254712345678", mobile_network: "Safaricom" },
    ],
    [
      "a Till",
      { type: "BUY_GOODS", shortcode: "123456" },
      { shortcode: "123456" },
    ],
    [
      "a Paybill",
      { type: "PAYBILL", shortcode: "888880", accountNumber: "ACC-12" },
      { shortcode: "888880", account_number: "ACC-12" },
    ],
    [
      "a bank account",
      {
        type: "BANK_TRANSFER",
        accountNumber: "0123456789",
        bankCode: "247247",
      },
      { account_number: "0123456789", bank_code: "247247" },
    ],
  ])("sends %s with every fixed field", async (_name, recipient, fields) => {
    // #given
    const { pretium, sent } = client(() => json(ACCEPTED));

    // #when
    await Effect.runPromise(pretium.pay({ ...MOBILE_PAY, recipient }));

    // #then
    expect({ url: sent[0]?.url, body: bodyOf(sent[0]) }).toEqual({
      url: "https://api.pretium.test/v1/pay/KES",
      body: {
        type: recipient.type,
        ...fields,
        amount: 1500,
        fee: 0,
        chain: "BASE",
        transaction_hash: TX_HASH,
        callback_url: CALLBACK_URL,
        reference: "payout-1",
      },
    });
  });

  it("leaves the callback out when none is configured", async () => {
    const { pretium, sent } = client(() => json(ACCEPTED), {
      callbackUrl: null,
    });
    await Effect.runPromise(pretium.pay(MOBILE_PAY));
    expect(bodyOf(sent[0])).not.toHaveProperty("callback_url");
  });

  it("returns the transaction code of an accepted payment", async () => {
    const { pretium } = client(() => json(ACCEPTED));
    expect(await Effect.runPromise(pretium.pay(MOBILE_PAY))).toEqual({
      transactionCode: "TSALX",
      status: "PENDING",
    });
  });

  it("refuses to send an amount that isn't a positive whole number of shillings", async () => {
    const { pretium, sent } = client(() => json(ACCEPTED));
    const failure = await failureOf(
      pretium.pay({ ...MOBILE_PAY, amountShillings: 0n }),
    );
    expect({ failure, calls: sent.length }).toMatchObject({
      failure: { code: "INVALID_REQUEST", ambiguous: false },
      calls: 0,
    });
  });

  it.each<[string, Responder, { code: string; ambiguous: boolean }]>([
    [
      "a 400",
      () => json({ code: 400, message: "Invalid shortcode" }, 400),
      { code: "HTTP_400", ambiguous: false },
    ],
    [
      "a 422",
      () => json({ code: 422, message: "Unprocessable" }, 422),
      { code: "HTTP_422", ambiguous: false },
    ],
    [
      "a 400 saying the hash was already processed",
      () =>
        json(
          {
            code: 400,
            message: "Transaction hash has Already Been Processed",
          },
          400,
        ),
      { code: "HASH_ALREADY_PROCESSED", ambiguous: false },
    ],
    [
      "a 2xx whose status is FAILED",
      () =>
        json({
          code: 200,
          data: { status: "FAILED", transaction_code: "TSALX" },
        }),
      { code: "PAY_FAILED", ambiguous: false },
    ],
    [
      "a 2xx with no transaction code",
      () => json({ code: 200, data: { status: "PENDING" } }),
      { code: "NO_TRANSACTION_CODE", ambiguous: false },
    ],
    [
      "a 500",
      () => json({ code: 500, message: "Server error" }, 500),
      { code: "HTTP_500", ambiguous: true },
    ],
    [
      "a 502 it can't read",
      () => text("<html>Bad gateway</html>", 502),
      { code: "HTTP_502", ambiguous: true },
    ],
    [
      "a 2xx it can't read",
      () => text("<html>OK</html>", 200),
      { code: "INVALID_RESPONSE", ambiguous: true },
    ],
    [
      "a lost reply",
      () => Promise.reject(new Error("socket hang up")),
      { code: "TRANSPORT_ERROR", ambiguous: true },
    ],
    [
      "a timeout",
      () =>
        Promise.reject(
          new DOMException("The operation timed out.", "TimeoutError"),
        ),
      { code: "TRANSPORT_ERROR", ambiguous: true },
    ],
  ])("classifies %s", async (_name, respond, expected) => {
    const { pretium } = client(respond);
    expect(await failureOf(pretium.pay(MOBILE_PAY))).toMatchObject(expected);
  });

  it("calls Pretium once even when the reply is lost", async () => {
    const { pretium, sent } = client(() =>
      Promise.reject(new Error("socket hang up")),
    );
    await failureOf(pretium.pay(MOBILE_PAY));
    expect(sent).toHaveLength(1);
  });
});

describe("status", () => {
  it("reads a transaction by its code", async () => {
    // #given
    const { pretium, sent } = client(() =>
      json({ code: 200, data: STATUS_TRANSACTION }),
    );

    // #when
    const transaction = await Effect.runPromise(pretium.status("DCS3E45D"));

    // #then
    expect({
      transaction,
      url: sent[0]?.url,
      body: bodyOf(sent[0]),
    }).toEqual({
      transaction: {
        transactionCode: "DCS3E45D",
        status: "COMPLETE",
        amount: "287541",
        receiptNumber: "TI292XGAY9",
        publicName: "PUBLIC NAME",
        transactionHash: null,
        message: "Transaction processed successfully.",
      },
      url: "https://api.pretium.test/v1/status/KES",
      body: { transaction_code: "DCS3E45D" },
    });
  });

  it("lowercases the transaction hash", async () => {
    const { pretium } = client(() =>
      json({
        code: 200,
        data: {
          ...STATUS_TRANSACTION,
          transaction_hash: TX_HASH.toUpperCase(),
        },
      }),
    );
    const transaction = await Effect.runPromise(pretium.status("DCS3E45D"));
    expect(transaction.transactionHash).toBe(TX_HASH);
  });
});

describe("findByHash", () => {
  const listing =
    (byStartDate: Record<string, readonly unknown[]>): Responder =>
    (sent) => {
      const { start_date } = bodyOf(sent) as { start_date: string };
      return json({ code: 200, data: byStartDate[start_date] ?? [] });
    };

  it("walks 3-day windows from the given day to tomorrow in UTC", async () => {
    // #given
    const { pretium, sent } = client(listing({}));

    // #when
    const found = await Effect.runPromise(
      pretium.findByHash({
        txHash: TX_HASH,
        since: new Date("2026-11-06T23:30:00Z"),
      }),
    );

    // #then
    expect({
      found,
      urls: new Set(sent.map((call) => call.url)),
      windows: sent.map(bodyOf),
    }).toEqual({
      found: null,
      urls: new Set(["https://api.pretium.test/v1/transactions/KES"]),
      windows: [
        { start_date: "2026-11-06", end_date: "2026-11-08" },
        { start_date: "2026-11-09", end_date: "2026-11-11" },
        { start_date: "2026-11-12", end_date: "2026-11-14" },
      ],
    });
  });

  it("matches the hash case-insensitively among other products' transactions, and stops there", async () => {
    // #given
    const { pretium, sent } = client(
      listing({
        "2026-11-09": [
          {
            ...STATUS_TRANSACTION,
            transaction_code: "OTHER1",
            transaction_hash: `0x${"ab".repeat(32)}`,
          },
          { unrelated: "shape", transaction_hash: 42 },
          {
            ...STATUS_TRANSACTION,
            transaction_code: "OURS",
            transaction_hash: TX_HASH.toUpperCase().replace("0X", "0x"),
          },
        ],
      }),
    );

    // #when
    const found = await Effect.runPromise(
      pretium.findByHash({
        txHash: TX_HASH,
        since: new Date("2026-11-06T00:00:00Z"),
      }),
    );

    // #then
    expect({
      code: found?.transactionCode,
      hash: found?.transactionHash,
      calls: sent.length,
    }).toEqual({ code: "OURS", hash: TX_HASH, calls: 2 });
  });

  it("refuses a search longer than it can walk, rather than reporting not found", async () => {
    const { pretium, sent } = client(listing({}));
    const failure = await failureOf(
      pretium.findByHash({
        txHash: TX_HASH,
        since: new Date("2026-09-01T00:00:00Z"),
      }),
    );
    expect({ failure, calls: sent.length }).toMatchObject({
      failure: { code: "SEARCH_RANGE_TOO_LONG", ambiguous: false },
      calls: 0,
    });
  });

  it("fails when the matching transaction can't be read", async () => {
    const { pretium } = client(
      listing({
        "2026-11-12": [{ transaction_hash: TX_HASH, status: 7 }],
      }),
    );
    const failure = await failureOf(
      pretium.findByHash({
        txHash: TX_HASH,
        since: new Date("2026-11-12T00:00:00Z"),
      }),
    );
    expect(failure?.code).toBe("INVALID_RESPONSE");
  });
});

describe("refund", () => {
  it("asks for a refund on Base and reads the refund transaction", async () => {
    // #given
    const { pretium, sent } = client(() =>
      json({
        status: "success",
        message: "Txn refunded.",
        data: {
          hash: `0x${"AB".repeat(32)}`,
          amount: 150,
          token: "USDC",
          address: "0x9f8e000000000000000000000000000000000001",
        },
      }),
    );

    // #when
    const refund = await Effect.runPromise(pretium.refund(TX_HASH));

    // #then
    expect({ refund, url: sent[0]?.url, body: bodyOf(sent[0]) }).toEqual({
      refund: {
        refundTxHash: `0x${"ab".repeat(32)}`,
        amount: "150",
        token: "USDC",
        address: "0x9f8e000000000000000000000000000000000001",
      },
      url: "https://api.pretium.test/v1/refund",
      body: { chain: "BASE", transaction_hash: TX_HASH },
    });
  });

  it("accepts a success with no refund details", async () => {
    const { pretium } = client(() =>
      json({ status: "success", message: "Txn refunded." }),
    );
    expect(await Effect.runPromise(pretium.refund(TX_HASH))).toEqual({
      refundTxHash: null,
      amount: null,
      token: null,
      address: null,
    });
  });

  it.each<[string, Responder, { code: string; ambiguous: boolean }]>([
    [
      "a 400 saying the hash was already processed",
      () =>
        json(
          { status: "error", message: "Hash has already been processed" },
          400,
        ),
      { code: "HASH_ALREADY_PROCESSED", ambiguous: false },
    ],
    [
      "another 400",
      () => json({ status: "error", message: "Unknown hash" }, 400),
      { code: "HTTP_400", ambiguous: false },
    ],
    [
      "a 2xx that isn't a success",
      () => json({ status: "error", message: "Not eligible" }),
      { code: "REFUND_REFUSED", ambiguous: false },
    ],
    [
      "a 503",
      () => text("unavailable", 503),
      { code: "HTTP_503", ambiguous: true },
    ],
    [
      "a 2xx it can't read",
      () => text("not json", 200),
      { code: "INVALID_RESPONSE", ambiguous: true },
    ],
    [
      "a lost reply",
      () => Promise.reject(new Error("ECONNRESET")),
      { code: "TRANSPORT_ERROR", ambiguous: true },
    ],
  ])("classifies %s", async (_name, respond, expected) => {
    const { pretium } = client(respond);
    expect(await failureOf(pretium.refund(TX_HASH))).toMatchObject(expected);
  });
});

describe("verifyWebhookSignature", () => {
  const BODY = JSON.stringify({
    transaction_code: "TSALX",
    status: "COMPLETE",
  });
  const sign = (body: string, key = SIGNING_KEY) =>
    createHmac("sha512", key).update(body, "utf8").digest("hex");

  it("accepts the HMAC-SHA512 of the raw body", () => {
    const { pretium } = client(() => json({}));
    expect(pretium.verifyWebhookSignature(BODY, sign(BODY))).toBe(true);
  });

  it.each<[string, string | undefined]>([
    ["a signature over another body", sign(`${BODY} `)],
    ["a signature with another key", sign(BODY, "another key")],
    ["a missing header", undefined],
    ["a malformed header", "not-hex"],
    ["a SHA-256 length signature", "a".repeat(64)],
  ])("rejects %s", (_name, signature) => {
    const { pretium } = client(() => json({}));
    expect(pretium.verifyWebhookSignature(BODY, signature)).toBe(false);
  });

  it("rejects everything when no signing key is configured", () => {
    const { pretium } = client(() => json({}), { signingKey: null });
    expect({
      verified: pretium.verifyWebhookSignature(BODY, sign(BODY)),
      configured: pretium.signingKeyConfigured,
    }).toEqual({ verified: false, configured: false });
  });

  it("exposes the configured callback URL", () => {
    expect([
      client(() => json({})).pretium.callbackUrl,
      client(() => json({}), { callbackUrl: null }).pretium.callbackUrl,
    ]).toEqual([CALLBACK_URL, null]);
  });
});
