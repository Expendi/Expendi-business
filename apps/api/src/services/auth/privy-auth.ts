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

export interface VerifiedAccessToken {
  readonly privyUserId: string;
  /**
   * When Privy minted this token. The app refreshes tokens silently from
   * its session, so this is not when the person last signed in.
   */
  readonly issuedAt: Date;
}

/** The slice of Privy that login needs. */
export interface PrivyAuthShape {
  /** Checks signature, issuer, audience (our app ID) and expiry. */
  readonly verifyAccessToken: (
    accessToken: string,
  ) => Effect.Effect<VerifiedAccessToken, InvalidAccessToken>;
  /** The verified email linked to the Privy user, as Privy stores it. */
  readonly getEmail: (
    privyUserId: string,
  ) => Effect.Effect<string | null, PrivyApiError>;
  /**
   * When the person last proved who they are (an email code or a passkey),
   * by Privy's record; null if Privy has none.
   */
  readonly lastSignInAt: (
    privyUserId: string,
  ) => Effect.Effect<Date | null, PrivyApiError>;
}

export class PrivyAuth extends Context.Tag("PrivyAuth")<
  PrivyAuth,
  PrivyAuthShape
>() {}

/** How people sign in (spec §4): an email code, or a passkey. */
const LOGIN_METHODS: ReadonlySet<string> = new Set(["email", "passkey"]);

/**
 * The latest time one of the user's login methods was verified. Privy
 * stamps `latest_verified_at` (unix seconds) when an account is used to
 * sign in, unlike a silently refreshed access token.
 */
export function lastSignInFrom(
  linkedAccounts: readonly {
    readonly type: string;
    readonly latest_verified_at: number | null;
  }[],
): Date | null {
  const latest = Math.max(
    0,
    ...linkedAccounts
      .filter((account) => LOGIN_METHODS.has(account.type))
      .map((account) => account.latest_verified_at ?? 0),
  );
  return latest > 0 ? new Date(latest * 1000) : null;
}

export const makePrivyAuth = (client: PrivyClient): PrivyAuthShape => {
  const getUser = (privyUserId: string) =>
    Effect.tryPromise({
      try: () => client.users()._get(privyUserId),
      catch: (cause) =>
        new PrivyApiError({ message: "Failed to fetch Privy user", cause }),
    });
  return {
    verifyAccessToken: (accessToken) =>
      Effect.tryPromise({
        try: () => client.utils().auth().verifyAccessToken(accessToken),
        catch: (cause) => new InvalidAccessToken({ cause }),
      }).pipe(
        Effect.map((payload) => ({
          privyUserId: payload.user_id,
          issuedAt: new Date(payload.issued_at * 1000),
        })),
      ),
    getEmail: (privyUserId) =>
      getUser(privyUserId).pipe(
        Effect.map(
          (user) =>
            user.linked_accounts.find((account) => account.type === "email")
              ?.address ?? null,
        ),
      ),
    lastSignInAt: (privyUserId) =>
      getUser(privyUserId).pipe(
        Effect.map((user) => lastSignInFrom(user.linked_accounts)),
      ),
  };
};

export const PrivyAuthLive: Layer.Layer<PrivyAuth, ConfigError.ConfigError> =
  Layer.effect(PrivyAuth, Effect.map(PrivyClientService, makePrivyAuth)).pipe(
    Layer.provide(PrivyClientLive),
  );
