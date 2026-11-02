import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { SQL } from "drizzle-orm";
import { and, eq, ne, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  PayeeChange,
  PayeeDetails,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import { PAYEE_CHANGE_HOLD_HOURS } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { PayeeRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import type { PayeeDetailsEmailInput } from "../email/payee-email.js";
import {
  memberships,
  organizations,
  payees,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  Forbidden,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { EmailSender } from "../email/email-sender.js";
import { payeeDetailsEmail } from "../email/payee-email.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import {
  checkAllowlisted,
  checkBank,
  checkDetailsForKind,
  describeDetails,
  detailColumns,
  detailsOf,
  isPayable,
  maskDetails,
  normaliseDetails,
  sameDetails,
} from "./details.js";

/**
 * The company's payees (spec §6.19), for admins only. Adding payment
 * details or changing them is the main route for payment fraud, so it
 * needs the admin's passkey, bound by hash to exactly those details; it is
 * audited with the account numbers masked, emails every admin, and starts
 * the 24-hour hold `assertPayeeChangeConfirmed` enforces. Name, kind and
 * archiving are audited but need no passkey.
 */

/** An admin acting on their company; re-checked inside every change. */
export interface PayeeAdmin {
  readonly organizationId: string;
  readonly userId: string;
}

export interface PayeeView {
  readonly id: string;
  readonly kind: PayeeKind;
  readonly name: string;
  readonly membershipId: string | null;
  readonly details: PayeeDetails | null;
  readonly payoutPhoneConfirmed: boolean | null;
  readonly detailsChangedAt: Date | null;
  readonly secondConfirmationUntil: Date | null;
  readonly archived: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PayeeFilters {
  readonly kind?: PayeeKind | undefined;
  readonly method?: PayeeMethod | undefined;
  readonly archived?: boolean | undefined;
}

/** A payee as added: details, if any, already normalised. */
interface NewPayeeDraft {
  readonly kind: PayeeKind;
  readonly name: string;
  readonly membershipId?: string | undefined;
  readonly details?: PayeeDetails | undefined;
}

type NormalisedChange =
  | { readonly action: "create"; readonly payee: NewPayeeDraft }
  | {
      readonly action: "change_details";
      readonly payeeId: string;
      readonly details: PayeeDetails;
    };

export type CreatePayeeResult =
  | { readonly status: "created"; readonly payee: PayeeView }
  | PendingPayeeChange;

export interface PendingPayeeChange extends ApprovalChallenge {
  readonly status: "confirmation_required";
  /** Sent back unchanged with the passkey's response. */
  readonly change: NormalisedChange;
}

type PayeeDeps = DatabaseService | AuditLog;
type ConfirmDeps = PayeeDeps | ApprovalSettings | Paycrest | EmailSender;

const HOLD_MS = PAYEE_CHANGE_HOLD_HOURS * 60 * 60_000;

const notFound = new NotFound({ message: "That payee wasn't found." });
const archivedPayee = new Conflict({ message: "This payee is archived." });
const alreadyAPayee = new Conflict({
  message: "This person is already a payee.",
});
const notAdmin = new Forbidden({
  message: "Your role in this company can't do this",
});

// ── Reading ──────────────────────────────────────────────────────────────

const payeeFields = {
  row: payees,
  payoutPhoneConfirmed: sql<
    boolean | null
  >`CASE WHEN ${payees.membershipId} IS NULL THEN NULL ELSE ${users.phone} IS NOT NULL END`,
};

const selectPayees = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(payeeFields)
    .from(payees)
    .leftJoin(memberships, eq(memberships.id, payees.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(where);

function toView(
  row: PayeeRow,
  payoutPhoneConfirmed: boolean | null,
  now = Date.now(),
): PayeeView {
  const holdEnds = row.detailsChangedAt
    ? new Date(row.detailsChangedAt.getTime() + HOLD_MS)
    : null;
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    membershipId: row.membershipId,
    details: detailsOf(row),
    payoutPhoneConfirmed,
    detailsChangedAt: row.detailsChangedAt,
    secondConfirmationUntil:
      holdEnds && holdEnds.getTime() > now ? holdEnds : null,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function readPayee(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
): Effect.Effect<PayeeView, NotFound | DatabaseError> {
  return query(() =>
    selectPayees(
      tx,
      and(eq(payees.organizationId, organizationId), eq(payees.id, payeeId)),
    ).limit(1),
  ).pipe(
    Effect.flatMap(([found]) =>
      found
        ? Effect.succeed(toView(found.row, found.payoutPhoneConfirmed))
        : Effect.fail(notFound),
    ),
  );
}

export function listPayees(
  admin: PayeeAdmin,
  filters: PayeeFilters,
): Effect.Effect<PayeeView[], DatabaseError, DatabaseService> {
  return withScope(admin, (tx) =>
    query(() =>
      selectPayees(
        tx,
        and(
          eq(payees.organizationId, admin.organizationId),
          eq(payees.archived, filters.archived ?? false),
          filters.kind && eq(payees.kind, filters.kind),
          filters.method && eq(payees.method, filters.method),
        ),
      ).orderBy(sql`lower(${payees.name}) COLLATE "C"`, payees.id),
    ).pipe(
      Effect.map((rows) =>
        rows.map(({ row, payoutPhoneConfirmed }) =>
          toView(row, payoutPhoneConfirmed),
        ),
      ),
    ),
  );
}

export function getPayee(
  admin: PayeeAdmin,
  payeeId: string,
): Effect.Effect<PayeeView, NotFound | DatabaseError, DatabaseService> {
  return withScope(admin, (tx) => readPayee(tx, admin.organizationId, payeeId));
}

/** Kenyan banks Paycrest can pay, for the bank picker. */
export function listPayeeBanks(): Effect.Effect<
  { readonly code: string; readonly name: string }[],
  ServiceUnavailable,
  Paycrest
> {
  return Effect.flatMap(Paycrest, (paycrest) => paycrest.institutions()).pipe(
    Effect.map((institutions) =>
      institutions
        .filter((institution) => institution.type === "bank")
        .map(({ code, name }) => ({ code, name })),
    ),
    Effect.catchTag("PaycrestError", () =>
      Effect.fail(
        new ServiceUnavailable({
          message: "We can't load the list of banks right now. Try again soon.",
        }),
      ),
    ),
  );
}

// ── Checks ───────────────────────────────────────────────────────────────

function requireActiveAdmin(
  tx: Transaction,
  admin: PayeeAdmin,
): Effect.Effect<void, Forbidden | DatabaseError> {
  return query(() =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, admin.organizationId),
          eq(memberships.userId, admin.userId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0 ? Effect.void : Effect.fail(notAdmin),
    ),
  );
}

function normaliseNewPayee(input: {
  readonly kind: PayeeKind;
  readonly name: string;
  readonly membershipId?: string | undefined;
  readonly details?: PayeeDetails | null | undefined;
}): Effect.Effect<NewPayeeDraft, BadRequest> {
  return Effect.gen(function* () {
    const employee = input.kind === "employee";
    if (employee && input.membershipId === undefined) {
      return yield* Effect.fail(
        new BadRequest({ message: "Choose the employee." }),
      );
    }
    if (!employee && input.membershipId !== undefined) {
      return yield* Effect.fail(
        new BadRequest({
          message: "Only an employee payee is linked to a team member.",
        }),
      );
    }
    const details = input.details
      ? yield* normaliseDetails(input.details)
      : undefined;
    if (details) yield* checkDetailsForKind(input.kind, details);
    return {
      kind: input.kind,
      name: input.name,
      membershipId: input.membershipId,
      details,
    };
  });
}

/**
 * An employee payee belongs to someone in this company who can log in
 * (accountants can't), and each person has at most one active payee.
 */
function checkEmployee(
  tx: Transaction,
  organizationId: string,
  membershipId: string | undefined,
): Effect.Effect<void, BadRequest | NotFound | Conflict | DatabaseError> {
  if (membershipId === undefined) return Effect.void;
  return Effect.gen(function* () {
    const [membership] = yield* query(() =>
      tx
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.id, membershipId),
            ne(memberships.status, "removed"),
          ),
        )
        .limit(1),
    );
    if (!membership) {
      return yield* Effect.fail(
        new NotFound({ message: "That person isn't in this company." }),
      );
    }
    if (membership.userId === null) {
      return yield* Effect.fail(
        new BadRequest({
          message: "An accountant can't be paid as an employee.",
        }),
      );
    }
    const existing = yield* query(() =>
      tx
        .select({ id: payees.id })
        .from(payees)
        .where(
          and(
            eq(payees.organizationId, organizationId),
            eq(payees.membershipId, membershipId),
            eq(payees.archived, false),
          ),
        )
        .limit(1),
    );
    if (existing.length > 0) {
      return yield* Effect.fail(alreadyAPayee);
    }
  });
}

/** The payee's row, locked for the rest of the transaction when `lock`. */
function findPayeeRow(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
  { lock }: { readonly lock: boolean },
): Effect.Effect<PayeeRow, NotFound | DatabaseError> {
  const select = tx
    .select()
    .from(payees)
    .where(
      and(eq(payees.organizationId, organizationId), eq(payees.id, payeeId)),
    );
  return query(() => (lock ? select.for("update") : select)).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(notFound),
    ),
  );
}

// ── Passkey-confirmed changes ────────────────────────────────────────────

/** What the passkey signs: the company and exactly this change. */
export function payeeChangeIntentHash(
  organizationId: string,
  change: NormalisedChange,
): string {
  return sha256Hex(
    canonicalJson({ version: 1, kind: "payee", organizationId, change }),
  );
}

interface ValidatedChange {
  readonly change: NormalisedChange;
  /** The bank's name for the admins' email; null for other methods. */
  readonly bankName: string | null;
}

/**
 * Normalises `change` and checks what can be checked outside the database:
 * formats and Paycrest's bank list. The same input always normalises to
 * the same change, so its hash matches the one the passkey signed.
 */
function validateChange(
  change: PayeeChange,
): Effect.Effect<ValidatedChange, BadRequest | ServiceUnavailable, Paycrest> {
  return Effect.gen(function* () {
    const normalised: NormalisedChange =
      change.action === "create"
        ? { action: "create", payee: yield* normaliseNewPayee(change.payee) }
        : {
            action: "change_details",
            payeeId: change.payeeId,
            details: yield* normaliseDetails(change.details),
          };
    const details =
      normalised.action === "create"
        ? normalised.payee.details
        : normalised.details;
    return { change: normalised, bankName: yield* checkBank(details) };
  });
}

/** The database checks a change needs, before asking for the passkey and again when applying it. */
function checkChangeInDatabase(
  tx: Transaction,
  admin: PayeeAdmin,
  change: NormalisedChange,
  options: { readonly lock: boolean },
): Effect.Effect<
  PayeeRow | null,
  BadRequest | Forbidden | NotFound | Conflict | DatabaseError
> {
  return Effect.gen(function* () {
    yield* requireActiveAdmin(tx, admin);
    if (change.action === "create") {
      yield* checkEmployee(tx, admin.organizationId, change.payee.membershipId);
      yield* checkAllowlisted(tx, admin.organizationId, change.payee.details);
      return null;
    }
    const row = yield* findPayeeRow(
      tx,
      admin.organizationId,
      change.payeeId,
      options,
    );
    if (row.archived) return yield* Effect.fail(archivedPayee);
    yield* checkDetailsForKind(row.kind, change.details);
    yield* checkAllowlisted(tx, admin.organizationId, change.details);
    return row;
  });
}

function requestChange(
  admin: PayeeAdmin,
  change: NormalisedChange,
): Effect.Effect<
  PendingPayeeChange,
  BadRequest | Forbidden | NotFound | Conflict | DatabaseError,
  DatabaseService | ApprovalSettings | AuditLog
> {
  return Effect.gen(function* () {
    const current = yield* withScope(admin, (tx) =>
      checkChangeInDatabase(tx, admin, change, { lock: false }),
    );
    if (
      change.action === "change_details" &&
      current &&
      sameDetails(detailsOf(current), change.details)
    ) {
      return yield* Effect.fail(
        new BadRequest({
          message: "Those are already this payee's payment details.",
        }),
      );
    }
    const challenge = yield* startApproval({
      organizationId: admin.organizationId,
      userId: admin.userId,
      purpose: "change_payee",
      intentHash: payeeChangeIntentHash(admin.organizationId, change),
    });
    return { status: "confirmation_required", ...challenge, change };
  });
}

/**
 * Adds a payee. Without payment details, or paid outside Expendi, it is
 * created at once; with details, the admin's passkey must confirm it first
 * (`confirmPayeeChange`).
 */
export function createPayee(
  admin: PayeeAdmin,
  input: Extract<PayeeChange, { action: "create" }>["payee"],
): Effect.Effect<
  CreatePayeeResult,
  | BadRequest
  | Forbidden
  | NotFound
  | Conflict
  | ServiceUnavailable
  | DatabaseError,
  ConfirmDeps
> {
  return Effect.gen(function* () {
    const draft = yield* normaliseNewPayee(input);
    const change = { action: "create", payee: draft } as const;
    if (isPayable(draft.details)) {
      yield* checkBank(draft.details);
      return yield* requestChange(admin, change);
    }

    const audit = yield* AuditLog;
    const payee = yield* withScope({ ...admin, role: "admin" }, (tx) =>
      Effect.gen(function* () {
        yield* checkChangeInDatabase(tx, admin, change, { lock: false });
        const row = yield* insertPayee(tx, admin.organizationId, draft);
        yield* audit.record(tx, {
          actor: { type: "user", id: admin.userId },
          organizationId: admin.organizationId,
          action: "payee.created",
          entity: { type: "payee", id: row.id },
          after: auditedPayee(row),
        });
        return yield* readPayee(tx, admin.organizationId, row.id);
      }),
    );
    return { status: "created", payee };
  });
}

/** Asks for the admin's passkey to give an existing payee new payment details. */
export function requestPayeeDetailsChange(
  admin: PayeeAdmin,
  payeeId: string,
  details: PayeeDetails,
): Effect.Effect<
  PendingPayeeChange,
  | BadRequest
  | Forbidden
  | NotFound
  | Conflict
  | ServiceUnavailable
  | DatabaseError,
  ConfirmDeps
> {
  return validateChange({ action: "change_details", payeeId, details }).pipe(
    Effect.flatMap(({ change }) => requestChange(admin, change)),
  );
}

function insertPayee(
  tx: Transaction,
  organizationId: string,
  draft: NewPayeeDraft,
): Effect.Effect<PayeeRow, Conflict | DatabaseError> {
  return query(() =>
    tx
      .insert(payees)
      .values({
        organizationId,
        kind: draft.kind,
        name: draft.name,
        membershipId: draft.membershipId ?? null,
        ...detailColumns(draft.details),
        detailsChangedAt: isPayable(draft.details) ? sql`now()` : null,
      })
      .onConflictDoNothing()
      .returning(),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(alreadyAPayee),
    ),
  );
}

/** A payee as the audit log records it: account numbers masked. */
function auditedPayee(row: PayeeRow) {
  const details = detailsOf(row);
  return {
    kind: row.kind,
    name: row.name,
    membershipId: row.membershipId,
    details: details && maskDetails(details),
  };
}

interface AdminNotice {
  readonly recipients: readonly {
    readonly userId: string;
    readonly email: string;
  }[];
  readonly email: Omit<PayeeDetailsEmailInput, "to">;
}

/** Every active admin of the company, to be emailed after the commit. */
export function activeAdminRecipients(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<{ userId: string; email: string }[], DatabaseError> {
  return query(() =>
    tx
      .select({ userId: users.id, email: users.email })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      ),
  );
}

function buildNotice(
  tx: Transaction,
  admin: PayeeAdmin,
  row: PayeeRow,
  created: boolean,
  bankName: string | null,
): Effect.Effect<AdminNotice, DatabaseError> {
  return Effect.gen(function* () {
    const recipients = yield* activeAdminRecipients(tx, admin.organizationId);
    const [company] = yield* query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, admin.organizationId)),
    );
    const [actor] = yield* query(() =>
      tx
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, admin.userId)),
    );
    const details = detailsOf(row);
    return {
      recipients,
      email: {
        companyName: company?.name ?? "your company",
        actorName: actor?.fullName ?? actor?.email ?? "An admin",
        payeeName: row.name,
        created,
        details: details ? describeDetails(details, bankName) : "nothing",
      },
    };
  });
}

/**
 * Best effort, after the commit: a failed email never undoes the change
 * and is logged with the admin's user ID only.
 */
function sendNotice(
  notice: AdminNotice,
): Effect.Effect<void, never, EmailSender> {
  return Effect.forEach(
    notice.recipients,
    ({ userId, email }) =>
      Effect.flatMap(EmailSender, (sender) =>
        sender.send(payeeDetailsEmail({ ...notice.email, to: email })),
      ).pipe(
        Effect.catchTag("EmailSendError", (error) =>
          Effect.sync(() => {
            console.error(
              `[payees] email to admin ${userId} not sent: ${error.message}`,
            );
          }),
        ),
      ),
    { discard: true },
  );
}

/**
 * Applies a new payee or new payment details once the admin's passkey has
 * confirmed exactly that change. The change is sent again with the
 * signature; if it differs from what was challenged, nothing happens.
 */
export function confirmPayeeChange(
  admin: PayeeAdmin,
  input: {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
    readonly change: PayeeChange;
  },
): Effect.Effect<
  PayeeView,
  | BadRequest
  | Forbidden
  | NotFound
  | Conflict
  | ServiceUnavailable
  | DatabaseError,
  ConfirmDeps
> {
  return Effect.gen(function* () {
    const { change, bankName } = yield* validateChange(input.change);
    const approval = yield* verifyApproval({
      organizationId: admin.organizationId,
      userId: admin.userId,
      purpose: "change_payee",
      challengeId: input.challengeId,
      response: input.response,
    });
    if (
      payeeChangeIntentHash(admin.organizationId, change) !==
      approval.intentHash
    ) {
      return yield* Effect.fail(
        new Forbidden({
          message: "That isn't the change you confirmed. Confirm again.",
        }),
      );
    }
    const audit = yield* AuditLog;

    const { payee, notice } = yield* withScope(
      { ...admin, role: "admin" },
      (tx) =>
        Effect.gen(function* () {
          const before = yield* checkChangeInDatabase(tx, admin, change, {
            lock: true,
          });
          const row =
            change.action === "create"
              ? yield* insertPayee(tx, admin.organizationId, change.payee)
              : yield* updateDetails(tx, change.payeeId, change.details);
          yield* audit.record(tx, {
            actor: { type: "user", id: admin.userId },
            organizationId: admin.organizationId,
            action:
              change.action === "create"
                ? "payee.created"
                : "payee.details_changed",
            entity: { type: "payee", id: row.id },
            before: before && auditedPayee(before),
            after: { ...auditedPayee(row), approvalId: approval.approvalId },
          });
          return {
            payee: yield* readPayee(tx, admin.organizationId, row.id),
            notice: yield* buildNotice(
              tx,
              admin,
              row,
              change.action === "create",
              bankName,
            ),
          };
        }),
    );
    yield* sendNotice(notice);
    return payee;
  });
}

function updateDetails(
  tx: Transaction,
  payeeId: string,
  details: PayeeDetails,
): Effect.Effect<PayeeRow, DatabaseError> {
  return query(() =>
    tx
      .update(payees)
      .set({ ...detailColumns(details), detailsChangedAt: sql`now()` })
      .where(eq(payees.id, payeeId))
      .returning(),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.dieMessage("locked payee vanished"),
    ),
  );
}

// ── Changes without a passkey ────────────────────────────────────────────

/**
 * Renames a payee or changes its kind. An employee payee stays linked to
 * its person, so it can't become another kind, nor another kind an
 * employee.
 */
export function updatePayee(
  admin: PayeeAdmin,
  payeeId: string,
  update: {
    readonly name?: string | undefined;
    readonly kind?: PayeeKind | undefined;
  },
): Effect.Effect<
  PayeeView,
  BadRequest | Forbidden | NotFound | Conflict | DatabaseError,
  PayeeDeps
> {
  return withScope({ ...admin, role: "admin" }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      yield* requireActiveAdmin(tx, admin);
      const row = yield* findPayeeRow(tx, admin.organizationId, payeeId, {
        lock: true,
      });
      if (row.archived) return yield* Effect.fail(archivedPayee);
      const name = update.name ?? row.name;
      const kind = update.kind ?? row.kind;
      if ((kind === "employee") !== (row.kind === "employee")) {
        return yield* Effect.fail(
          new BadRequest({
            message:
              row.kind === "employee"
                ? "An employee payee stays an employee. Archive it and add a new payee instead."
                : "Add an employee as a new payee, linked to their place in the team.",
          }),
        );
      }
      if (name !== row.name || kind !== row.kind) {
        yield* query(() =>
          tx.update(payees).set({ name, kind }).where(eq(payees.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: { type: "user", id: admin.userId },
          organizationId: admin.organizationId,
          action: "payee.updated",
          entity: { type: "payee", id: row.id },
          before: { name: row.name, kind: row.kind },
          after: { name, kind },
        });
      }
      return yield* readPayee(tx, admin.organizationId, row.id);
    }),
  );
}

/**
 * Hides a payee from new bills and payments; its history stays.
 * Archiving an archived payee changes nothing.
 */
export function archivePayee(
  admin: PayeeAdmin,
  payeeId: string,
): Effect.Effect<PayeeView, Forbidden | NotFound | DatabaseError, PayeeDeps> {
  return withScope({ ...admin, role: "admin" }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      yield* requireActiveAdmin(tx, admin);
      const row = yield* findPayeeRow(tx, admin.organizationId, payeeId, {
        lock: true,
      });
      if (!row.archived) {
        yield* query(() =>
          tx
            .update(payees)
            .set({ archived: true })
            .where(eq(payees.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: { type: "user", id: admin.userId },
          organizationId: admin.organizationId,
          action: "payee.archived",
          entity: { type: "payee", id: row.id },
          before: { archived: false },
          after: { archived: true },
        });
      }
      return yield* readPayee(tx, admin.organizationId, row.id);
    }),
  );
}
