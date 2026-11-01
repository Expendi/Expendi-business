import { ConfigProvider, Effect, Layer } from "effect";

import type { ExternalLayers } from "../../layers/main.js";
import type { AppRuntime } from "../../runtime.js";
import { makeAppLayer } from "../../layers/main.js";
import { makeRuntime } from "../../runtime.js";
import {
  InvalidAccessToken,
  PrivyAuth,
} from "../../services/auth/privy-auth.js";
import {
  makeFakeAlchemyWebhook,
  makeFakeBaseRpc,
  makeFakeEmailSender,
  makeFakeOtpProvider,
  makeFakePaycrest,
  makeFakePrivyWallets,
  TestApprovalSettings,
  TestWalletSettings,
} from "./fakes.js";

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
 * Accepts `test-token:<privyUserId>`. Real token verification is covered
 * separately against locally signed JWTs.
 */
export const FakePrivyAuth = Layer.succeed(PrivyAuth, {
  verifyAccessToken: (accessToken) =>
    accessToken.startsWith(TOKEN_PREFIX)
      ? Effect.succeed({ privyUserId: accessToken.slice(TOKEN_PREFIX.length) })
      : Effect.fail(new InvalidAccessToken({ cause: "not a test token" })),
  getEmail: (privyUserId) =>
    Effect.promise(
      () => fakePrivyEmailLookupGates.get(privyUserId)?.() ?? Promise.resolve(),
    ).pipe(Effect.as(fakePrivyEmails.get(privyUserId) ?? null)),
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
  const layer = makeAppLayer({
    privyAuth: FakePrivyAuth,
    privyWallets: makeFakePrivyWallets().layer,
    walletSettings: TestWalletSettings,
    alchemyWebhook: makeFakeAlchemyWebhook().layer,
    baseRpc: makeFakeBaseRpc().layer,
    paycrest: makeFakePaycrest().layer,
    approvalSettings: TestApprovalSettings,
    emailSender: makeFakeEmailSender().layer,
    otpProvider: makeFakeOtpProvider().layer,
    ...overrides,
  });
  return makeRuntime(
    Object.keys(env).length === 0
      ? layer
      : layer.pipe(
          Layer.provide(Layer.setConfigProvider(environmentWith(env))),
        ),
  );
}

export function bearer(privyUserId: string): { authorization: string } {
  return { authorization: `Bearer ${TOKEN_PREFIX}${privyUserId}` };
}
