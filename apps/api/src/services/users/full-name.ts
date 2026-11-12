import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { UpdateMeResponse } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import { users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";

const PROFILE = {
  id: users.id,
  email: users.email,
  phone: users.phone,
  fullName: users.fullName,
};

/**
 * The signed-in person sets their own name (spec §6.2): a cash-out pays
 * M-Pesa in the recipient's name, and a company's creator has none until they give
 * it. Like `user.linked`, the audit entry belongs to the person, not a
 * company. Setting the name it already has changes and records nothing.
 */
export function updateFullName(
  userId: string,
  fullName: string,
): Effect.Effect<UpdateMeResponse, DatabaseError, DatabaseService | AuditLog> {
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const [current] = yield* query(() =>
        tx
          .select(PROFILE)
          .from(users)
          .where(eq(users.id, userId))
          .for("update"),
      );
      if (!current) {
        return yield* Effect.dieMessage(
          `authenticated user ${userId} has no row`,
        );
      }
      if (current.fullName === fullName) return current;

      const [updated] = yield* query(() =>
        tx
          .update(users)
          .set({ fullName })
          .where(eq(users.id, userId))
          .returning(PROFILE),
      );
      if (!updated) return yield* Effect.dieMessage("name update wrote no row");
      const audit = yield* AuditLog;
      yield* audit.record(tx, {
        actor: { type: "user", id: userId },
        organizationId: null,
        action: "user.name_changed",
        entity: { type: "user", id: userId },
        before: { fullName: current.fullName },
        after: { fullName },
      });
      return updated;
    }),
  );
}
