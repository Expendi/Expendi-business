import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { ApprovalPasskeyStatus } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type {
  DatabaseError,
  RecentLoginRequired,
  ServiceUnavailable,
} from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { PrivyAuth } from "../auth/privy-auth.js";
import type { EmailMessage } from "../email/email-sender.js";
import type { ApprovalSettings } from "./passkeys.js";
import {
  approvalPasskeys,
  memberships,
  organizations,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Forbidden } from "../../errors.js";
import { requireRecentSignIn } from "../auth/recent-sign-in.js";
import { approvalPasskeyEnrolledEmail } from "../email/approval-passkey-email.js";
import { EmailSender } from "../email/email-sender.js";
import { finishPasskeyEnrolment, startPasskeyEnrolment } from "./passkeys.js";

/**
 * Enrolling the approval passkey from the app (spec §7.3). Only a first
 * passkey can be enrolled (a replacement goes through support), and since
 * a stolen session could otherwise enrol one, enrolling also needs a recent
 * sign-in and emails every admin who could be affected.
 */

export interface EnrollingSession {
  readonly userId: string;
  readonly privyUserId: string;
  readonly tokenIssuedAt: Date;
}

interface AdminCompany {
  readonly organizationId: string;
  readonly name: string;
}

/** Companies where the user is an active admin. */
function companiesAdministeredBy(
  userId: string,
): Effect.Effect<AdminCompany[], DatabaseError, DatabaseService> {
  return withScope({ userId }, (tx) =>
    query(() =>
      tx
        .select({
          organizationId: memberships.organizationId,
          name: organizations.name,
        })
        .from(memberships)
        .innerJoin(
          organizations,
          eq(organizations.id, memberships.organizationId),
        )
        .where(
          and(
            eq(memberships.userId, userId),
            eq(memberships.role, "admin"),
            eq(memberships.status, "active"),
          ),
        )
        .orderBy(organizations.name),
    ),
  );
}

export function approvalPasskeyStatus(
  userId: string,
): Effect.Effect<ApprovalPasskeyStatus, DatabaseError, DatabaseService> {
  return withScope({ userId }, (tx) =>
    query(() =>
      tx
        .select({ createdAt: approvalPasskeys.createdAt })
        .from(approvalPasskeys)
        .where(eq(approvalPasskeys.userId, userId))
        .orderBy(approvalPasskeys.createdAt)
        .limit(1),
    ),
  ).pipe(
    Effect.map(([passkey]) => ({
      enrolled: passkey !== undefined,
      enrolledAt: passkey?.createdAt.toISOString() ?? null,
    })),
  );
}

/**
 * Options for creating the passkey on the phone. Admins only: nobody else
 * approves money, and a passkey enrolled before a promotion would be one
 * nobody was told about.
 */
export function startApprovalPasskeyEnrolment(
  session: EnrollingSession,
): Effect.Effect<
  PublicKeyCredentialCreationOptionsJSON,
  Forbidden | RecentLoginRequired | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | ApprovalSettings | PrivyAuth
> {
  return Effect.gen(function* () {
    const companies = yield* companiesAdministeredBy(session.userId);
    if (companies.length === 0) {
      return yield* Effect.fail(
        new Forbidden({
          message: "Only a company admin sets up an approval passkey.",
        }),
      );
    }
    yield* requireRecentSignIn(session);
    return yield* startPasskeyEnrolment(session.userId);
  });
}

/**
 * Stores the passkey (audited in the same transaction), then, after the
 * commit, emails every admin of each company the person is an admin of.
 */
export function finishApprovalPasskeyEnrolment(
  userId: string,
  response: RegistrationResponseJSON,
): Effect.Effect<
  ApprovalPasskeyStatus,
  Forbidden | DatabaseError,
  DatabaseService | AuditLog | ApprovalSettings | EmailSender
> {
  return Effect.gen(function* () {
    yield* finishPasskeyEnrolment(userId, response);
    yield* notifyAdmins(userId);
    return yield* approvalPasskeyStatus(userId);
  });
}

function enrolmentEmails(
  userId: string,
): Effect.Effect<EmailMessage[], DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const companies = yield* companiesAdministeredBy(userId);
    const [enrolled] = yield* withScope({ userId }, (tx) =>
      query(() =>
        tx
          .select({ email: users.email, fullName: users.fullName })
          .from(users)
          .where(eq(users.id, userId)),
      ),
    );
    if (!enrolled) return [];

    const companiesByRecipient = new Map<string, string[]>();
    for (const company of companies) {
      const admins = yield* withScope(
        { organizationId: company.organizationId },
        (tx) =>
          query(() =>
            tx
              .select({ email: users.email })
              .from(memberships)
              .innerJoin(users, eq(users.id, memberships.userId))
              .where(
                and(
                  eq(memberships.organizationId, company.organizationId),
                  eq(memberships.role, "admin"),
                  eq(memberships.status, "active"),
                ),
              ),
          ),
      );
      for (const { email } of admins) {
        companiesByRecipient.set(email, [
          ...(companiesByRecipient.get(email) ?? []),
          company.name,
        ]);
      }
    }

    const enrolledBy = enrolled.fullName
      ? `${enrolled.fullName} (${enrolled.email})`
      : enrolled.email;
    return [...companiesByRecipient].map(([to, companyNames]) =>
      approvalPasskeyEnrolledEmail({ to, enrolledBy, companyNames }),
    );
  });
}

/**
 * Best effort, after the commit: a failed lookup or email never undoes the
 * enrolment and is logged without addresses.
 */
function notifyAdmins(
  userId: string,
): Effect.Effect<void, never, DatabaseService | EmailSender> {
  return Effect.gen(function* () {
    const sender = yield* EmailSender;
    const messages = yield* enrolmentEmails(userId);
    yield* Effect.forEach(
      messages,
      (message) =>
        sender
          .send(message)
          .pipe(
            Effect.catchTag("EmailSendError", (error) =>
              Effect.sync(() =>
                console.error(
                  `[approval-passkey] enrolment email for user ${userId} not sent: ${error.message}`,
                ),
              ),
            ),
          ),
      { discard: true },
    );
  }).pipe(
    Effect.catchTag("DatabaseError", (error) =>
      Effect.sync(() =>
        console.error(
          `[approval-passkey] enrolment emails for user ${userId} not sent: ${error.message}`,
        ),
      ),
    ),
  );
}
