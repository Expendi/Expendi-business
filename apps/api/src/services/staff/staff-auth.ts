import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { StaffRole } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { PrivyApiError } from "../auth/privy-auth.js";
import { query, withScope } from "../../db/scope.js";
import { Forbidden, Unauthorized } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { normalizeEmail } from "../auth/authenticate.js";
import { PrivyAuth } from "../auth/privy-auth.js";

/** An active row in `staff_users`; never a company `users` row. */
export interface StaffMember {
  readonly staffUserId: string;
  readonly email: string;
  readonly role: StaffRole;
}

interface ActiveStaffRow extends Record<string, unknown> {
  readonly staff_user_id: string;
  readonly email: string;
  readonly role: StaffRole;
}

const unauthorized = new Unauthorized({ message: "Unauthorized" });

const notOnStaffList = new Forbidden({
  message: "This email isn't on the Expendi staff list",
});

function activeStaffByEmail(
  email: string,
): Effect.Effect<StaffMember | null, DatabaseError, DatabaseService> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<ActiveStaffRow>(
        sql`SELECT staff_user_id, email, role FROM active_staff_by_email(${email})`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows: [row] }) =>
      row
        ? { staffUserId: row.staff_user_id, email: row.email, role: row.role }
        : null,
    ),
  );
}

/**
 * Verifies a Privy access token and resolves its email to an active staff
 * member (spec §6.15). Staff login is separate from customer login: this
 * never reads or creates a `users` row. The email and the staff row are
 * looked up on every request, so unlinking the email in Privy or disabling
 * the staff member takes effect at once.
 */
export function authenticateStaff(
  accessToken: string,
): Effect.Effect<
  StaffMember,
  Unauthorized | Forbidden | PrivyApiError | DatabaseError,
  PrivyAuth | DatabaseService
> {
  return Effect.gen(function* () {
    const privy = yield* PrivyAuth;
    const { privyUserId } = yield* privy
      .verifyAccessToken(accessToken)
      .pipe(Effect.mapError(() => unauthorized));

    const rawEmail = yield* privy.getEmail(privyUserId);
    const email = rawEmail === null ? null : normalizeEmail(rawEmail);
    const staff = email === null ? null : yield* activeStaffByEmail(email);
    if (!staff) {
      console.warn(
        `[staff-auth] refused ${privyUserId}: not an active staff member`,
      );
      return yield* notOnStaffList;
    }
    return staff;
  });
}

/** Audits a staff sign-in (spec §6.13). The admin app calls it once per sign-in. */
export function recordStaffSignIn(
  staff: StaffMember,
): Effect.Effect<void, DatabaseError, DatabaseService | AuditLog> {
  return withScope({}, (tx) =>
    Effect.flatMap(AuditLog, (audit) =>
      audit.record(tx, {
        actor: { type: "staff", id: staff.staffUserId },
        organizationId: null,
        action: "staff.signed_in",
        entity: { type: "staff_user", id: staff.staffUserId },
        after: { email: staff.email, role: staff.role },
      }),
    ),
  );
}
