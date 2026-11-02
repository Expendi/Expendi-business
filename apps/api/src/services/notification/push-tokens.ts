import { and, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  RegisterPushTokenRequest,
  RegisterPushTokenResponse,
  UnregisterPushTokenResponse,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import { pushTokens } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { DatabaseError } from "../../errors.js";

/**
 * A person's Expo push tokens (spec §6.10), ported from the consumer
 * backend's `push-token-service.ts`. The app registers its token after every
 * sign-in and unregisters it on sign-out.
 */

/** Enough of a token to tell two apart in a log; never the whole credential. */
export function maskPushToken(token: string): string {
  return `${token.slice(0, token.indexOf("[") + 5)}…`;
}

/** Drizzle's errors quote the query's parameters, so a failure would log the token. */
function maskedIn(token: string) {
  return (error: DatabaseError) =>
    new DatabaseError({
      message: error.message.replaceAll(token, maskPushToken(token)),
      cause: null,
    });
}

/**
 * Registers this app install's token for `userId`. Someone else who signed
 * in on the same device before loses it, so their notifications stop
 * reaching a phone they've signed out of.
 */
export function registerPushToken(
  userId: string,
  { token, platform }: RegisterPushTokenRequest,
): Effect.Effect<RegisterPushTokenResponse, DatabaseError, DatabaseService> {
  return withScope({ userId }, (tx) =>
    query(() =>
      tx.execute<{ moved: boolean }>(
        sql`SELECT register_push_token(${token}, ${platform}::push_platform) AS moved`,
      ),
    ),
  ).pipe(
    Effect.mapError(maskedIn(token)),
    Effect.tap(({ rows: [result] }) =>
      result?.moved
        ? Effect.sync(() => {
            console.log(
              `[push] token ${maskPushToken(token)} moved to user ${userId}`,
            );
          })
        : Effect.void,
    ),
    Effect.as({ registered: true } as const),
  );
}

/** Signing out: this device stops receiving the person's notifications. */
export function unregisterPushToken(
  userId: string,
  token: string,
): Effect.Effect<UnregisterPushTokenResponse, DatabaseError, DatabaseService> {
  return withScope({ userId }, (tx) =>
    query(() =>
      tx
        .update(pushTokens)
        .set({ disabledAt: new Date() })
        .where(
          and(
            eq(pushTokens.userId, userId),
            eq(pushTokens.token, token),
            isNull(pushTokens.disabledAt),
          ),
        )
        .returning({ id: pushTokens.id }),
    ),
  ).pipe(
    Effect.mapError(maskedIn(token)),
    Effect.map((disabled) => ({ unregistered: disabled.length > 0 })),
  );
}
