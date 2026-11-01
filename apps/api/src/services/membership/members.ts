import type { SQL } from "drizzle-orm";
import { and, eq, isNull, ne, or, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type {
  AssignableRole,
  MembershipRole,
  MembershipStatus,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { ConfigService } from "../../config.js";
import { memberships, organizations, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, Forbidden, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { EmailSender } from "../email/email-sender.js";
import { inviteEmail } from "../email/invite-email.js";

/**
 * The company's people (spec §6.2): invites, role changes and removals by an
 * admin. Each change runs under a lock on the company row, so two admins
 * acting at once can't leave it without an active admin, and re-checks that
 * the acting admin is still one.
 */

export interface MemberRow {
  readonly id: string;
  readonly name: string | null;
  readonly email: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly invitedAt: Date | null;
  readonly payoutPhoneConfirmed: boolean;
}

/** An active admin acting on their company. */
export interface MemberAdmin {
  readonly organizationId: string;
  readonly userId: string;
}

const memberFields = {
  id: memberships.id,
  name: sql<
    string | null
  >`coalesce(${users.fullName}, ${memberships.fullName})`,
  email: sql<string>`coalesce(${users.email}, ${memberships.email})`,
  role: memberships.role,
  status: memberships.status,
  invitedAt: memberships.invitedAt,
  payoutPhoneConfirmed: sql<boolean>`${users.phone} IS NOT NULL`,
};

const selectMembers = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(memberFields)
    .from(memberships)
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(where);

function selectMember(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Effect.Effect<MemberRow, DatabaseError> {
  return query(() =>
    selectMembers(
      tx,
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.id, membershipId),
      ),
    ).limit(1),
  ).pipe(
    Effect.flatMap(([member]) =>
      member ? Effect.succeed(member) : Effect.dieMessage("member vanished"),
    ),
  );
}

const alreadyMember = new Conflict({
  message: "This person is already in the company.",
});
const lastAdmin = new Conflict({
  message:
    "A company needs at least one admin. Make someone else an admin first.",
});
const notMember = new NotFound({
  message: "That person isn't in this company.",
});
const notAdmin = new Forbidden({
  message: "Your role in this company can't do this",
});

interface MemberChange {
  readonly companyName: string;
  /** For the invite email; their email when they haven't given a name. */
  readonly actorName: string;
}

function beginMemberChange(
  tx: Transaction,
  admin: MemberAdmin,
): Effect.Effect<MemberChange, Forbidden | DatabaseError> {
  return Effect.gen(function* () {
    const [company] = yield* query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, admin.organizationId))
        .for("update"),
    );
    const [actor] = yield* query(() =>
      tx
        .select({ fullName: users.fullName, email: users.email })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, admin.organizationId),
            eq(memberships.userId, admin.userId),
            eq(memberships.role, "admin"),
            eq(memberships.status, "active"),
          ),
        )
        .limit(1),
    );
    if (!company || !actor) return yield* Effect.fail(notAdmin);
    return {
      companyName: company.name,
      actorName: actor.fullName ?? actor.email,
    };
  });
}

function otherActiveAdmins(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Effect.Effect<number, DatabaseError> {
  return query(() =>
    tx.$count(
      memberships,
      and(
        eq(memberships.organizationId, organizationId),
        eq(memberships.role, "admin"),
        eq(memberships.status, "active"),
        ne(memberships.id, membershipId),
      ),
    ),
  );
}

export function listMembers(
  admin: MemberAdmin,
): Effect.Effect<MemberRow[], DatabaseError, DatabaseService> {
  return withScope(admin, (tx) =>
    query(() =>
      selectMembers(
        tx,
        and(
          eq(memberships.organizationId, admin.organizationId),
          ne(memberships.status, "removed"),
        ),
      ).orderBy(
        sql`lower(coalesce(${users.fullName}, ${memberships.fullName}, ${users.email}, ${memberships.email})) COLLATE "C"`,
        memberships.id,
      ),
    ),
  );
}

export interface Invitation {
  readonly email: string;
  readonly fullName: string;
  readonly role: MembershipRole;
}

interface RecordedInvitation {
  readonly member: MemberRow;
  /** Set when an install email should go out, after the commit. */
  readonly installEmail: MemberChange | null;
}

/**
 * The invitee's login identity, created by email if they've never signed in
 * (their first login claims it). An existing name is never overwritten.
 */
function findOrCreateUser(
  tx: Transaction,
  invitation: Invitation,
): Effect.Effect<string, DatabaseError> {
  return Effect.gen(function* () {
    const [created] = yield* query(() =>
      tx
        .insert(users)
        .values({ email: invitation.email, fullName: invitation.fullName })
        .onConflictDoNothing({ target: users.email })
        .returning({ id: users.id }),
    );
    if (created) return created.id;
    yield* query(() =>
      tx
        .update(users)
        .set({ fullName: invitation.fullName })
        .where(and(eq(users.email, invitation.email), isNull(users.fullName))),
    );
    const [existing] = yield* query(() =>
      tx
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, invitation.email))
        .limit(1),
    );
    return existing
      ? existing.id
      : yield* Effect.dieMessage("invited user vanished");
  });
}

function recordInvitation(
  admin: MemberAdmin,
  invitation: Invitation,
): Effect.Effect<
  RecordedInvitation,
  Conflict | Forbidden | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = admin;
  return withScope({ ...admin, role: "admin" }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const change = yield* beginMemberChange(tx, admin);
      const now = new Date();

      const sameEmail = yield* query(() =>
        tx
          .select({
            id: memberships.id,
            userId: memberships.userId,
            role: memberships.role,
            status: memberships.status,
          })
          .from(memberships)
          .leftJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              or(
                eq(users.email, invitation.email),
                eq(memberships.email, invitation.email),
              ),
            ),
          ),
      );
      const isAccountant = invitation.role === "accountant";
      const existing = sameEmail.find(
        (row) => (row.userId === null) === isAccountant,
      );
      const otherKind = sameEmail.find(
        (row) => (row.userId === null) !== isAccountant,
      );
      if (otherKind && otherKind.status !== "removed") {
        return yield* Effect.fail(alreadyMember);
      }
      if (existing?.status === "active") {
        return yield* Effect.fail(alreadyMember);
      }
      if (existing?.status === "invited") {
        return {
          member: yield* selectMember(tx, organizationId, existing.id),
          installEmail: change,
        };
      }

      const status: MembershipStatus = isAccountant ? "active" : "invited";
      const userId = isAccountant
        ? null
        : yield* findOrCreateUser(tx, invitation);
      const invite = {
        role: invitation.role,
        status,
        invitedBy: admin.userId,
        invitedAt: now,
        ...(isAccountant && {
          email: invitation.email,
          fullName: invitation.fullName,
        }),
      };

      const [saved] = yield* query(() =>
        existing
          ? tx
              .update(memberships)
              .set(invite)
              .where(eq(memberships.id, existing.id))
              .returning({ id: memberships.id })
          : tx
              .insert(memberships)
              .values({ organizationId, userId, ...invite })
              .returning({ id: memberships.id }),
      );
      if (!saved) return yield* Effect.dieMessage("invite wrote no row");

      yield* audit.record(tx, {
        actor: { type: "user", id: admin.userId },
        organizationId,
        action: "membership.invited",
        entity: { type: "membership", id: saved.id },
        before: existing && { role: existing.role, status: existing.status },
        after: {
          userId,
          email: invitation.email,
          fullName: invitation.fullName,
          role: invitation.role,
          status,
        },
      });

      return {
        member: yield* selectMember(tx, organizationId, saved.id),
        installEmail: isAccountant ? null : change,
      };
    }),
  );
}

/**
 * Best effort, after the invite has committed: a failure leaves the invite
 * in place and is logged with the membership ID only.
 */
function sendInstallEmail(
  member: MemberRow,
  change: MemberChange,
  installUrl: string | null,
): Effect.Effect<boolean, never, EmailSender> {
  const notSent = (reason: string) =>
    Effect.sync(() => {
      console.error(
        `[members] invite email for membership ${member.id} not sent: ${reason}`,
      );
      return false;
    });
  if (installUrl === null) return notSent("APP_INSTALL_URL isn't set");
  return Effect.flatMap(EmailSender, (sender) =>
    sender.send(
      inviteEmail({
        to: member.email,
        companyName: change.companyName,
        inviterName: change.actorName,
        installUrl,
      }),
    ),
  ).pipe(
    Effect.as(true),
    Effect.catchTag("EmailSendError", (error) => notSent(error.message)),
  );
}

export interface InviteResult {
  readonly member: MemberRow;
  readonly emailSent: boolean;
  /** For the admin to share themselves when the email didn't go out. */
  readonly installUrl: string | null;
}

/**
 * Invites a person by email (spec §6.2). Admins and employees get an
 * `invited` membership that activates when that email signs in, plus an
 * install email; inviting someone already invited sends it again.
 * Accountants have no login (spec §4), so they're added `active` by email
 * alone, with no install email.
 */
export function inviteMember(
  admin: MemberAdmin,
  invitation: Invitation,
): Effect.Effect<
  InviteResult,
  Conflict | Forbidden | DatabaseError,
  DatabaseService | AuditLog | ConfigService | EmailSender
> {
  return Effect.gen(function* () {
    const installUrl = Option.getOrNull((yield* ConfigService).appInstallUrl);
    const { member, installEmail } = yield* recordInvitation(admin, invitation);
    const emailSent = installEmail
      ? yield* sendInstallEmail(member, installEmail, installUrl)
      : false;
    return { member, emailSent, installUrl };
  });
}

interface Target {
  readonly id: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
}

function findTarget(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Effect.Effect<Target, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select({
        id: memberships.id,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.id, membershipId),
          ne(memberships.status, "removed"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([target]) =>
      target ? Effect.succeed(target) : Effect.fail(notMember),
    ),
  );
}

function keepsAnAdmin(
  tx: Transaction,
  organizationId: string,
  target: Target,
): Effect.Effect<void, Conflict | DatabaseError> {
  if (target.role !== "admin" || target.status !== "active") return Effect.void;
  return otherActiveAdmins(tx, organizationId, target.id).pipe(
    Effect.flatMap((others) =>
      others > 0 ? Effect.void : Effect.fail(lastAdmin),
    ),
  );
}

/** Switches someone between admin and employee (spec §4). */
export function changeMemberRole(
  admin: MemberAdmin,
  membershipId: string,
  role: AssignableRole,
): Effect.Effect<
  MemberRow,
  Conflict | Forbidden | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = admin;
  return withScope({ ...admin, role: "admin" }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      yield* beginMemberChange(tx, admin);
      const target = yield* findTarget(tx, organizationId, membershipId);
      if (target.role === "accountant") {
        return yield* Effect.fail(
          new Conflict({ message: "An accountant's role can't be changed." }),
        );
      }
      if (target.role !== role) {
        yield* keepsAnAdmin(tx, organizationId, target);
        yield* query(() =>
          tx
            .update(memberships)
            .set({ role })
            .where(eq(memberships.id, target.id)),
        );
        yield* audit.record(tx, {
          actor: { type: "user", id: admin.userId },
          organizationId,
          action: "membership.role_changed",
          entity: { type: "membership", id: target.id },
          before: { role: target.role },
          after: { role },
        });
      }
      return yield* selectMember(tx, organizationId, target.id);
    }),
  );
}

/**
 * Ends someone's access at once (spec §6.2): every request checks for an
 * active membership. The row stays, so their unpaid claims can still be paid.
 */
export function removeMember(
  admin: MemberAdmin,
  membershipId: string,
): Effect.Effect<
  MemberRow,
  Conflict | Forbidden | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = admin;
  return withScope({ ...admin, role: "admin" }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      yield* beginMemberChange(tx, admin);
      const target = yield* findTarget(tx, organizationId, membershipId);
      yield* keepsAnAdmin(tx, organizationId, target);
      yield* query(() =>
        tx
          .update(memberships)
          .set({ status: "removed" })
          .where(eq(memberships.id, target.id)),
      );
      yield* audit.record(tx, {
        actor: { type: "user", id: admin.userId },
        organizationId,
        action: "membership.removed",
        entity: { type: "membership", id: target.id },
        before: { role: target.role, status: target.status },
        after: { status: "removed" },
      });
      return yield* selectMember(tx, organizationId, target.id);
    }),
  );
}
