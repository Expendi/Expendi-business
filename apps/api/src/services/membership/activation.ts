import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import { memberships } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * Activates every invite for this user (spec §6.2) once their email has
 * signed in. Their own memberships are visible with only the user in scope;
 * each one is then activated and audited inside its company's scope. Writes
 * only when an invite is waiting.
 */
export function activateInvitedMemberships(
  userId: string,
): Effect.Effect<void, DatabaseError, DatabaseService | AuditLog> {
  return withScope({ userId }, (tx) =>
    query(() =>
      tx
        .select({
          id: memberships.id,
          organizationId: memberships.organizationId,
        })
        .from(memberships)
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.status, "invited"),
          ),
        ),
    ),
  ).pipe(
    Effect.flatMap((invites) =>
      Effect.forEach(
        invites,
        (invite) =>
          withScope({ organizationId: invite.organizationId, userId }, (tx) =>
            Effect.gen(function* () {
              const audit = yield* AuditLog;
              const [activated] = yield* query(() =>
                tx
                  .update(memberships)
                  .set({ status: "active" })
                  .where(
                    and(
                      eq(memberships.id, invite.id),
                      eq(memberships.status, "invited"),
                    ),
                  )
                  .returning({ role: memberships.role }),
              );
              if (!activated) return;
              yield* audit.record(tx, {
                actor: { type: "user", id: userId },
                organizationId: invite.organizationId,
                action: "membership.activated",
                entity: { type: "membership", id: invite.id },
                before: { status: "invited" },
                after: { status: "active", role: activated.role },
              });
            }),
          ),
        { discard: true },
      ),
    ),
  );
}
