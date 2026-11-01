import { randomUUID } from "node:crypto";

import type {
  MembershipRole,
  MembershipStatus,
} from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import { memberships, organizations, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";

export interface TestUser {
  readonly id: string;
  readonly privyUserId: string;
  readonly email: string;
}

export interface TestCompany {
  readonly organizationId: string;
  readonly name: string;
  readonly admin: TestUser;
  readonly adminMembershipId: string;
}

export function randomEmail(): string {
  return `user-${randomUUID()}@example.com`;
}

export async function createUser(db: Database): Promise<TestUser> {
  const privyUserId = `did:privy:${randomUUID()}`;
  const [user] = await db
    .insert(users)
    .values({ email: randomEmail(), privyUserId })
    .returning({ id: users.id, email: users.email });
  if (!user) throw new Error("user insert returned no row");
  return { ...user, privyUserId };
}

/** Seeds a company with an active admin, the way sign-up will (spec §6.1). */
export async function createCompany(
  db: Database,
  name = `Company ${randomUUID().slice(0, 8)}`,
): Promise<TestCompany> {
  const admin = await createUser(db);
  const organizationId = randomUUID();
  const adminMembershipId = await runInScope(
    db,
    { organizationId, userId: admin.id },
    async (tx) => {
      await tx.insert(organizations).values({ id: organizationId, name });
      const [membership] = await tx
        .insert(memberships)
        .values({
          organizationId,
          userId: admin.id,
          role: "admin",
          status: "active",
        })
        .returning({ id: memberships.id });
      if (!membership) throw new Error("membership insert returned no row");
      return membership.id;
    },
  );
  return { organizationId, name, admin, adminMembershipId };
}

export async function addMember(
  db: Database,
  company: TestCompany,
  user: TestUser,
  options: { role?: MembershipRole; status?: MembershipStatus } = {},
): Promise<string> {
  return runInScope(
    db,
    { organizationId: company.organizationId, userId: company.admin.id },
    async (tx) => {
      const [membership] = await tx
        .insert(memberships)
        .values({
          organizationId: company.organizationId,
          userId: user.id,
          role: options.role ?? "employee",
          status: options.status ?? "active",
          invitedBy: company.admin.id,
        })
        .returning({ id: memberships.id });
      if (!membership) throw new Error("membership insert returned no row");
      return membership.id;
    },
  );
}
