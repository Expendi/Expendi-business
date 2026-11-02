import { Effect } from "effect";

import { RecentLoginRequired, ServiceUnavailable } from "../../errors.js";
import { PrivyAuth } from "./privy-auth.js";

/** How recent a sign-in must be for actions that add a way to move money. */
export const RECENT_SIGN_IN_MS = 10 * 60_000;

const signInAgain = new RecentLoginRequired({
  message: "For your security, sign in again, then set up your passkey.",
});

/**
 * Passes only if the person signed in (email code or passkey) within
 * `RECENT_SIGN_IN_MS`, by Privy's record, and presented a token minted in
 * that window. The token's issue time alone isn't enough: the app refreshes
 * tokens silently, so a stolen session can always mint a fresh one.
 */
export function requireRecentSignIn(session: {
  readonly privyUserId: string;
  readonly tokenIssuedAt: Date;
}): Effect.Effect<void, RecentLoginRequired | ServiceUnavailable, PrivyAuth> {
  return Effect.gen(function* () {
    const isRecent = (at: Date) =>
      Date.now() - at.getTime() <= RECENT_SIGN_IN_MS;
    if (!isRecent(session.tokenIssuedAt)) {
      return yield* Effect.fail(signInAgain);
    }

    const privy = yield* PrivyAuth;
    const lastSignInAt = yield* privy.lastSignInAt(session.privyUserId).pipe(
      Effect.catchTag("PrivyApiError", (error) =>
        Effect.sync(() =>
          console.error(`[auth] last sign-in lookup failed: ${error.message}`),
        ).pipe(
          Effect.zipRight(
            Effect.fail(
              new ServiceUnavailable({
                message: "Couldn't check your sign-in. Try again in a minute.",
              }),
            ),
          ),
        ),
      ),
    );
    if (!lastSignInAt || !isRecent(lastSignInAt)) {
      return yield* Effect.fail(signInAgain);
    }
  });
}
