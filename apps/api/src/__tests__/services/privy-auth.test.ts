import { PrivyClient } from "@privy-io/node";
import { Effect, Exit } from "effect";
import { exportSPKI, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";

import type { PrivyAuthShape } from "../../services/auth/privy-auth.js";
import { makePrivyAuth } from "../../services/auth/privy-auth.js";

const APP_ID = "expendi-business-test-app";
const PRIVY_USER_ID = "did:privy:cm0000000000000000000000";

type SigningKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

let privy: PrivyAuthShape;
let appKey: SigningKey;
let otherKey: SigningKey;

beforeAll(async () => {
  const appPair = await generateKeyPair("ES256");
  appKey = appPair.privateKey;
  otherKey = (await generateKeyPair("ES256")).privateKey;
  privy = makePrivyAuth(
    new PrivyClient({
      appId: APP_ID,
      appSecret: "unused-in-these-tests",
      jwtVerificationKey: await exportSPKI(appPair.publicKey),
    }),
  );
});

interface TokenOptions {
  readonly key?: SigningKey;
  readonly audience?: string;
  readonly issuer?: string;
  readonly expiresAt?: number;
}

function accessToken(options: TokenOptions = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ sid: "session-1" })
    .setProtectedHeader({ alg: "ES256", typ: "JWT" })
    .setSubject(PRIVY_USER_ID)
    .setIssuer(options.issuer ?? "privy.io")
    .setAudience(options.audience ?? APP_ID)
    .setIssuedAt(now - 60)
    .setExpirationTime(options.expiresAt ?? now + 3600)
    .sign(options.key ?? appKey);
}

describe("PrivyAuth.verifyAccessToken (real Privy SDK verification)", () => {
  it("accepts a valid token for this app and returns the Privy user ID", async () => {
    // #given
    const token = await accessToken();

    // #when
    const result = await Effect.runPromise(privy.verifyAccessToken(token));

    // #then
    expect(result).toEqual({ privyUserId: PRIVY_USER_ID });
  });

  it.each<[string, () => Promise<string>]>([
    [
      "an expired token",
      () => accessToken({ expiresAt: Math.floor(Date.now() / 1000) - 10 }),
    ],
    [
      "a token for another Privy app",
      () => accessToken({ audience: "consumer-app" }),
    ],
    [
      "a token from another issuer",
      () => accessToken({ issuer: "evil.example" }),
    ],
    ["a token signed with another key", () => accessToken({ key: otherKey })],
    ["a malformed token", () => Promise.resolve("not.a.jwt")],
  ])("rejects %s", async (_label, makeToken) => {
    // #given
    const token = await makeToken();

    // #when
    const exit = await Effect.runPromiseExit(privy.verifyAccessToken(token));

    // #then
    expect(exit).toMatchObject({
      _tag: "Failure",
      cause: { error: { _tag: "InvalidAccessToken" } },
    });
    expect(Exit.isFailure(exit)).toBe(true);
  });
});
