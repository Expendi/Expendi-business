import type pg from "pg";
import { randomUUID } from "node:crypto";

import type { StaffRole, StaffStatus } from "@expendi-business/shared";

import { fakePrivyEmails } from "./runtime.js";

export interface TestStaff {
  readonly staffUserId: string;
  readonly privyUserId: string;
  readonly email: string;
  readonly role: StaffRole;
}

/**
 * A staff member with a Privy login for their email. Inserted as the owner
 * role: the API's role can't write `staff_users`. Pass an existing company
 * user's email and Privy ID to make one login both staff and a customer.
 */
export async function createStaff(
  owner: pg.Pool,
  options: {
    role?: StaffRole;
    status?: StaffStatus;
    email?: string;
    privyUserId?: string;
  } = {},
): Promise<TestStaff> {
  const email = options.email ?? `staff-${randomUUID()}@expendi.test`;
  const role = options.role ?? "ops_admin";
  const {
    rows: [row],
  } = await owner.query<{ id: string }>(
    "INSERT INTO staff_users (email, role, status) VALUES ($1, $2, $3) RETURNING id",
    [email, role, options.status ?? "active"],
  );
  if (!row) throw new Error("staff insert returned no row");
  const privyUserId = options.privyUserId ?? `did:privy:${randomUUID()}`;
  fakePrivyEmails.set(privyUserId, email);
  return { staffUserId: row.id, privyUserId, email, role };
}

/** A Privy login whose email isn't on the staff list. */
export function createNonStaffLogin(): { privyUserId: string; email: string } {
  const email = `not-staff-${randomUUID()}@example.com`;
  const privyUserId = `did:privy:${randomUUID()}`;
  fakePrivyEmails.set(privyUserId, email);
  return { privyUserId, email };
}
