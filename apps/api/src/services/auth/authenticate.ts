import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseError } from "../../errors.js";
import type { PrivyApiError } from "./privy-auth.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Forbidden, Unauthorized } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { PrivyAuth } from "./privy-auth.js";

export interface AuthenticatedUser {
  readonly userId: string;
}

const unauthorized = new Unauthorized({ message: "Unauthorized" });

/** Emails are stored lowercased so invites and logins match regardless of case. */
export function normalizeEmail(raw: string): string | null {
  const email = raw.trim().toLowerCase();
  return email.includes("@") ? email : null;
}

function findUserByPrivyId(
  privyUserId: string,
): Effect.Effect<string | null, DatabaseError, DatabaseService> {
  return Effect.flatMap(DatabaseService, ({ db }) =>
    query(() =>
      db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.privyUserId, privyUserId))
        .limit(1),
    ),
  ).pipe(Effect.map(([user]) => user?.id ?? null));
}

/**
 * First login for this Privy user. In one transaction, in order:
 * 1. claim the row an invite created for this email (no Privy ID yet),
 * 2. or create the user,
 * 3. or, if a concurrent request just created it, use that row.
 * An email already bound to a different Privy user is refused, never moved.
 */
function registerUser(
  privyUserId: string,
  email: string,
): Effect.Effect<
  AuthenticatedUser,
  Forbidden | DatabaseError,
  DatabaseService | AuditLog
> {
  return withScope({}, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const recordAs = (userId: string, action: string) =>
        audit.record(tx, {
          actor: { type: "user", id: userId },
          organizationId: null,
          action,
          entity: { type: "user", id: userId },
          after: { privyUserId, email },
        });

      const [claimed] = yield* query(() =>
        tx
          .update(users)
          .set({ privyUserId })
          .where(and(eq(users.email, email), isNull(users.privyUserId)))
          .returning({ id: users.id }),
      );
      if (claimed) {
        yield* recordAs(claimed.id, "user.linked");
        return { userId: claimed.id };
      }

      const [created] = yield* query(() =>
        tx
          .insert(users)
          .values({ privyUserId, email })
          .onConflictDoNothing()
          .returning({ id: users.id }),
      );
      if (created) {
        yield* recordAs(created.id, "user.registered");
        return { userId: created.id };
      }

      const [existing] = yield* query(() =>
        tx
          .select({ id: users.id })
          .from(users)
          .where(eq(users.privyUserId, privyUserId))
          .limit(1),
      );
      if (existing) return { userId: existing.id };

      console.warn(
        `[auth] email already bound to another Privy user; refusing login for ${privyUserId}`,
      );
      return yield* new Forbidden({
        message: "This email is linked to another account",
      });
    }),
  );
}

/**
 * Verifies a Privy access token and resolves it to our user, creating the
 * user exactly once on first login. Login is email + passkey (spec §4); the
 * payout phone is captured separately (§6.18).
 */
export function authenticate(
  accessToken: string,
): Effect.Effect<
  AuthenticatedUser,
  Unauthorized | Forbidden | PrivyApiError | DatabaseError,
  PrivyAuth | DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const privy = yield* PrivyAuth;
    const { privyUserId } = yield* privy
      .verifyAccessToken(accessToken)
      .pipe(Effect.mapError(() => unauthorized));

    const existingUserId = yield* findUserByPrivyId(privyUserId);
    if (existingUserId) return { userId: existingUserId };

    const rawEmail = yield* privy.getEmail(privyUserId);
    const email = rawEmail === null ? null : normalizeEmail(rawEmail);
    if (!email) {
      return yield* new Forbidden({
        message: "Sign in with your email to use Expendi Business",
      });
    }
    return yield* registerUser(privyUserId, email);
  });
}
