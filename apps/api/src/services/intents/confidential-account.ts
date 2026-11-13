import { randomBytes } from "node:crypto";
import { Context, Data, Effect, Either, Layer } from "effect";
import { baseEncode } from "near-api-js";
import { z } from "zod";

import type { NearRpcError, NearRpcShape } from "../chain/near-rpc.js";
import type { NearChainShape } from "../chain/near.js";
import type {
  NearSigningWallet,
  PrivyWalletError,
  PrivyWalletsShape,
  SendRefused,
} from "../wallet/privy-wallets.js";
import type {
  OneClickError,
  OneClickSession,
  OneClickShape,
  OneClickSignedIntent,
  OneClickUnsignedIntent,
} from "./one-click.js";
import { NearRpc } from "../chain/near-rpc.js";
import { NearChain } from "../chain/near.js";
import { nearSigningFailure, PrivyWallets } from "../wallet/privy-wallets.js";
import { OneClick } from "./one-click.js";

/**
 * A company's confidential account on the NEAR Intents private ledger
 * (docs/decisions/confidential-accounts.md). This file holds the one
 * function that signs for a company in it. Privy checks nothing about what
 * is signed, so `checkCompanyIntent` is all that stands between a wrong or
 * hostile message from 1Click and the company's money.
 */

/**
 * Who every message a company signs for a payment is addressed to. A
 * constant rather than config, so a misconfigured environment can never make
 * the API sign for another ledger.
 */
export const CONFIDENTIAL_INTENTS_CONTRACT_ID = "intents.far";

/**
 * The shared NEAR Intents account that holds what backs every confidential
 * balance; seen in every message 1Click generated on 2026-11-13. A constant
 * rather than config, so a changed 1Click answer can never make the API sign
 * for another token.
 */
export const CONFIDENTIAL_BACKING_ACCOUNT_ID =
  "51e8f94d77b5e90dc9852ca6113771e11e8382ce69473a75e313e41665de7cbe";

/**
 * The token a confidential USDC balance is held as on the private ledger. A
 * function of constants and the USDC contract, never of anything 1Click says.
 */
export function confidentialUsdcTokenId(usdcContractId: string): string {
  return `imt:${CONFIDENTIAL_BACKING_ACCOUNT_ID}:nep141:${usdcContractId}`;
}

/**
 * How far ahead a message may expire. 1Click set three days on 2026-11-13;
 * a constant rather than config, so a changed answer can't leave a signed
 * message spendable for longer than this.
 */
export const MAX_INTENT_LIFETIME_MS = 4 * 24 * 60 * 60 * 1000;

const SIGN_IN_LIFETIME_MS = 5 * 60 * 1000;
const SESSION_REUSE_MARGIN_MS = 60 * 1000;
const SALT_LENGTH = 4;
const RANDOM_LENGTH = 7;
const NONCE_LENGTH = 32;
const NONCE_MAGIC = Uint8Array.from([0x56, 0x28, 0xf6, 0xc6]);
const NONCE_VERSION = 0;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const DEADLINE_OFFSET = 9;
const START_OFFSET = 17;
const RANDOM_OFFSET = 25;
const ED25519_PREFIX = "ed25519:";

/**
 * The 32-byte nonce 1Click accepts on a sign-in, laid out as the Intents SDK
 * does (`expirable-nonce.ts`): magic, version, the contract's salt, the
 * deadline and start time in nanoseconds since the epoch as little-endian
 * unsigned 64-bit integers, then seven random bytes.
 */
export function versionedNonce(input: {
  readonly salt: Uint8Array;
  readonly deadline: Date;
  readonly start: Date;
  readonly random: Uint8Array;
}): Uint8Array {
  if (input.salt.length !== SALT_LENGTH) {
    throw new RangeError(`The salt must be ${SALT_LENGTH} bytes`);
  }
  if (input.random.length !== RANDOM_LENGTH) {
    throw new RangeError(`The random part must be ${RANDOM_LENGTH} bytes`);
  }
  const nonce = Buffer.alloc(NONCE_LENGTH);
  nonce.set(NONCE_MAGIC, 0);
  nonce.writeUInt8(NONCE_VERSION, NONCE_MAGIC.length);
  nonce.set(input.salt, NONCE_MAGIC.length + 1);
  nonce.writeBigUInt64LE(
    BigInt(input.deadline.getTime()) * NANOSECONDS_PER_MILLISECOND,
    DEADLINE_OFFSET,
  );
  nonce.writeBigUInt64LE(
    BigInt(input.start.getTime()) * NANOSECONDS_PER_MILLISECOND,
    START_OFFSET,
  );
  nonce.set(input.random, RANDOM_OFFSET);
  return Uint8Array.from(nonce);
}

export type CompanyIntentRefusalReason =
  | "recipient"
  | "nonce_format"
  | "message_not_json"
  | "message_keys"
  | "message_not_canonical"
  | "signer"
  | "intent_count"
  | "intent_keys"
  | "intent_kind"
  | "receiver"
  | "token_count"
  | "token_id"
  | "amount_format"
  | "amount_not_positive"
  | "amount_above_quote"
  | "amount_above_cap"
  | "deadline_format"
  | "deadline_passed"
  | "deadline_too_far"
  | "nonce_deadline";

/**
 * A message 1Click generated that the company must not sign. Nothing was
 * signed. It is not retried: a person looks at what 1Click sent.
 */
export class CompanyIntentRefused extends Data.TaggedError(
  "CompanyIntentRefused",
)<{
  readonly reason: CompanyIntentRefusalReason;
  readonly message: string;
}> {}

export interface CompanyIntentCheckInput {
  readonly unsigned: OneClickUnsignedIntent;
  readonly companyAccountId: string;
  /** The quote's deposit address, which the message must pay. */
  readonly depositAddress: string;
  /** The quote's amount in, USDC base units. */
  readonly amountIn: bigint;
  /** The company's per-transaction maximum, USDC base units. */
  readonly spendCap: bigint;
  readonly usdcContractId: string;
  readonly now: Date;
}

export interface CheckedCompanyIntent {
  /** USDC base units the message moves. */
  readonly amount: bigint;
  readonly deadline: Date;
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const ISO_DATE_TIME = z.iso.datetime();
const AMOUNT = /^(0|[1-9]\d{0,38})$/;
const MESSAGE_KEYS = ["deadline", "intents", "signer_id"];
const INTENT_KEYS = ["intent", "receiver_id", "tokens"];

const refuse = (reason: CompanyIntentRefusalReason, message: string) =>
  Either.left(new CompanyIntentRefused({ reason, message }));

const hasExactlyKeys = (
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean => {
  const own = Object.keys(value).sort();
  return own.length === keys.length && own.every((key, i) => key === keys[i]);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function decodeNonce(encoded: string): Buffer | null {
  if (!BASE64.test(encoded)) return null;
  const nonce = Buffer.from(encoded, "base64");
  return nonce.length === NONCE_LENGTH && nonce.toString("base64") === encoded
    ? nonce
    : null;
}

const hasVersionedPrefix = (nonce: Buffer): boolean =>
  nonce.subarray(0, NONCE_MAGIC.length).equals(NONCE_MAGIC) &&
  nonce.readUInt8(NONCE_MAGIC.length) === NONCE_VERSION;

/**
 * Whether a message 1Click generated may be signed for the company. Strict
 * on purpose: the signer must know exactly what it signs, so anything
 * unexpected is refused. The only message it accepts is one `transfer` of
 * the confidential USDC token to the quote's deposit address, for more than
 * nothing and no more than the quote's amount in or the spend cap, expiring
 * within `MAX_INTENT_LIFETIME_MS`, with that expiry also in its nonce.
 */
export function checkCompanyIntent(
  input: CompanyIntentCheckInput,
): Either.Either<CheckedCompanyIntent, CompanyIntentRefused> {
  const { unsigned } = input;

  if (unsigned.recipient !== CONFIDENTIAL_INTENTS_CONTRACT_ID) {
    return refuse(
      "recipient",
      `The message is addressed to ${unsigned.recipient}, not ${CONFIDENTIAL_INTENTS_CONTRACT_ID}`,
    );
  }

  const nonce = decodeNonce(unsigned.nonce);
  if (nonce === null || !hasVersionedPrefix(nonce)) {
    return refuse("nonce_format", "The nonce is not a versioned 32-byte nonce");
  }

  const message = ((): unknown => {
    try {
      return JSON.parse(unsigned.message);
    } catch {
      return undefined;
    }
  })();
  if (message === undefined) {
    return refuse("message_not_json", "The message is not JSON");
  }
  if (!isRecord(message) || !hasExactlyKeys(message, MESSAGE_KEYS)) {
    return refuse(
      "message_keys",
      `The message must hold exactly ${MESSAGE_KEYS.join(", ")}`,
    );
  }
  // The checks below read the message as this parser does. A repeated key
  // or other non-canonical text could be read differently by the ledger, so
  // only text that writes back out unchanged is trusted. 1Click's messages
  // of 2026-11-13 do.
  if (JSON.stringify(message) !== unsigned.message) {
    return refuse(
      "message_not_canonical",
      "The message is not written the one way its contents can be",
    );
  }

  if (message.signer_id !== input.companyAccountId) {
    return refuse("signer", "The message is not signed as the company");
  }

  const intents = message.intents;
  if (!Array.isArray(intents) || intents.length !== 1) {
    return refuse("intent_count", "The message must hold exactly one intent");
  }
  const intent: unknown = intents[0];
  if (!isRecord(intent) || !hasExactlyKeys(intent, INTENT_KEYS)) {
    return refuse(
      "intent_keys",
      `The intent must hold exactly ${INTENT_KEYS.join(", ")}`,
    );
  }
  if (intent.intent !== "transfer") {
    return refuse("intent_kind", "The intent is not a transfer");
  }
  if (intent.receiver_id !== input.depositAddress) {
    return refuse("receiver", "The transfer does not pay the deposit address");
  }

  const tokens = intent.tokens;
  const entries = isRecord(tokens) ? Object.entries(tokens) : [];
  const [entry] = entries;
  if (entries.length !== 1 || entry === undefined) {
    return refuse("token_count", "The transfer must move exactly one token");
  }
  const [tokenId, rawAmount] = entry;
  if (tokenId !== confidentialUsdcTokenId(input.usdcContractId)) {
    return refuse("token_id", "The transfer moves a token other than USDC");
  }

  if (typeof rawAmount !== "string" || !AMOUNT.test(rawAmount)) {
    return refuse("amount_format", "The amount is not a whole number");
  }
  const amount = BigInt(rawAmount);
  if (amount <= 0n) {
    return refuse("amount_not_positive", "The amount is not above zero");
  }
  if (amount > input.amountIn) {
    return refuse("amount_above_quote", "The amount is above the quote's");
  }
  if (amount > input.spendCap) {
    return refuse("amount_above_cap", "The amount is above the spend cap");
  }

  const rawDeadline = message.deadline;
  if (
    typeof rawDeadline !== "string" ||
    !ISO_DATE_TIME.safeParse(rawDeadline).success
  ) {
    return refuse("deadline_format", "The deadline is not an ISO date-time");
  }
  const deadline = new Date(rawDeadline);
  if (deadline.getTime() <= input.now.getTime()) {
    return refuse("deadline_passed", "The deadline has passed");
  }
  if (deadline.getTime() > input.now.getTime() + MAX_INTENT_LIFETIME_MS) {
    return refuse("deadline_too_far", "The deadline is too far away");
  }

  const nonceDeadline = nonce.readBigUInt64LE(DEADLINE_OFFSET);
  if (
    nonceDeadline !==
    BigInt(deadline.getTime()) * NANOSECONDS_PER_MILLISECOND
  ) {
    return refuse(
      "nonce_deadline",
      "The nonce expires at a different time than the message",
    );
  }

  return Either.right({ amount, deadline });
}

export type ConfidentialSigningError = SendRefused | PrivyWalletError;

export type ConfidentialSessionError =
  ConfidentialSigningError | NearRpcError | OneClickError;

export interface SignCompanyIntentInput {
  readonly company: NearSigningWallet;
  readonly unsigned: OneClickUnsignedIntent;
  readonly depositAddress: string;
  readonly amountIn: bigint;
  readonly spendCap: bigint;
}

export interface SignedCompanyIntent {
  readonly signed: OneClickSignedIntent;
  readonly amount: bigint;
  readonly deadline: Date;
}

export interface ConfidentialAccountsShape {
  /**
   * The company's 1Click session: cached in memory while it has more than a
   * minute left, otherwise signed in anew. Sessions aren't stored.
   */
  readonly session: (
    company: NearSigningWallet,
  ) => Effect.Effect<OneClickSession, ConfidentialSessionError>;
  /** USDC base units the company holds in its confidential account. */
  readonly usdcBalance: (
    company: NearSigningWallet,
  ) => Effect.Effect<bigint, ConfidentialSessionError>;
  /**
   * The only function that asks Privy to sign an intent for a company, and
   * only after `checkCompanyIntent` accepts it. A `SendRefused` means Privy
   * said no and nothing was signed; a `PrivyWalletError` is an unclear
   * failure, and no signature exists outside Privy either. It neither
   * submits nor saves: the caller must save the signed message before
   * submitting it, so a retry submits the same bytes (decision, Rules,
   * Signing 4).
   */
  readonly signIntent: (
    input: SignCompanyIntentInput,
  ) => Effect.Effect<
    SignedCompanyIntent,
    CompanyIntentRefused | ConfidentialSigningError
  >;
}

export class ConfidentialAccounts extends Context.Tag("ConfidentialAccounts")<
  ConfidentialAccounts,
  ConfidentialAccountsShape
>() {}

export interface ConfidentialAccountsDeps {
  readonly rpc: Pick<NearRpcShape, "intentsSalt">;
  readonly oneClick: Pick<OneClickShape, "authenticate" | "balances">;
  readonly privy: Pick<PrivyWalletsShape, "nearSigner">;
  readonly chain: Pick<NearChainShape, "usdcContractId" | "intentsContractId">;
  readonly now?: () => Date;
  readonly randomBytes?: (size: number) => Uint8Array;
}

export function makeConfidentialAccounts(
  deps: ConfidentialAccountsDeps,
): ConfidentialAccountsShape {
  const now = deps.now ?? (() => new Date());
  const random = deps.randomBytes ?? randomBytes;
  const sessions = new Map<
    string,
    { readonly session: OneClickSession; readonly expiresAt: Date }
  >();

  const sign = (
    company: NearSigningWallet,
    payload: OneClickUnsignedIntent,
  ): Effect.Effect<OneClickSignedIntent, ConfidentialSigningError> =>
    Effect.tryPromise({
      try: () =>
        deps.privy.nearSigner(company).signNep413Message(company.accountId, {
          message: payload.message,
          recipient: payload.recipient,
          nonce: Buffer.from(payload.nonce, "base64"),
        }),
      catch: nearSigningFailure,
    }).pipe(
      Effect.map(({ publicKey, signature }) => ({
        standard: "nep413",
        payload,
        public_key: publicKey.toString(),
        signature: `${ED25519_PREFIX}${baseEncode(signature)}`,
      })),
    );

  const signIn = (
    company: NearSigningWallet,
  ): Effect.Effect<OneClickSession, ConfidentialSessionError> =>
    Effect.gen(function* () {
      const salt = yield* deps.rpc.intentsSalt();
      const start = now();
      const deadline = new Date(start.getTime() + SIGN_IN_LIFETIME_MS);
      const signed = yield* sign(company, {
        message: JSON.stringify({
          deadline: deadline.toISOString(),
          intents: [],
          signer_id: company.accountId,
        }),
        nonce: Buffer.from(
          versionedNonce({
            salt,
            deadline,
            start,
            random: random(RANDOM_LENGTH),
          }),
        ).toString("base64"),
        recipient: deps.chain.intentsContractId,
      });
      const { session, expiresAt } = yield* deps.oneClick.authenticate(signed);
      sessions.set(company.accountId, { session, expiresAt });
      return session;
    });

  const session = (company: NearSigningWallet) =>
    Effect.suspend(() => {
      const cached = sessions.get(company.accountId);
      return cached !== undefined &&
        cached.expiresAt.getTime() - now().getTime() > SESSION_REUSE_MARGIN_MS
        ? Effect.succeed(cached.session)
        : signIn(company);
    });

  return {
    session,

    usdcBalance: (company) =>
      session(company).pipe(
        Effect.flatMap(deps.oneClick.balances),
        Effect.map(
          (balances) =>
            balances.find(
              ({ tokenId }) =>
                tokenId === `nep141:${deps.chain.usdcContractId}`,
            )?.available ?? 0n,
        ),
      ),

    signIntent: ({ company, unsigned, depositAddress, amountIn, spendCap }) =>
      Effect.gen(function* () {
        const checked = yield* Either.match(
          checkCompanyIntent({
            unsigned,
            companyAccountId: company.accountId,
            depositAddress,
            amountIn,
            spendCap,
            usdcContractId: deps.chain.usdcContractId,
            now: now(),
          }),
          {
            onLeft: (refused) => Effect.fail(refused),
            onRight: (accepted) => Effect.succeed(accepted),
          },
        );
        const signed = yield* sign(company, unsigned);
        return { signed, ...checked };
      }),
  };
}

export const ConfidentialAccountsLive: Layer.Layer<
  ConfidentialAccounts,
  never,
  NearRpc | OneClick | PrivyWallets | NearChain
> = Layer.effect(
  ConfidentialAccounts,
  Effect.gen(function* () {
    return makeConfidentialAccounts({
      rpc: yield* NearRpc,
      oneClick: yield* OneClick,
      privy: yield* PrivyWallets,
      chain: yield* NearChain,
    });
  }),
);
