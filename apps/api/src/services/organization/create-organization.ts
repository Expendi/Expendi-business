import { randomUUID } from "node:crypto";
import { Effect } from "effect";

import type {
  CreateOrganizationResponse,
  OrganizationResponse,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { EnsureCompanyWalletDeps } from "../wallet/company-wallet.js";
import { memberships, organizations } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { setUpCompanyWallet } from "../wallet/wallet-setup.js";
import { seedStarterCategories } from "./categories.js";

export interface NewCompany {
  readonly userId: string;
  readonly name: string;
  /** Already validated and uppercased. */
  readonly kraPin: string;
}

/**
 * The company, its creator as an active admin, and its starter categories,
 * in one transaction with their audit entries (spec §6.1).
 */
export function createOrganization(
  company: NewCompany,
): Effect.Effect<
  OrganizationResponse,
  DatabaseError,
  DatabaseService | AuditLog
> {
  const organizationId = randomUUID();
  const actor: AuditActor = { type: "user", id: company.userId };

  return withScope(
    { organizationId, userId: company.userId, role: "admin" },
    (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;

        const [organization] = yield* query(() =>
          tx
            .insert(organizations)
            .values({
              id: organizationId,
              name: company.name,
              kraPin: company.kraPin,
            })
            .returning({
              id: organizations.id,
              name: organizations.name,
              kraPin: organizations.kraPin,
            }),
        );
        const [membership] = yield* query(() =>
          tx
            .insert(memberships)
            .values({
              organizationId,
              userId: company.userId,
              role: "admin",
              status: "active",
            })
            .returning({
              id: memberships.id,
              role: memberships.role,
              status: memberships.status,
            }),
        );
        if (!organization || !membership) {
          return yield* Effect.dieMessage("company insert returned no row");
        }
        const starterCategories = yield* seedStarterCategories(
          tx,
          organizationId,
        );

        yield* audit.record(tx, {
          actor,
          organizationId,
          action: "organization.created",
          entity: { type: "organization", id: organizationId },
          after: {
            name: organization.name,
            kraPin: organization.kraPin,
            categories: starterCategories.map(({ name }) => name),
          },
        });
        yield* audit.record(tx, {
          actor,
          organizationId,
          action: "membership.created",
          entity: { type: "membership", id: membership.id },
          after: {
            userId: company.userId,
            role: membership.role,
            status: membership.status,
          },
        });

        return { ...organization, role: membership.role };
      }),
  );
}

/**
 * Sign-up (spec §6.1): the company first, then its wallet. A wallet that
 * isn't ready doesn't undo the company; the response says so and
 * `POST /organizations/:id/wallet` resumes it.
 */
export function signUpCompany(
  company: NewCompany,
): Effect.Effect<
  CreateOrganizationResponse,
  DatabaseError,
  DatabaseService | AuditLog | EnsureCompanyWalletDeps
> {
  return createOrganization(company).pipe(
    Effect.flatMap((organization) =>
      setUpCompanyWallet({
        organizationId: organization.id,
        actor: { type: "user", id: company.userId },
      }).pipe(Effect.map((wallet) => ({ ...organization, wallet }))),
    ),
  );
}
