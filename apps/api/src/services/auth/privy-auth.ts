import type { PrivyClient } from "@privy-io/node";
import type { ConfigError } from "effect";
import { Context, Data, Effect, Layer } from "effect";

import { PrivyClientLive, PrivyClientService } from "../privy/privy-client.js";

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

export const PrivyAuthLive: Layer.Layer<PrivyAuth, ConfigError.ConfigError> =
  Layer.effect(PrivyAuth, Effect.map(PrivyClientService, makePrivyAuth)).pipe(
    Layer.provide(PrivyClientLive),
  );
