import type { ConfigError } from "effect";
import { PrivyClient } from "@privy-io/node";
import { Config, Context, Data, Effect, Layer, Option, Redacted } from "effect";

export class InvalidAccessToken extends Data.TaggedError("InvalidAccessToken")<{
  readonly cause: unknown;
}> {}

export class PrivyApiError extends Data.TaggedError("PrivyApiError")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/** The slice of Privy that login needs. */
export interface PrivyAuthShape {
  /** Checks signature, issuer, audience (our app ID) and expiry. */
  readonly verifyAccessToken: (
    accessToken: string,
  ) => Effect.Effect<{ readonly privyUserId: string }, InvalidAccessToken>;
  /** The verified email linked to the Privy user, as Privy stores it. */
  readonly getEmail: (
    privyUserId: string,
  ) => Effect.Effect<string | null, PrivyApiError>;
}

export class PrivyAuth extends Context.Tag("PrivyAuth")<
  PrivyAuth,
  PrivyAuthShape
>() {}

export const makePrivyAuth = (client: PrivyClient): PrivyAuthShape => ({
  verifyAccessToken: (accessToken) =>
    Effect.tryPromise({
      try: () => client.utils().auth().verifyAccessToken(accessToken),
      catch: (cause) => new InvalidAccessToken({ cause }),
    }).pipe(Effect.map((payload) => ({ privyUserId: payload.user_id }))),
  getEmail: (privyUserId) =>
    Effect.tryPromise({
      try: () => client.users()._get(privyUserId),
      catch: (cause) =>
        new PrivyApiError({ message: "Failed to fetch Privy user", cause }),
    }).pipe(
      Effect.map(
        (user) =>
          user.linked_accounts.find((account) => account.type === "email")
            ?.address ?? null,
      ),
    ),
});

/**
 * Reads the Expendi Business Privy app's credentials. Set
 * PRIVY_JWT_VERIFICATION_KEY (from the Privy dashboard) to verify tokens
 * locally instead of fetching Privy's JWKS.
 */
export const PrivyAuthLive: Layer.Layer<PrivyAuth, ConfigError.ConfigError> =
  Layer.effect(
    PrivyAuth,
    Effect.gen(function* () {
      const appId = yield* Config.string("PRIVY_APP_ID");
      const appSecret = yield* Config.redacted("PRIVY_APP_SECRET");
      const verificationKey = yield* Config.option(
        Config.redacted("PRIVY_JWT_VERIFICATION_KEY"),
      );
      const client = new PrivyClient({
        appId,
        appSecret: Redacted.value(appSecret),
        jwtVerificationKey: Option.getOrUndefined(
          Option.map(verificationKey, Redacted.value),
        ),
      });
      return makePrivyAuth(client);
    }),
  );
