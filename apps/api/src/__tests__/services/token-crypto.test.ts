import { randomBytes, randomUUID } from "node:crypto";
import { ConfigProvider, Effect, Either, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

import type { TokenKey } from "../../services/zoho/token-crypto.js";
import {
  AccountingTokenKey,
  AccountingTokenKeyLive,
  openToken,
  parseTokenKey,
  sealToken,
  signState,
  verifyState,
} from "../../services/zoho/token-crypto.js";

const REFRESH_TOKEN = "1000.3f2c9a1b7d.refresh-token-from-zoho";

function newKey(): TokenKey {
  const key = parseTokenKey(randomBytes(32).toString("base64"));
  if (!key) throw new Error("test key didn't parse");
  return key;
}

/** Flips one bit of the middle byte, so the decoded bytes always change. */
function flipMiddleBit(part: string): string {
  const bytes = Buffer.from(part, "base64url");
  const middle = Math.floor(bytes.length / 2);
  bytes.writeUInt8(bytes.readUInt8(middle) ^ 0x01, middle);
  return bytes.toString("base64url");
}

const BASE64URL_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * The same bytes spelled differently: sets a spare low bit of the last
 * character, which only exists when the length isn't a multiple of 4.
 */
function withSpareBitSet(part: string): string {
  const last = BASE64URL_ALPHABET.indexOf(part.at(-1) ?? "");
  const variant = `${part.slice(0, -1)}${BASE64URL_ALPHABET.charAt(last | 1)}`;
  expect(variant).not.toBe(part);
  expect(Buffer.from(variant, "base64url")).toEqual(
    Buffer.from(part, "base64url"),
  );
  return variant;
}

type SealedParts = [string, string, string, string, string];

describe("parseTokenKey", () => {
  it("accepts 32 bytes of base64 and fingerprints it", () => {
    // #when
    const key = newKey();

    // #then
    expect(key.id).toMatch(/^[0-9a-f]{8}$/);
    expect(key.encryptionKey).toHaveLength(32);
    expect(key.stateKey.equals(key.encryptionKey)).toBe(false);
  });

  it.each([
    ["16 bytes", randomBytes(16).toString("base64")],
    ["33 bytes", randomBytes(33).toString("base64")],
    ["not base64", "not a key at all!"],
    ["empty", ""],
  ])("refuses %s", (_label, raw) => {
    // #then
    expect(parseTokenKey(raw)).toBeNull();
  });
});

describe("sealToken / openToken", () => {
  const connectionId = randomUUID();

  it("round-trips, with a fresh IV every time", () => {
    // #given
    const key = newKey();

    // #when
    const first = sealToken(key, REFRESH_TOKEN, connectionId);
    const second = sealToken(key, REFRESH_TOKEN, connectionId);

    // #then
    expect(first).not.toEqual(second);
    expect(first).not.toContain(REFRESH_TOKEN);
    expect(first.split(":")).toHaveLength(5);
    expect(first.startsWith(`v1:${key.id}:`)).toBe(true);
    expect(openToken([key], first, connectionId)).toEqual(
      Either.right(REFRESH_TOKEN),
    );
    expect(openToken([key], second, connectionId)).toEqual(
      Either.right(REFRESH_TOKEN),
    );
  });

  it("detects a changed ciphertext, tag or IV", () => {
    // #given
    const key = newKey();
    const [version, keyId, iv, tag, ciphertext] = sealToken(
      key,
      REFRESH_TOKEN,
      connectionId,
    ).split(":") as SealedParts;

    // #when
    const tampered = [
      [version, keyId, iv, tag, flipMiddleBit(ciphertext)],
      [version, keyId, iv, flipMiddleBit(tag), ciphertext],
      [version, keyId, flipMiddleBit(iv), tag, ciphertext],
    ].map((parts) => openToken([key], parts.join(":"), connectionId));

    // #then
    expect(tampered).toEqual([
      Either.left("tampered"),
      Either.left("tampered"),
      Either.left("tampered"),
    ]);
  });

  it.each([
    ["tag", 3],
    ["ciphertext", 4],
  ] as const)(
    "refuses a %s that isn't canonical base64url, though it decodes to the same bytes",
    (_label, index) => {
      // #given
      const key = newKey();
      // 40 bytes: not a multiple of 3, so the ciphertext has spare bits.
      const plaintext = `${REFRESH_TOKEN}!`;
      const parts = sealToken(key, plaintext, connectionId).split(
        ":",
      ) as SealedParts;
      parts[index] = withSpareBitSet(parts[index]);

      // #when
      const opened = openToken([key], parts.join(":"), connectionId);

      // #then
      expect(opened).toEqual(Either.left("malformed"));
    },
  );

  it("won't open a token sealed for another connection", () => {
    // #given
    const key = newKey();
    const sealed = sealToken(key, REFRESH_TOKEN, connectionId);

    // #then
    expect(openToken([key], sealed, randomUUID())).toEqual(
      Either.left("tampered"),
    );
  });

  it("won't open with the wrong key", () => {
    // #given
    const sealed = sealToken(newKey(), REFRESH_TOKEN, connectionId);
    const otherKey = newKey();

    // #then
    expect(openToken([otherKey], sealed, connectionId)).toEqual(
      Either.left("unknown_key"),
    );
    const forged = sealed.replace(/^v1:[0-9a-f]{8}:/, `v1:${otherKey.id}:`);
    expect(openToken([otherKey], forged, connectionId)).toEqual(
      Either.left("tampered"),
    );
  });

  it("opens tokens sealed with an earlier key while it's still loaded", () => {
    // #given
    const oldKey = newKey();
    const newerKey = newKey();
    const sealedWithOld = sealToken(oldKey, REFRESH_TOKEN, connectionId);

    // #then
    expect(openToken([newerKey, oldKey], sealedWithOld, connectionId)).toEqual(
      Either.right(REFRESH_TOKEN),
    );
  });

  it.each([
    ["no version", "abc"],
    ["another version", "v2:abcdef12:aaaa:bbbb:cccc"],
    ["a short IV", "v1:{id}:AAAA:AAAAAAAAAAAAAAAAAAAAAA:AAAA"],
  ])("refuses a value with %s as malformed", (_label, raw) => {
    // #given
    const key = newKey();

    // #then
    expect(openToken([key], raw.replace("{id}", key.id), connectionId)).toEqual(
      Either.left("malformed"),
    );
  });
});

describe("signState / verifyState", () => {
  const state = {
    connectionId: randomUUID(),
    organizationId: randomUUID(),
    linkHashPrefix: "0123456789abcdef",
    expiresAt: new Date(Date.now() + 15 * 60_000),
  };

  it("round-trips", () => {
    // #given
    const key = newKey();

    // #when
    const verified = verifyState(key, signState(key, state), new Date());

    // #then
    expect(verified).toEqual({
      ...state,
      expiresAt: new Date(Math.floor(state.expiresAt.getTime() / 1000) * 1000),
    });
  });

  it("refuses a changed payload or signature", () => {
    // #given
    const key = newKey();
    const [payload, mac] = signState(key, state).split(".") as [string, string];
    const otherPayload = Buffer.from(
      JSON.stringify({
        c: randomUUID(),
        o: state.organizationId,
        h: state.linkHashPrefix,
        e: Math.floor(state.expiresAt.getTime() / 1000),
      }),
    ).toString("base64url");

    // #then
    expect(verifyState(key, `${otherPayload}.${mac}`, new Date())).toBeNull();
    expect(
      verifyState(key, `${payload}.${flipMiddleBit(mac)}`, new Date()),
    ).toBeNull();
    expect(verifyState(key, `${payload}`, new Date())).toBeNull();
    expect(verifyState(key, `${payload}.${mac}.extra`, new Date())).toBeNull();
  });

  it("refuses a signature that isn't canonical base64url, though it decodes to the same bytes", () => {
    // #given
    const key = newKey();
    const [payload, mac] = signState(key, state).split(".") as [string, string];

    // #when
    const verified = verifyState(
      key,
      `${payload}.${withSpareBitSet(mac)}`,
      new Date(),
    );

    // #then
    expect(verified).toBeNull();
  });

  it("refuses a state signed with another key", () => {
    // #then
    expect(
      verifyState(newKey(), signState(newKey(), state), new Date()),
    ).toBeNull();
  });

  it("refuses an expired state", () => {
    // #given
    const key = newKey();

    // #then
    expect(
      verifyState(
        key,
        signState(key, state),
        new Date(state.expiresAt.getTime() + 1000),
      ),
    ).toBeNull();
  });
});

describe("AccountingTokenKeyLive", () => {
  const load = (env: Record<string, string>) =>
    Effect.runPromiseExit(
      Effect.provide(
        AccountingTokenKey,
        AccountingTokenKeyLive.pipe(
          Layer.provide(
            Layer.setConfigProvider(
              ConfigProvider.fromMap(new Map(Object.entries(env))),
            ),
          ),
        ),
      ),
    );

  it("is empty without ACCOUNTING_TOKEN_KEY", async () => {
    // #when
    const exit = await load({});

    // #then
    expect(exit).toEqual(Exit.succeed(Option.none()));
  });

  it("loads a valid key", async () => {
    // #when
    const exit = await load({
      ACCOUNTING_TOKEN_KEY: randomBytes(32).toString("base64"),
    });

    // #then
    expect(Exit.isSuccess(exit) && Option.isSome(exit.value)).toBe(true);
  });

  it("stops startup on a key that isn't 32 bytes", async () => {
    // #when
    const exit = await load({
      ACCOUNTING_TOKEN_KEY: randomBytes(16).toString("base64"),
    });

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
