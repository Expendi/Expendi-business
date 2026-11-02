import type pg from "pg";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Effect, Layer } from "effect";

import type { StaffRole, StaffStatus } from "@expendi-business/shared";

import type { StaffUser } from "../../src/db/schema/index.js";
import type { Transaction } from "../../src/db/scope.js";
import type { DatabaseError } from "../../src/errors.js";
import { DatabaseService } from "../../src/db/client.js";
import * as schema from "../../src/db/schema/index.js";
import { staffUsers } from "../../src/db/schema/index.js";
import { query, withScope } from "../../src/db/scope.js";
import { NotFound } from "../../src/errors.js";
import { AuditLog } from "../../src/services/audit/audit-log.js";

const ACTOR = { type: "system", id: "add-staff" } as const;

type Outcome = "added" | "updated" | "disabled" | "unchanged";

export interface StaffUserChange {
  readonly outcome: Outcome;
  readonly staffUserId: string;
  readonly email: string;
  readonly role: StaffRole;
  readonly status: StaffStatus;
}

function toChange(outcome: Outcome, row: StaffUser): StaffUserChange {
  return {
    outcome,
    staffUserId: row.id,
    email: row.email,
    role: row.role,
    status: row.status,
  };
}

/**
 * `staff_users` is written only as the owner role (`DATABASE_URL_MIGRATE`);
 * the API's role has no grant on it.
 */
export function ownerDatabase(pool: pg.Pool): Layer.Layer<DatabaseService> {
  return Layer.succeed(DatabaseService, {
    db: drizzle(pool, { schema }),
    pool,
  });
}

function lockByEmail(
  tx: Transaction,
  email: string,
): Effect.Effect<StaffUser | null, DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(staffUsers)
      .where(eq(staffUsers.email, email))
      .for("update")
      .limit(1),
  ).pipe(Effect.map(([row]) => row ?? null));
}

function updateStaffUser(
  tx: Transaction,
  id: string,
  values: { readonly role?: StaffRole; readonly status: StaffStatus },
): Effect.Effect<StaffUser, DatabaseError> {
  return query(() =>
    tx.update(staffUsers).set(values).where(eq(staffUsers.id, id)).returning(),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.dieMessage(`staff ${id} vanished`),
    ),
  );
}

/**
 * Adds a staff member, or gives an existing one this role and re-activates
 * them. `email` must already be normalised.
 */
export function addStaffUser(input: {
  readonly email: string;
  readonly role: StaffRole;
}): Effect.Effect<StaffUserChange, DatabaseError, DatabaseService | AuditLog> {
  return withScope({}, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const existing = yield* lockByEmail(tx, input.email);

      if (!existing) {
        const [added] = yield* query(() =>
          tx
            .insert(staffUsers)
            .values({ email: input.email, role: input.role })
            .returning(),
        );
        if (!added)
          return yield* Effect.dieMessage("staff insert returned no row");
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId: null,
          action: "staff_user.added",
          entity: { type: "staff_user", id: added.id },
          after: { email: added.email, role: added.role, status: added.status },
        });
        return toChange("added", added);
      }

      if (existing.role === input.role && existing.status === "active") {
        return toChange("unchanged", existing);
      }

      const updated = yield* updateStaffUser(tx, existing.id, {
        role: input.role,
        status: "active",
      });
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: null,
        action: "staff_user.updated",
        entity: { type: "staff_user", id: updated.id },
        before: { role: existing.role, status: existing.status },
        after: { role: updated.role, status: updated.status },
      });
      return toChange("updated", updated);
    }),
  );
}

/** Disables a staff member: their next request to `/internal/*` gets 403. */
export function disableStaffUser(
  email: string,
): Effect.Effect<
  StaffUserChange,
  NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return withScope({}, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const existing = yield* lockByEmail(tx, email);
      if (!existing) {
        return yield* new NotFound({
          message: `No staff member has the email ${email}`,
        });
      }
      if (existing.status === "disabled") {
        return toChange("unchanged", existing);
      }

      const disabled = yield* updateStaffUser(tx, existing.id, {
        status: "disabled",
      });
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: null,
        action: "staff_user.disabled",
        entity: { type: "staff_user", id: disabled.id },
        before: { status: existing.status },
        after: { status: disabled.status },
      });
      return toChange("disabled", disabled);
    }),
  );
}
