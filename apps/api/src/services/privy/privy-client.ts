import type { ConfigError } from "effect";
import { PrivyClient } from "@privy-io/node";
import { Config, Context, Effect, Layer, Option, Redacted } from "effect";

/** The Expendi Business Privy app, shared by login and wallets. */
export class PrivyClientService extends Context.Tag("PrivyClientService")<
  PrivyClientService,
  PrivyClient
>() {}

/**
 * Set PRIVY_JWT_VERIFICATION_KEY (from the Privy dashboard) to verify
 * access tokens locally instead of fetching Privy's JWKS.
 */
export const PrivyClientLive: Layer.Layer<
  PrivyClientService,
  ConfigError.ConfigError
> = Layer.effect(
  PrivyClientService,
  Effect.gen(function* () {
    const appId = yield* Config.string("PRIVY_APP_ID");
    const appSecret = yield* Config.redacted("PRIVY_APP_SECRET");
    const verificationKey = yield* Config.option(
      Config.redacted("PRIVY_JWT_VERIFICATION_KEY"),
    );
    return new PrivyClient({
      appId,
      appSecret: Redacted.value(appSecret),
      jwtVerificationKey: Option.getOrUndefined(
        Option.map(verificationKey, Redacted.value),
      ),
    });
  }),
);
