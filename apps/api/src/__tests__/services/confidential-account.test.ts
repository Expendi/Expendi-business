import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { APIError } from "@privy-io/node";
import { Effect, Either, Exit, Redacted } from "effect";
import { baseDecode, KeyPair, KeyPairSigner } from "near-api-js";
import { describe, expect, it } from "vitest";

import type { CompanyIntentRefusalReason } from "../../services/intents/confidential-account.js";
import type {
  OneClickConfidentialBalance,
  OneClickSignedIntent,
  OneClickUnsignedIntent,
} from "../../services/intents/one-click.js";
import { NearRpcError } from "../../services/chain/near-rpc.js";
import {
  checkCompanyIntent,
  CompanyIntentRefused,
  CONFIDENTIAL_BACKING_ACCOUNT_ID,
  CONFIDENTIAL_INTENTS_CONTRACT_ID,
  confidentialUsdcTokenId,
  makeConfidentialAccounts,
  MAX_INTENT_LIFETIME_MS,
  versionedNonce,
} from "../../services/intents/confidential-account.js";
import { SendRefused } from "../../services/wallet/privy-wallets.js";
import { TEST_NEAR_CHAIN } from "../helpers/near.js";

const USDC = "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";
const SALT = Uint8Array.from([0xe1, 0x10, 0xf3, 0x17]);
const NOW = new Date("2026-11-13T08:20:00.000Z");
const SPEND_CAP = 1_000_000_000n;

interface FixtureLeg {
  readonly quote: {
    readonly depositAddress: string;
    readonly amountIn: string;
  };
  readonly generated: { readonly intent: { readonly payload: Payload } };
}
interface Payload {
  readonly message: string;
  readonly nonce: string;
  readonly recipient: string;
}

const fixture = JSON.parse(
  readFileSync(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../fixtures/one-click/confidential-intents.json",
    ),
    "utf8",
  ),
) as { readonly companyAccount: string; readonly legs: readonly FixtureLeg[] };

const company = fixture.companyAccount;
const legs = fixture.legs.map((leg) => ({
  unsigned: leg.generated.intent.payload,
  depositAddress: leg.quote.depositAddress,
  amountIn: BigInt(leg.quote.amountIn),
}));
const noLeg = (): never => {
  throw new Error("The fixture has no legs");
};
const leg = legs[0] ?? noLeg();

const TOKEN_ID = confidentialUsdcTokenId(USDC);
const DAY_MS = 24 * 60 * 60 * 1000;

interface MessageParts {
  deadline: string;
  intents: Record<string, unknown>[];
  signer_id: string;
}

const messageOf = (unsigned: OneClickUnsignedIntent): MessageParts =>
  JSON.parse(unsigned.message) as MessageParts;

const nonceFor = (deadline: Date, start = NOW): string =>
  Buffer.from(
    versionedNonce({
      salt: SALT,
      deadline,
      start,
      random: randomBytes(7),
    }),
  ).toString("base64");

/** A message built as 1Click builds it, with a nonce that matches it. */
function intentOf(
  change: (parts: MessageParts) => void = () => undefined,
  options: { nonce?: string; recipient?: string } = {},
): OneClickUnsignedIntent {
  const parts = structuredClone(messageOf(leg.unsigned));
  change(parts);
  return {
    message: JSON.stringify(parts),
    nonce: options.nonce ?? nonceFor(new Date(parts.deadline)),
    recipient: options.recipient ?? CONFIDENTIAL_INTENTS_CONTRACT_ID,
  };
}

const firstIntent = (parts: MessageParts): Record<string, unknown> => {
  const [intent] = parts.intents;
  if (intent === undefined) throw new Error("No intent");
  return intent;
};

const tokensOf = (parts: MessageParts): Record<string, string> =>
  firstIntent(parts).tokens as Record<string, string>;

function check(
  unsigned: OneClickUnsignedIntent,
  overrides: Partial<{
    amountIn: bigint;
    spendCap: bigint;
    now: Date;
    companyAccountId: string;
    depositAddress: string;
  }> = {},
) {
  return checkCompanyIntent({
    unsigned,
    companyAccountId: company,
    depositAddress: leg.depositAddress,
    amountIn: leg.amountIn,
    spendCap: SPEND_CAP,
    usdcContractId: USDC,
    now: NOW,
    ...overrides,
  });
}

function reasonOf(result: ReturnType<typeof check>): string {
  if (Either.isRight(result)) return "accepted";
  expect(result.left).toBeInstanceOf(CompanyIntentRefused);
  return result.left.reason;
}

describe("versionedNonce", () => {
  it("lays out magic, version, salt, deadline, start and random bytes", () => {
    // #given
    const deadline = new Date("2026-11-16T08:19:27.521Z");
    const start = new Date("2026-11-13T08:14:27.000Z");
    const random = Uint8Array.from([1, 2, 3, 4, 5, 6, 7]);

    // #when
    const nonce = versionedNonce({ salt: SALT, deadline, start, random });

    // #then
    const deadlineNanos = BigInt(deadline.getTime()) * 1_000_000n;
    const startNanos = BigInt(start.getTime()) * 1_000_000n;
    const expected = Buffer.alloc(32);
    expected.set([0x56, 0x28, 0xf6, 0xc6, 0x00, 0xe1, 0x10, 0xf3, 0x17], 0);
    expected.writeBigUInt64LE(deadlineNanos, 9);
    expected.writeBigUInt64LE(startNanos, 17);
    expected.set(random, 25);
    expect(Buffer.from(nonce).toString("hex")).toBe(expected.toString("hex"));
    expect(Buffer.from(nonce).toString("hex")).toBe(
      "5628f6c600e110f31740aadc5ab478e818001e7daeb08ce71801020304050607",
    );
  });

  it("rejects a salt that is not 4 bytes", () => {
    expect(() =>
      versionedNonce({
        salt: new Uint8Array(3),
        deadline: NOW,
        start: NOW,
        random: new Uint8Array(7),
      }),
    ).toThrow(RangeError);
  });

  it("rejects random bytes that are not 7", () => {
    expect(() =>
      versionedNonce({
        salt: SALT,
        deadline: NOW,
        start: NOW,
        random: new Uint8Array(8),
      }),
    ).toThrow(RangeError);
  });

  it.each(legs.map((each, index) => [index, each] as const))(
    "describes the nonce 1Click generated for fixture leg %i",
    (_index, each) => {
      // #given
      const nonce = Buffer.from(each.unsigned.nonce, "base64");

      // #when
      const deadline = new Date(messageOf(each.unsigned).deadline);

      // #then
      expect(nonce).toHaveLength(32);
      expect(nonce.subarray(0, 4).toString("hex")).toBe("5628f6c6");
      expect(nonce.readUInt8(4)).toBe(0);
      expect(nonce.subarray(5, 9).toString("hex")).toBe("e110f317");
      expect(nonce.readBigUInt64LE(9)).toBe(
        BigInt(deadline.getTime()) * 1_000_000n,
      );
    },
  );
});

describe("checkCompanyIntent", () => {
  it.each(legs.map((each, index) => [index, each] as const))(
    "accepts what 1Click generated for fixture leg %i",
    (_index, each) => {
      // #when
      const result = check(each.unsigned, {
        depositAddress: each.depositAddress,
        amountIn: each.amountIn,
      });

      // #then
      expect(Either.isRight(result)).toBe(true);
      if (Either.isRight(result)) {
        expect(result.right.amount).toBe(each.amountIn);
        expect(result.right.deadline.toISOString()).toBe(
          messageOf(each.unsigned).deadline,
        );
      }
    },
  );

  it("accepts a rebuilt message the same as the original", () => {
    expect(Either.isRight(check(intentOf()))).toBe(true);
  });

  const refusals: readonly [
    string,
    CompanyIntentRefusalReason,
    () => ReturnType<typeof check>,
  ][] = [
    [
      "another recipient",
      "recipient",
      () =>
        check(
          intentOf(undefined, {
            recipient: TEST_NEAR_CHAIN.intentsContractId,
          }),
        ),
    ],
    [
      "a nonce that is not 32 bytes",
      "nonce_format",
      () =>
        check(
          intentOf(undefined, {
            nonce: Buffer.alloc(31, 1).toString("base64"),
          }),
        ),
    ],
    [
      "a nonce without the magic prefix",
      "nonce_format",
      () =>
        check(
          intentOf(undefined, {
            nonce: randomBytes(32).toString("base64"),
          }),
        ),
    ],
    [
      "a nonce that is not base64",
      "nonce_format",
      () => check(intentOf(undefined, { nonce: "not base64!" })),
    ],
    [
      "a message that is not JSON",
      "message_not_json",
      () =>
        check({
          message: "{not json",
          nonce: leg.unsigned.nonce,
          recipient: CONFIDENTIAL_INTENTS_CONTRACT_ID,
        }),
    ],
    [
      "a message that repeats a key, which a parser may read either way",
      "message_not_canonical",
      () =>
        check({
          ...leg.unsigned,
          message: leg.unsigned.message.replace(
            '"signer_id":"',
            '"signer_id":"someone-else.near","signer_id":"',
          ),
        }),
    ],
    [
      "a message written with spaces",
      "message_not_canonical",
      () =>
        check({
          ...leg.unsigned,
          message: JSON.stringify(messageOf(leg.unsigned), null, 1),
        }),
    ],
    [
      "an extra key in the message",
      "message_keys",
      () =>
        check(
          intentOf((parts) => {
            Object.assign(parts, { memo: "hello" });
          }),
        ),
    ],
    [
      "a message missing a key",
      "message_keys",
      () =>
        check(
          intentOf(
            (parts) => {
              Reflect.deleteProperty(parts, "deadline");
            },
            { nonce: leg.unsigned.nonce },
          ),
        ),
    ],
    [
      "another signer",
      "signer",
      () =>
        check(
          intentOf((parts) => {
            parts.signer_id = randomBytes(32).toString("hex");
          }),
        ),
    ],
    [
      "two intents",
      "intent_count",
      () =>
        check(
          intentOf((parts) => {
            parts.intents.push(structuredClone(firstIntent(parts)));
          }),
        ),
    ],
    [
      "no intents",
      "intent_count",
      () =>
        check(
          intentOf((parts) => {
            parts.intents = [];
          }),
        ),
    ],
    [
      "an extra key in the intent",
      "intent_keys",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).memo = "hello";
          }),
        ),
    ],
    [
      "an intent that is not a transfer",
      "intent_kind",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).intent = "ft_withdraw";
          }),
        ),
    ],
    [
      "another receiver",
      "receiver",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).receiver_id = randomBytes(32).toString("hex");
          }),
        ),
    ],
    [
      "a second token",
      "token_count",
      () =>
        check(
          intentOf((parts) => {
            tokensOf(parts)[`nep141:${USDC}`] = "1";
          }),
        ),
    ],
    [
      "the public token id",
      "token_id",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [`nep141:${USDC}`]: "100000" };
          }),
        ),
    ],
    [
      "the token under another backing account",
      "token_id",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = {
              [`imt:${randomBytes(32).toString("hex")}:nep141:${USDC}`]:
                "100000",
            };
          }),
        ),
    ],
    [
      "another token under the backing account",
      "token_id",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = {
              [`imt:${CONFIDENTIAL_BACKING_ACCOUNT_ID}:nep141:other.near`]:
                "100000",
            };
          }),
        ),
    ],
    [
      "an amount above the quote's amount in",
      "amount_not_the_quote",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: "100001" };
          }),
        ),
    ],
    [
      "an amount below the quote's amount in",
      "amount_not_the_quote",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: "99999" };
          }),
        ),
    ],
    [
      "an amount above the spend cap",
      "amount_above_cap",
      () => check(intentOf(), { spendCap: leg.amountIn - 1n }),
    ],
    [
      "an amount of zero",
      "amount_not_positive",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: "0" };
          }),
        ),
    ],
    [
      "an amount that is not numeric",
      "amount_format",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: "ten" };
          }),
        ),
    ],
    [
      "an amount that is negative",
      "amount_format",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: "-5" };
          }),
        ),
    ],
    [
      "an amount that is a JSON number",
      "amount_format",
      () =>
        check(
          intentOf((parts) => {
            firstIntent(parts).tokens = { [TOKEN_ID]: 100000 };
          }),
        ),
    ],
    [
      "a deadline that is not a date",
      "deadline_format",
      () =>
        check(
          intentOf(
            (parts) => {
              parts.deadline = "next week";
            },
            { nonce: nonceFor(new Date(NOW.getTime() + DAY_MS)) },
          ),
        ),
    ],
    [
      "a deadline in the past",
      "deadline_passed",
      () =>
        check(
          intentOf((parts) => {
            parts.deadline = new Date(NOW.getTime() - 1000).toISOString();
          }),
        ),
    ],
    [
      "a deadline right now",
      "deadline_passed",
      () =>
        check(
          intentOf((parts) => {
            parts.deadline = NOW.toISOString();
          }),
        ),
    ],
    [
      "a deadline more than 4 days out",
      "deadline_too_far",
      () =>
        check(
          intentOf((parts) => {
            parts.deadline = new Date(
              NOW.getTime() + MAX_INTENT_LIFETIME_MS + 1,
            ).toISOString();
          }),
        ),
    ],
    [
      "a nonce whose deadline differs",
      "nonce_deadline",
      () =>
        check(
          intentOf(undefined, {
            nonce: nonceFor(
              new Date(
                new Date(messageOf(leg.unsigned).deadline).getTime() + 1,
              ),
            ),
          }),
        ),
    ],
  ];

  it.each(refusals)("refuses %s", (_name, reason, run) => {
    expect(reasonOf(run())).toBe(reason);
  });

  it("accepts a deadline exactly 4 days out", () => {
    const result = check(
      intentOf((parts) => {
        parts.deadline = new Date(
          NOW.getTime() + MAX_INTENT_LIFETIME_MS,
        ).toISOString();
      }),
    );
    expect(Either.isRight(result)).toBe(true);
  });

  it("accepts an amount exactly at the quote and at the cap", () => {
    expect(Either.isRight(check(intentOf(), { spendCap: leg.amountIn }))).toBe(
      true,
    );
  });
});

/** A NEP-413 hash computed from the specification, not from near-api-js. */
function nep413Hash(payload: OneClickUnsignedIntent): Buffer {
  const text = (value: string): Buffer => {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return Buffer.concat([length, bytes]);
  };
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(2 ** 31 + 413);
  return createHash("sha256")
    .update(
      Buffer.concat([
        prefix,
        text(payload.message),
        Buffer.from(payload.nonce, "base64"),
        text(payload.recipient),
        Buffer.from([0]),
      ]),
    )
    .digest();
}

const wallet = { privyWalletId: "privy-wallet-1", accountId: company };

function makeRig(
  options: {
    balances?: readonly OneClickConfidentialBalance[];
    signingFails?: Error;
    clock?: { now: Date };
  } = {},
) {
  const keyPair = KeyPair.fromRandom("ed25519");
  const clock = options.clock ?? { now: new Date(NOW) };
  const signed: { accountId: string; message: string; recipient: string }[] =
    [];
  const authenticated: OneClickSignedIntent[] = [];
  let signIns = 0;
  const signIn = { expiresInMs: 15 * 60 * 1000 };
  const rig = {
    keyPair,
    clock,
    signed,
    authenticated,
    signIn,
    signIns: () => signIns,
    accounts: makeConfidentialAccounts({
      rpc: { intentsSalt: () => Effect.succeed(SALT) },
      oneClick: {
        authenticate: (intent) =>
          Effect.sync(() => {
            signIns += 1;
            authenticated.push(intent);
            return {
              session: Redacted.make(`token-${String(signIns)}`),
              expiresAt: new Date(clock.now.getTime() + signIn.expiresInMs),
            };
          }),
        balances: () => Effect.succeed(options.balances ?? []),
      },
      privy: {
        nearSigner: (target) => {
          const signer = new KeyPairSigner(keyPair);
          const sign = signer.signNep413Message.bind(signer);
          signer.signNep413Message = (accountId, params) => {
            signed.push({
              accountId: target.accountId,
              message: params.message,
              recipient: params.recipient,
            });
            return options.signingFails === undefined
              ? sign(accountId, params)
              : Promise.reject(options.signingFails);
          };
          return signer;
        },
      },
      chain: { usdcContractId: USDC, intentsContractId: "intents.near" },
      now: () => new Date(clock.now),
      randomBytes: (size) => new Uint8Array(size).fill(7),
    }),
  };
  return rig;
}

describe("ConfidentialAccounts.signIntent", () => {
  const input = {
    company: wallet,
    unsigned: leg.unsigned,
    depositAddress: leg.depositAddress,
    amountIn: leg.amountIn,
    spendCap: SPEND_CAP,
  };

  it("signs the payload unchanged with a signature that verifies as NEP-413", async () => {
    // #given
    const rig = makeRig();

    // #when
    const result = await Effect.runPromise(rig.accounts.signIntent(input));

    // #then
    expect(result.signed.standard).toBe("nep413");
    expect(result.signed.payload).toEqual(leg.unsigned);
    expect(result.signed.public_key).toBe(
      rig.keyPair.getPublicKey().toString(),
    );
    expect(result.amount).toBe(leg.amountIn);
    expect(result.deadline.toISOString()).toBe(
      messageOf(leg.unsigned).deadline,
    );
    expect(result.signed.signature.startsWith("ed25519:")).toBe(true);
    const signature = baseDecode(result.signed.signature.slice(8));
    expect(
      rig.keyPair
        .getPublicKey()
        .verify(nep413Hash(leg.unsigned), Uint8Array.from(signature)),
    ).toBe(true);
    expect(rig.signed).toHaveLength(1);
  });

  it("never asks the signer when the check refuses", async () => {
    // #given
    const rig = makeRig();

    // #when
    const exit = await Effect.runPromiseExit(
      rig.accounts.signIntent({ ...input, spendCap: leg.amountIn - 1n }),
    );

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
    const failure = Exit.isFailure(exit) ? exit.cause : null;
    expect(JSON.stringify(failure)).toContain("amount_above_cap");
    expect(rig.signed).toHaveLength(0);
  });

  it("fails with CompanyIntentRefused for a message for another company", async () => {
    // #given
    const rig = makeRig();

    // #when
    const error = await Effect.runPromise(
      Effect.flip(
        rig.accounts.signIntent({
          ...input,
          company: { ...wallet, accountId: randomBytes(32).toString("hex") },
        }),
      ),
    );

    // #then
    expect(error).toBeInstanceOf(CompanyIntentRefused);
    expect(error).toMatchObject({ reason: "signer" });
    expect(rig.signed).toHaveLength(0);
  });

  it("keeps a refusal from Privy apart from an unclear failure", async () => {
    // #given
    const refused = makeRig({
      signingFails: APIError.generate(
        403,
        { error: "policy_violation" },
        "policy_violation",
        new Headers(),
      ),
    });
    const unclear = makeRig({ signingFails: new Error("socket hang up") });

    // #when
    const refusal = await Effect.runPromise(
      Effect.flip(refused.accounts.signIntent(input)),
    );
    const failure = await Effect.runPromise(
      Effect.flip(unclear.accounts.signIntent(input)),
    );

    // #then
    expect(refusal).toBeInstanceOf(SendRefused);
    expect(failure._tag).toBe("PrivyWalletError");
  });
});

describe("ConfidentialAccounts.session", () => {
  it("signs in once with the NEP-413 message 1Click expects", async () => {
    // #given
    const rig = makeRig();

    // #when
    const session = await Effect.runPromise(rig.accounts.session(wallet));

    // #then
    expect(Redacted.value(session)).toBe("token-1");
    expect(rig.signIns()).toBe(1);
    const [request] = rig.signed;
    expect(request?.recipient).toBe("intents.near");
    const message = JSON.parse(request?.message ?? "{}") as MessageParts;
    expect(message).toEqual({
      deadline: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
      intents: [],
      signer_id: company,
    });
    expect(Object.keys(message)).toEqual(["deadline", "intents", "signer_id"]);
    const [authenticated] = rig.authenticated;
    const nonce = Buffer.from(authenticated?.payload.nonce ?? "", "base64");
    expect(nonce).toHaveLength(32);
    expect(nonce.subarray(0, 4).toString("hex")).toBe("5628f6c6");
    expect(nonce.subarray(5, 9).toString("hex")).toBe("e110f317");
    expect(nonce.readBigUInt64LE(9)).toBe(
      BigInt(new Date(message.deadline).getTime()) * 1_000_000n,
    );
    expect(nonce.readBigUInt64LE(17)).toBe(BigInt(NOW.getTime()) * 1_000_000n);
    expect(authenticated?.public_key).toBe(
      rig.keyPair.getPublicKey().toString(),
    );
    expect(authenticated?.payload.message).toBe(request?.message);
    expect(authenticated?.payload.recipient).toBe("intents.near");
  });

  it("reuses the session while it has more than a minute left", async () => {
    // #given
    const rig = makeRig();
    await Effect.runPromise(rig.accounts.session(wallet));

    // #when
    rig.clock.now = new Date(NOW.getTime() + 14 * 60_000 - 1);
    const again = await Effect.runPromise(rig.accounts.session(wallet));

    // #then
    expect(Redacted.value(again)).toBe("token-1");
    expect(rig.signIns()).toBe(1);
  });

  it("signs in again from a minute before the session expires", async () => {
    // #given
    const rig = makeRig();
    await Effect.runPromise(rig.accounts.session(wallet));

    // #when
    rig.clock.now = new Date(NOW.getTime() + 14 * 60_000);
    const again = await Effect.runPromise(rig.accounts.session(wallet));

    // #then
    expect(Redacted.value(again)).toBe("token-2");
    expect(rig.signIns()).toBe(2);
  });

  it("does not share a session between companies", async () => {
    // #given
    const rig = makeRig();
    const other = {
      privyWalletId: "privy-wallet-2",
      accountId: "ab".repeat(32),
    };

    // #when
    const first = await Effect.runPromise(rig.accounts.session(wallet));
    const second = await Effect.runPromise(rig.accounts.session(other));

    // #then
    expect(Redacted.value(first)).not.toBe(Redacted.value(second));
    expect(rig.signIns()).toBe(2);
  });

  it("fails when the salt cannot be read", async () => {
    // #given
    const accounts = makeConfidentialAccounts({
      rpc: {
        intentsSalt: () => Effect.fail(new NearRpcError({ message: "down" })),
      },
      oneClick: {
        authenticate: () => Effect.die("must not sign in"),
        balances: () => Effect.die("unused"),
      },
      privy: {
        nearSigner: () => new KeyPairSigner(KeyPair.fromRandom("ed25519")),
      },
      chain: { usdcContractId: USDC, intentsContractId: "intents.near" },
    });

    // #when
    const error = await Effect.runPromise(
      Effect.flip(accounts.session(wallet)),
    );

    // #then
    expect(error._tag).toBe("NearRpcError");
  });
});

describe("ConfidentialAccounts.usdcBalance", () => {
  it("picks the entry reported under the public USDC asset id", async () => {
    // #given
    const rig = makeRig({
      balances: [
        { tokenId: "nep141:other.near", available: 5n },
        { tokenId: `nep141:${USDC}`, available: 123_456n },
      ],
    });

    // #when
    const balance = await Effect.runPromise(rig.accounts.usdcBalance(wallet));

    // #then
    expect(balance).toBe(123_456n);
  });

  it("is zero when the account holds no USDC", async () => {
    // #given
    const rig = makeRig({
      balances: [{ tokenId: "nep141:other.near", available: 5n }],
    });

    // #when
    const balance = await Effect.runPromise(rig.accounts.usdcBalance(wallet));

    // #then
    expect(balance).toBe(0n);
  });
});
