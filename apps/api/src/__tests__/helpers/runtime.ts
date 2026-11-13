import { ConfigProvider, Effect, Layer } from "effect";

import type {
  AppDeps,
  AppLayerError,
  ExternalLayers,
} from "../../layers/main.js";
import type { AppRuntime } from "../../runtime.js";
import { makeAppLayer } from "../../layers/main.js";
import { makeRuntime } from "../../runtime.js";
import {
  InvalidAccessToken,
  PrivyAuth,
} from "../../services/auth/privy-auth.js";
import { PretiumReceiptPolling } from "../../services/payout/pretium-fund.js";
import {
  makeFakeAlchemyWebhook,
  makeFakeBaseRpc,
  makeFakeEmailSender,
  makeFakeFileStorage,
  makeFakeLithic,
  makeFakeOtpProvider,
  makeFakePaycrest,
  makeFakePretium,
  makeFakePrivyWallets,
  makeFakeReceiptExtractor,
  makeFakeZoho,
  TestApprovalSettings,
  TestWalletSettings,
} from "./fakes.js";
import { makeFakeFastNear } from "./fast-near.js";
import { makeFakeNearRelayer, makeFakeNearRpc, TestNearChain } from "./near.js";
import { makeFakeOneClick } from "./one-click.js";
import { makeFakePushSender } from "./push.js";

const TOKEN_PREFIX = "test-token:";

/** Emails the fake Privy reports, keyed by Privy user ID. */
export const fakePrivyEmails = new Map<string, string | null>();

/**
 * Optional hold before the fake answers an email lookup, keyed by Privy user
 * ID. Lets a test line up concurrent first logins.
 */
export const fakePrivyEmailLookupGates = new Map<string, () => Promise<void>>();

/** Resolves for every caller once `parties` callers have arrived. */
export function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return () => {
    arrived += 1;
    if (arrived === parties) open();
    return opened;
  };
}

/**
 * When the fake says a Privy user's token was minted and when they last
 * signed in, keyed by Privy user ID. Unset means just now.
 */
export const fakePrivyTokenIssuedAt = new Map<string, Date>();
export const fakePrivyLastSignInAt = new Map<string, Date | null>();

/**
 * Accepts `test-token:<privyUserId>`. Real token verification is covered
 * separately against locally signed JWTs.
 */
export const FakePrivyAuth = Layer.succeed(PrivyAuth, {
  verifyAccessToken: (accessToken) => {
    if (!accessToken.startsWith(TOKEN_PREFIX)) {
      return Effect.fail(new InvalidAccessToken({ cause: "not a test token" }));
    }
    const privyUserId = accessToken.slice(TOKEN_PREFIX.length);
    return Effect.succeed({
      privyUserId,
      issuedAt: fakePrivyTokenIssuedAt.get(privyUserId) ?? new Date(),
    });
  },
  getEmail: (privyUserId) =>
    Effect.promise(
      () => fakePrivyEmailLookupGates.get(privyUserId)?.() ?? Promise.resolve(),
    ).pipe(Effect.as(fakePrivyEmails.get(privyUserId) ?? null)),
  lastSignInAt: (privyUserId) =>
    Effect.sync(() =>
      fakePrivyLastSignInAt.has(privyUserId)
        ? (fakePrivyLastSignInAt.get(privyUserId) ?? null)
        : new Date(),
    ),
});

/** The test environment with `env` laid over it; `undefined` unsets a variable. */
function environmentWith(
  env: Readonly<Record<string, string | undefined>>,
): ConfigProvider.ConfigProvider {
  const merged = Object.entries({ ...process.env, ...env }).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  return ConfigProvider.fromMap(new Map(merged));
}

/**
 * The real API and database with every external provider faked. Pass a
 * fake's layer to inspect or steer it from the test, and `env` to change
 * the API's configuration for this runtime only.
 */
export function makeTestRuntime(
  overrides: Partial<ExternalLayers> = {},
  env: Readonly<Record<string, string | undefined>> = {},
): AppRuntime {
  return makeRuntime(makeTestLayer(overrides, env));
}

/** What `makeTestRuntime` runs on, for a test that lays its own layer over it. */
export function makeTestLayer(
  overrides: Partial<ExternalLayers> = {},
  env: Readonly<Record<string, string | undefined>> = {},
): Layer.Layer<AppDeps, AppLayerError> {
  const layer = makeAppLayer({
    privyAuth: FakePrivyAuth,
    privyWallets: makeFakePrivyWallets().layer,
    walletSettings: TestWalletSettings,
    alchemyWebhook: makeFakeAlchemyWebhook().layer,
    baseRpc: makeFakeBaseRpc().layer,
    nearChain: TestNearChain,
    nearRpc: makeFakeNearRpc().layer,
    nearRelayer: makeFakeNearRelayer().layer,
    fastNear: makeFakeFastNear().layer,
    oneClick: makeFakeOneClick().layer,
    paycrest: makeFakePaycrest().layer,
    pretium: makeFakePretium().layer,
    lithic: makeFakeLithic().layer,
    approvalSettings: TestApprovalSettings,
    emailSender: makeFakeEmailSender().layer,
    otpProvider: makeFakeOtpProvider().layer,
    pushSender: makeFakePushSender().layer,
    fileStorage: makeFakeFileStorage().layer,
    receiptExtractor: makeFakeReceiptExtractor().layer,
    zoho: makeFakeZoho().layer,
    ...overrides,
  }).pipe(
    // Fake chains answer at once; a test that waits for a receipt asks.
    Layer.merge(
      Layer.succeed(PretiumReceiptPolling, { retries: 0, interval: 0 }),
    ),
  );
  return Object.keys(env).length === 0
    ? layer
    : layer.pipe(Layer.provide(Layer.setConfigProvider(environmentWith(env))));
}

export function bearer(privyUserId: string): { authorization: string } {
  return { authorization: `Bearer ${TOKEN_PREFIX}${privyUserId}` };
}
