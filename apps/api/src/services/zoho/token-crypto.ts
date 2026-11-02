import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  Config,
  ConfigError,
  Context,
  Effect,
  Either,
  Layer,
  Option,
  Redacted,
} from "effect";
import { z } from "zod";

/**
 * Secrets for the accounting connection (spec §6.17), all from one 32-byte
 * key, `ACCOUNTING_TOKEN_KEY` (base64):
 *
 * - Refresh tokens are sealed with AES-256-GCM as
 *   `v1:<key id>:<iv>:<tag>:<ciphertext>` (base64url parts), with a fresh
 *   12-byte IV each time. The version, key id and the connection's ID are
 *   authenticated too, so a sealed token can't be moved to another row.
 * - The key id is an HMAC fingerprint of the key that reveals nothing about
 *   it. Opening looks the key up by id, so rotating means sealing with a new
 *   key while the old one is still loaded to open older tokens.
 * - The OAuth `state` is HMAC-SHA256 signed with a key derived from it
 *   (HKDF), never with the encryption key itself.
 */

const SEALED_VERSION = "v1";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_ID_LABEL = "expendi accounting token key id";
const STATE_KEY_INFO = "expendi zoho oauth state v1";

export interface TokenKey {
  readonly id: string;
  readonly encryptionKey: Buffer;
  readonly stateKey: Buffer;
}

/** A base64 32-byte key, or null when it isn't one. */
export function parseTokenKey(base64: string): TokenKey | null {
  const trimmed = base64.trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed)) return null;
  const encryptionKey = Buffer.from(trimmed, "base64");
  if (encryptionKey.length !== KEY_BYTES) return null;
  return {
    id: createHmac("sha256", encryptionKey)
      .update(KEY_ID_LABEL)
      .digest("hex")
      .slice(0, 8),
    encryptionKey,
    stateKey: Buffer.from(
      hkdfSync("sha256", encryptionKey, Buffer.alloc(0), STATE_KEY_INFO, 32),
    ),
  };
}

/**
 * Decodes base64url only in its one canonical spelling. Node's decoder skips
 * stray characters and ignores the spare low bits of the last character, so
 * several strings decode to the same bytes; re-encoding catches all of them.
 */
function decodeBase64Url(part: string): Buffer | null {
  const bytes = Buffer.from(part, "base64url");
  return bytes.toString("base64url") === part ? bytes : null;
}

const additionalData = (keyId: string, context: string): Buffer =>
  Buffer.from(`${SEALED_VERSION}:${keyId}:${context}`, "utf8");

/** Seals `plaintext` for the row named by `context`, e.g. the connection's ID. */
export function sealToken(
  key: TokenKey,
  plaintext: string,
  context: string,
): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key.encryptionKey, iv, {
    authTagLength: TAG_BYTES,
  });
  cipher.setAAD(additionalData(key.id, context));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    SEALED_VERSION,
    key.id,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

/** Why a sealed token couldn't be opened; safe to log. */
export type OpenFailure = "malformed" | "unknown_key" | "tampered";

/**
 * Opens a token sealed by `sealToken` with whichever of `keys` sealed it.
 * A part that isn't canonical base64url fails as `malformed`; any change to
 * the ciphertext, tag, IV, key id or context fails as `tampered`.
 */
export function openToken(
  keys: readonly TokenKey[],
  sealed: string,
  context: string,
): Either.Either<string, OpenFailure> {
  const parts = sealed.split(":");
  const [version, keyId, ivPart, tagPart, ciphertextPart] = parts;
  if (
    parts.length !== 5 ||
    version !== SEALED_VERSION ||
    !keyId ||
    !ivPart ||
    !tagPart ||
    ciphertextPart === undefined
  ) {
    return Either.left("malformed");
  }
  const key = keys.find((candidate) => candidate.id === keyId);
  if (!key) return Either.left("unknown_key");

  const iv = decodeBase64Url(ivPart);
  const tag = decodeBase64Url(tagPart);
  const ciphertext = decodeBase64Url(ciphertextPart);
  if (
    iv?.length !== IV_BYTES ||
    tag?.length !== TAG_BYTES ||
    ciphertext === null
  ) {
    return Either.left("malformed");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key.encryptionKey, iv, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(keyId, context));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    return Either.right(plaintext.toString("utf8"));
  } catch {
    return Either.left("tampered");
  }
}

/** The SHA-256 hex hash a connect-link token is stored as. */
export function hashConnectToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new connect-link token: 32 random bytes, base64url. */
export function newConnectToken(): string {
  return randomBytes(32).toString("base64url");
}

export const CONNECT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * What the OAuth `state` carries through Zoho's sign-in: the connection, its
 * company, the start of the link's hash (so a replaced link's sign-ins stop
 * working) and when it stops being accepted.
 */
export interface ConnectState {
  readonly connectionId: string;
  readonly organizationId: string;
  readonly linkHashPrefix: string;
  readonly expiresAt: Date;
}

export const LINK_HASH_PREFIX_LENGTH = 16;

const statePayloadSchema = z.object({
  c: z.uuid(),
  o: z.uuid(),
  h: z.string().regex(/^[0-9a-f]{16}$/),
  e: z.number().int().positive(),
});

const stateMac = (key: TokenKey, payload: string): Buffer =>
  createHmac("sha256", key.stateKey).update(payload, "utf8").digest();

export function signState(key: TokenKey, state: ConnectState): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: state.connectionId,
      o: state.organizationId,
      h: state.linkHashPrefix,
      e: Math.floor(state.expiresAt.getTime() / 1000),
    }),
    "utf8",
  ).toString("base64url");
  return `${payload}.${stateMac(key, payload).toString("base64url")}`;
}

/** The state, if `key` signed it and it hasn't expired at `now`. */
export function verifyState(
  key: TokenKey,
  raw: string,
  now: Date,
): ConnectState | null {
  const [payload, mac, ...rest] = raw.split(".");
  if (!payload || !mac || rest.length > 0) return null;
  const expected = stateMac(key, payload);
  const given = decodeBase64Url(mac);
  if (given?.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  const payloadBytes = decodeBase64Url(payload);
  if (!payloadBytes) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(payloadBytes.toString("utf8"));
  } catch {
    return null;
  }
  const parsed = statePayloadSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const expiresAt = new Date(parsed.data.e * 1000);
  if (expiresAt.getTime() <= now.getTime()) return null;
  return {
    connectionId: parsed.data.c,
    organizationId: parsed.data.o,
    linkHashPrefix: parsed.data.h,
    expiresAt,
  };
}

/**
 * The loaded token key, if `ACCOUNTING_TOKEN_KEY` is set. Optional like the
 * other providers' settings: without it the Zoho endpoints answer that Zoho
 * isn't set up. A key that is set but isn't 32 bytes of base64 stops the API
 * at startup rather than quietly turning Zoho off.
 */
export class AccountingTokenKey extends Context.Tag("AccountingTokenKey")<
  AccountingTokenKey,
  Option.Option<TokenKey>
>() {}

export const AccountingTokenKeyLive: Layer.Layer<
  AccountingTokenKey,
  ConfigError.ConfigError
> = Layer.effect(
  AccountingTokenKey,
  Effect.gen(function* () {
    const key = yield* Config.option(
      Config.redacted("ACCOUNTING_TOKEN_KEY").pipe(
        Config.mapOrFail((value) => {
          const parsed = parseTokenKey(Redacted.value(value));
          return parsed
            ? Either.right(parsed)
            : Either.left(
                ConfigError.InvalidData(
                  ["ACCOUNTING_TOKEN_KEY"],
                  "must be 32 bytes, base64-encoded",
                ),
              );
        }),
      ),
    );
    if (Option.isNone(key)) {
      console.warn(
        "[zoho] ACCOUNTING_TOKEN_KEY isn't set; Zoho Books can't be connected",
      );
    }
    return key;
  }),
);
