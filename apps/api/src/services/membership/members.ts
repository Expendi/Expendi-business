import type { SQL } from "drizzle-orm";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { Effect, Option } from "effect";

import type {
  AssignableRole,
  MembershipRole,
  MembershipStatus,
} from "@expendi-business/shared";
import { WEB_DASHBOARD_URL } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { EmailMessage } from "../email/email-sender.js";
import { ConfigService } from "../../config.js";
import { memberships, organizations, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, Forbidden, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { requestCardClosures } from "../cards/leavers.js";
import { accountantAccessEmail } from "../email/accountant-access-email.js";
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
  name: users.fullName,
  email: users.email,
  role: memberships.role,
  status: memberships.status,
  invitedAt: memberships.invitedAt,
  payoutPhoneConfirmed: sql<boolean>`${users.phone} IS NOT NULL`,
};

const selectMembers = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(memberFields)
    .from(memberships)
    .innerJoin(users, eq(users.id, memberships.userId))
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
        sql`lower(coalesce(${users.fullName}, ${users.email})) COLLATE "C"`,
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
  /** For the invite email, sent after the commit. */
  readonly change: MemberChange;
}

const isAccountant = (role: MembershipRole): boolean => role === "accountant";

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

      const [existing] = yield* query(() =>
        tx
          .select({
            id: memberships.id,
            role: memberships.role,
            status: memberships.status,
          })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .where(
            and(
              eq(memberships.organizationId, organizationId),
              eq(users.email, invitation.email),
            ),
          )
          .limit(1),
      );
      if (existing?.status === "active") {
        return yield* Effect.fail(alreadyMember);
      }
      if (existing?.status === "invited") {
        // Resending can't turn a team invite into an accountant's, or back.
        if (isAccountant(existing.role) !== isAccountant(invitation.role)) {
          return yield* Effect.fail(alreadyMember);
        }
        return {
          member: yield* selectMember(tx, organizationId, existing.id),
          change,
        };
      }

      const userId = yield* findOrCreateUser(tx, invitation);
      const invite = {
        role: invitation.role,
        status: "invited" as const,
        invitedBy: admin.userId,
        invitedAt: now,
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
          status: invite.status,
        },
      });

      return {
        member: yield* selectMember(tx, organizationId, saved.id),
        change,
      };
    }),
  );
}

/**
 * Admins and employees get the app's install link; accountants, who use only
 * the web dashboard (spec §4, §6.14), get its link instead. Null when there
 * is no install link to send.
 */
function inviteMessage(
  member: MemberRow,
  change: MemberChange,
  installUrl: string | null,
): EmailMessage | null {
  const invite = {
    to: member.email,
    companyName: change.companyName,
    inviterName: change.actorName,
  };
  if (isAccountant(member.role)) {
    return accountantAccessEmail({
      ...invite,
      dashboardUrl: WEB_DASHBOARD_URL,
    });
  }
  return installUrl === null ? null : inviteEmail({ ...invite, installUrl });
}

/**
 * Best effort, after the invite has committed: a failure leaves the invite
 * in place and is logged with the membership ID only.
 */
function sendInviteEmail(
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
  const message = inviteMessage(member, change, installUrl);
  if (message === null) return notSent("APP_INSTALL_URL isn't set");
  return Effect.flatMap(EmailSender, (sender) => sender.send(message)).pipe(
    Effect.as(true),
    Effect.catchTag("EmailSendError", (error) => notSent(error.message)),
  );
}

export interface InviteResult {
  readonly member: MemberRow;
  readonly emailSent: boolean;
  /** For the admin to share themselves when the email didn't go out. */
  readonly installUrl: string | null;
  /** The link the email carries: the dashboard's for an accountant. */
  readonly inviteLink: string | null;
}

/**
 * Invites a person by email (spec §6.2), as any role: the membership is
 * `invited` until that email signs in. Inviting someone already invited
 * sends the email again.
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
    const { member, change } = yield* recordInvitation(admin, invitation);
    const emailSent = yield* sendInviteEmail(member, change, installUrl);
    const inviteLink = isAccountant(member.role)
      ? WEB_DASHBOARD_URL
      : installUrl;
    return { member, emailSent, installUrl, inviteLink };
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
        if (isAccountant(role)) {
          yield* requestCardClosures(tx, {
            organizationId,
            membershipId: target.id,
            actor: { type: "user", id: admin.userId },
          });
        }
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
      yield* requestCardClosures(tx, {
        organizationId,
        membershipId: target.id,
        actor: { type: "user", id: admin.userId },
      });
      return yield* selectMember(tx, organizationId, target.id);
    }),
  );
}
