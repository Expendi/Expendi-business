import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Pure helpers for Alchemy "Address Activity" webhooks, ported from the
 * consumer backend (`backend/src/services/alchemy/alchemy-webhook.ts`).
 *
 * Alchemy signs every delivery with the webhook's signing key:
 *   X-Alchemy-Signature: hex(HMAC-SHA256(signingKey, rawBody))
 */

export const BASE_MAINNET_NETWORK = "BASE_MAINNET";

/** Comma-separated, so a key can be rotated without dropping deliveries. */
export function parseSigningKeys(raw: string): string[] {
  return raw
    .split(",")
    .map((key) => key.trim())
    .filter((key) => key.length > 0);
}

/**
 * True when `signature` is the HMAC of `rawBody` under any of `keys`.
 * Compared in constant time; a missing signature or no keys never passes.
 */
export function verifyAlchemySignature(
  rawBody: string,
  signature: string | undefined,
  keys: readonly string[],
): boolean {
  if (!signature || keys.length === 0) return false;
  const given = Buffer.from(signature.trim().toLowerCase(), "utf8");
  return keys.some((key) => {
    const expected = Buffer.from(
      createHmac("sha256", key).update(rawBody, "utf8").digest("hex"),
      "utf8",
    );
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/** One transfer from `event.activity[]`, normalised. */
export interface AlchemyActivity {
  /** "external" | "internal" | "token" | "erc721" | ... */
  readonly category: string;
  /** Lowercased. */
  readonly fromAddress: string;
  /** Lowercased. */
  readonly toAddress: string;
  readonly hash: string;
  /** Lowercased token contract, or null for native transfers. */
  readonly contractAddress: string | null;
  /** The log was removed by a reorg: the transfer no longer exists. */
  readonly removed: boolean;
}

export interface AlchemyAddressActivityEvent {
  /** Delivery ID (`whevt_...`), stable across Alchemy's retries. */
  readonly id: string;
  readonly network: string;
  readonly activity: readonly AlchemyActivity[];
}

/**
 * Parses an `ADDRESS_ACTIVITY` payload. Returns null for other webhook
 * types or an unrecognisable shape; malformed entries are dropped rather
 * than failing the whole delivery.
 */
export function parseAddressActivity(
  body: unknown,
): AlchemyAddressActivityEvent | null {
  if (!isRecord(body) || body.type !== "ADDRESS_ACTIVITY") return null;
  const event = isRecord(body.event) ? body.event : null;
  if (typeof body.id !== "string" || !event) return null;
  if (typeof event.network !== "string" || !Array.isArray(event.activity)) {
    return null;
  }
  return {
    id: body.id,
    network: event.network,
    activity: event.activity.flatMap((entry) => {
      const activity = parseActivity(entry);
      return activity ? [activity] : [];
    }),
  };
}

function parseActivity(entry: unknown): AlchemyActivity | null {
  if (!isRecord(entry)) return null;
  const fromAddress = lowerHex(entry.fromAddress);
  const toAddress = lowerHex(entry.toAddress);
  if (!fromAddress || !toAddress || typeof entry.hash !== "string") {
    return null;
  }
  const rawContract = isRecord(entry.rawContract) ? entry.rawContract : {};
  const log = isRecord(entry.log) ? entry.log : {};
  return {
    category: typeof entry.category === "string" ? entry.category : "",
    fromAddress,
    toAddress,
    hash: entry.hash,
    contractAddress: lowerHex(rawContract.address),
    removed: log.removed === true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function lowerHex(value: unknown): string | null {
  return typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)
    ? value.toLowerCase()
    : null;
}
