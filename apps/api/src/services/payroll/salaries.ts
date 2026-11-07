import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import type { SQL } from "drizzle-orm";
import { and, asc, eq, sql } from "drizzle-orm";
import { Cause, Effect } from "effect";

import type {
  CreateSalaryFields,
  PayeeKind,
  PayeeMethod,
  RecurringItemState,
  SalaryAmountChange,
  UpdateSalaryFields,
} from "@expendi-business/shared";
import {
  SALARY_PAYEE_KINDS,
  SALARY_PAYEE_METHODS,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { RecurringItemRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Schedule } from "../recurring/schedule.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  categories,
  memberships,
  organizations,
  payees,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, Forbidden, NotFound } from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate } from "../bills/status.js";
import { EmailSender } from "../email/email-sender.js";
import { salaryChangeEmail } from "../email/salary-email.js";
import { activeAdminRecipients } from "../payees/payees.js";
import { dueOnOrAfter, firstDueOn } from "../recurring/schedule.js";
import { draftDateFor } from "./dates.js";
import { draftDuePayroll } from "./drafts.js";

/**
 * Salaries (spec §6.21), for admins only (spec §4): the routes admit
 * admins, and row-level security hides them from every other role. A
 * salary is a recurring item under the `salaries` heading, paid monthly on
 * its pay day through payroll runs (`drafts.ts`), never by the
 * recurring-bills job.
 *
 * - The payee and start date are set once; to change them, end the salary
 *   and set up a new one.
 * - Net pay changes only with the admin's passkey, bound to the exact
 *   change; it is audited and emails every admin (spec §7.4), because it
 *   moves the payroll cap. It applies to runs drafted afterwards.
 * - A new pay day applies from the next pay date not yet drafted.
 * - Ending is final; a run already drafted keeps the person until an admin
 *   leaves them out.
 */

export interface SalaryView {
  readonly id: string;
  readonly state: RecurringItemState;
  readonly payee: {
    readonly id: string;
    readonly name: string;
    readonly kind: PayeeKind;
    readonly method: PayeeMethod | null;
    readonly archived: boolean;
    readonly payoutPhoneConfirmed: boolean | null;
    readonly accountEnding: string | null;
  };
  readonly category: { readonly id: string; readonly name: string };
  readonly amountKes: bigint;
  readonly payDay: number;
  readonly startsOn: string;
  readonly endsOn: string | null;
  readonly nextPayDate: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PendingSalaryAmountChange extends ApprovalChallenge {
  readonly status: "confirmation_required";
  /** Sent back unchanged with the passkey's response. */
  readonly change: SalaryAmountChange;
}

type SalaryDeps = DatabaseService | AuditLog;
type SalaryError = BadRequest | Conflict | NotFound | DatabaseError;

const ONE_SALARY_PER_PAYEE = "recurring_items_one_salary_per_payee";

const salaryNotFound = new NotFound({ message: "That salary wasn't found." });
const ended = new Conflict({
  message: "This salary has ended, so it can't be changed.",
});
const unknownPayee = new BadRequest({
  message: "Pick one of the company's payees.",
});
const unknownCategory = new BadRequest({
  message: "Pick one of the company's categories.",
});
const notAdmin = new Forbidden({
  message: "Your role in this company can't do this",
});

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

const isSalaryKind = (kind: PayeeKind): boolean =>
  (SALARY_PAYEE_KINDS as readonly PayeeKind[]).includes(kind);

const isSalaryMethod = (method: PayeeMethod | null): boolean =>
  method !== null &&
  (SALARY_PAYEE_METHODS as readonly PayeeMethod[]).includes(method);

function stateOf(
  item: Pick<RecurringItemRow, "active" | "nextDueOn">,
): RecurringItemState {
  if (item.nextDueOn === null) return "ended";
  return item.active ? "active" : "paused";
}

const monthlyOn = (
  payDay: number,
  startsOn: string,
  endsOn: string | null = null,
): Schedule => ({ schedule: "monthly", scheduleDay: payDay, startsOn, endsOn });

// ── Reading ──────────────────────────────────────────────────────────────

/**
 * The last 4 digits of the bank account or M-Pesa number a payee is paid
 * to. An employee's M-Pesa number is their confirmed payout number, which
 * is never shown, not even in part.
 */
export const payeeAccountEnding = sql<string | null>`CASE
  WHEN ${payees.method} = 'mpesa_phone' AND ${payees.membershipId} IS NULL
    AND length(${payees.phone}) > 4 THEN right(${payees.phone}, 4)
  WHEN ${payees.method} = 'bank' AND length(${payees.bankAccountNumber}) > 4
    THEN right(${payees.bankAccountNumber}, 4)
END`;

const salaryColumns = {
  item: recurringItems,
  payeeName: payees.name,
  payeeKind: payees.kind,
  payeeMethod: payees.method,
  payeeArchived: payees.archived,
  payoutPhoneConfirmed: sql<
    boolean | null
  >`CASE WHEN ${payees.membershipId} IS NULL THEN NULL ELSE ${users.phone} IS NOT NULL END`,
  accountEnding: payeeAccountEnding,
  categoryName: categories.name,
};

const selectSalaries = (tx: Transaction, where: SQL | undefined) =>
  tx
    .select(salaryColumns)
    .from(recurringItems)
    .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
    .innerJoin(categories, eq(categories.id, recurringItems.categoryId))
    .leftJoin(memberships, eq(memberships.id, payees.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .where(and(eq(recurringItems.overviewHeading, "salaries"), where));

type SelectedSalary = Awaited<ReturnType<typeof selectSalaries>>[number];

function toView(row: SelectedSalary): SalaryView {
  const { item } = row;
  if (item.amountKes === null) {
    throw new Error(`salary ${item.id} has no amount`);
  }
  return {
    id: item.id,
    state: stateOf(item),
    payee: {
      id: item.payeeId,
      name: row.payeeName,
      kind: row.payeeKind,
      method: row.payeeMethod,
      archived: row.payeeArchived,
      payoutPhoneConfirmed: row.payoutPhoneConfirmed,
      accountEnding: row.accountEnding,
    },
    category: { id: item.categoryId, name: row.categoryName },
    amountKes: item.amountKes,
    payDay: item.scheduleDay,
    startsOn: item.startsOn,
    endsOn: item.endsOn,
    nextPayDate: item.nextDueOn,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Current salaries first, by name; ended ones last. */
export function listSalaries(
  tenant: Tenant,
  limit: number,
): Effect.Effect<SalaryView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectSalaries(
        tx,
        eq(recurringItems.organizationId, tenant.organizationId),
      )
        .orderBy(
          sql`${recurringItems.nextDueOn} IS NULL`,
          sql`lower(${payees.name}) COLLATE "C"`,
          asc(recurringItems.createdAt),
          asc(recurringItems.id),
        )
        .limit(limit),
    ).pipe(Effect.map((rows) => rows.map(toView))),
  );
}

export function getSalary(
  tenant: Tenant,
  salaryId: string,
): Effect.Effect<SalaryView, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectSalaries(
        tx,
        and(
          eq(recurringItems.organizationId, tenant.organizationId),
          eq(recurringItems.id, salaryId),
        ),
      ).limit(1),
    ).pipe(
      Effect.flatMap(([row]) =>
        row ? Effect.succeed(toView(row)) : Effect.fail(salaryNotFound),
      ),
    ),
  );
}

// ── Checks ───────────────────────────────────────────────────────────────

/**
 * Someone who can be on payroll: an employee or other personnel, not
 * archived, with an M-Pesa number or a bank account to be paid to.
 */
export function findSalaryPayee(
  tx: Transaction,
  organizationId: string,
  payeeId: string,
): Effect.Effect<{ readonly name: string }, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({
        name: payees.name,
        kind: payees.kind,
        method: payees.method,
        archived: payees.archived,
      })
      .from(payees)
      .where(
        and(eq(payees.organizationId, organizationId), eq(payees.id, payeeId)),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([payee]) => {
      if (!payee) return Effect.fail(unknownPayee);
      if (payee.archived) {
        return Effect.fail(
          new BadRequest({
            message: `${payee.name} is archived. Pick someone else.`,
          }),
        );
      }
      if (!isSalaryKind(payee.kind)) {
        return Effect.fail(
          new BadRequest({
            message:
              "Only employees and other personnel are paid through payroll.",
          }),
        );
      }
      if (!isSalaryMethod(payee.method)) {
        return Effect.fail(
          new BadRequest({
            message: `Give ${payee.name} an M-Pesa number or a bank account first: pay goes to one of those.`,
          }),
        );
      }
      return Effect.succeed({ name: payee.name });
    }),
  );
}

export function checkCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
): Effect.Effect<void, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({ archived: categories.archived })
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, organizationId),
          eq(categories.id, categoryId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([category]) =>
      category && !category.archived
        ? Effect.void
        : Effect.fail(unknownCategory),
    ),
  );
}

/** A salary that hasn't ended, with its payee's name. */
type CurrentSalary = RecurringItemRow & {
  readonly amountKes: bigint;
  readonly nextDueOn: string;
  readonly payeeName: string;
};

/** The salary, locked for the rest of the transaction; ended ones can't change. */
function lockCurrentSalary(
  tx: Transaction,
  organizationId: string,
  salaryId: string,
): Effect.Effect<CurrentSalary, NotFound | Conflict | DatabaseError> {
  return query(() =>
    tx
      .select({ item: recurringItems, payeeName: payees.name })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          eq(recurringItems.id, salaryId),
          eq(recurringItems.overviewHeading, "salaries"),
        ),
      )
      .for("update", { of: recurringItems }),
  ).pipe(
    Effect.flatMap(
      ([row]): Effect.Effect<CurrentSalary, NotFound | Conflict> => {
        if (!row) return Effect.fail(salaryNotFound);
        const { item } = row;
        const { amountKes, nextDueOn } = item;
        if (nextDueOn === null) return Effect.fail(ended);
        if (amountKes === null) {
          return Effect.dieMessage(`salary ${item.id} has no amount`);
        }
        return Effect.succeed({
          ...item,
          amountKes,
          nextDueOn,
          payeeName: row.payeeName,
        });
      },
    ),
  );
}

/** Admin-only routes check the role at the door; a passkey-confirmed change checks again inside. */
function requireActiveAdmin(
  tx: Transaction,
  tenant: Tenant,
): Effect.Effect<void, Forbidden | DatabaseError> {
  return query(() =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, tenant.organizationId),
          eq(memberships.userId, tenant.userId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([membership]) =>
      membership ? Effect.void : Effect.fail(notAdmin),
    ),
  );
}

/**
 * Drafts any payroll run a salary change has just made due, so the admin
 * sees it at once. Best effort, after the commit: the payroll-drafts job
 * drafts it within minutes if this fails.
 */
function draftAfterChange(
  organizationId: string,
  now: Date,
): Effect.Effect<void, never, SalaryDeps> {
  return draftDuePayroll(organizationId, now).pipe(
    Effect.asVoid,
    Effect.catchAllCause((cause) =>
      Effect.sync(() => {
        console.error(
          `[payroll] drafting for company ${organizationId} after a salary change failed`,
          Cause.pretty(cause),
        );
      }),
    ),
  );
}

// ── Changes ──────────────────────────────────────────────────────────────

/**
 * Puts someone on payroll. Their first pay date is the first pay day on or
 * after the start date, today if none is given.
 */
export function createSalary(
  tenant: Tenant,
  fields: CreateSalaryFields,
  now: Date = new Date(),
): Effect.Effect<SalaryView, SalaryError, SalaryDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    const startsOn = fields.startsOn ?? today;
    if (startsOn < today) {
      return yield* Effect.fail(
        new BadRequest({ message: "The start date can't be in the past." }),
      );
    }
    const schedule = monthlyOn(fields.payDay, startsOn);
    const nextDueOn = firstDueOn(schedule);
    if (nextDueOn === null) {
      return yield* Effect.dieMessage(
        "a monthly salary with no end has no pay date",
      );
    }

    const salaryId = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const payee = yield* findSalaryPayee(
          tx,
          organizationId,
          fields.payeeId,
        );
        yield* checkCategory(tx, organizationId, fields.categoryId);
        const values = {
          payeeId: fields.payeeId,
          overviewHeading: "salaries" as const,
          categoryId: fields.categoryId,
          amountKes: fields.amountKes,
          ...schedule,
          payVia: "expendi" as const,
          nextDueOn,
        };
        const [created] = yield* query(() =>
          tx
            .insert(recurringItems)
            .values({ organizationId, ...values })
            .returning({ id: recurringItems.id }),
        ).pipe(
          Effect.catchTag(
            "DatabaseError",
            (error): Effect.Effect<never, Conflict | DatabaseError> =>
              violatedUniqueConstraint(error.cause) === ONE_SALARY_PER_PAYEE
                ? Effect.fail(
                    new Conflict({
                      message: `${payee.name} already has a salary. Change that one instead.`,
                    }),
                  )
                : Effect.fail(error),
          ),
        );
        if (!created) {
          return yield* Effect.dieMessage("salary insert wrote no row");
        }
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "salary.created",
          entity: { type: "recurring_item", id: created.id },
          after: values,
        });
        return created.id;
      }),
    );
    yield* draftAfterChange(organizationId, now);
    return yield* getSalary(tenant, salaryId);
  });
}

/**
 * The next pay date on the new pay day: in the same month as the next pay
 * date not yet drafted, so a month is neither paid twice nor skipped.
 * Null when that day has already passed: the change waits until this
 * month's run is drafted.
 */
export function nextPayDateOnNewDay(
  salary: Pick<RecurringItemRow, "startsOn" | "endsOn"> & {
    readonly nextDueOn: string;
  },
  payDay: number,
  today: string,
): string | null {
  const next = dueOnOrAfter(
    monthlyOn(payDay, salary.startsOn, salary.endsOn),
    `${salary.nextDueOn.slice(0, 8)}01`,
  );
  return next !== null && next >= today ? next : null;
}

/** Changes the pay day or the category; net pay needs the passkey. */
export function updateSalary(
  tenant: Tenant,
  salaryId: string,
  changes: UpdateSalaryFields,
  now: Date = new Date(),
): Effect.Effect<SalaryView, SalaryError, SalaryDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockCurrentSalary(tx, organizationId, salaryId);
        const before: Partial<RecurringItemRow> = {};
        const after: Partial<RecurringItemRow> = {};

        if (
          changes.categoryId !== undefined &&
          changes.categoryId !== row.categoryId
        ) {
          yield* checkCategory(tx, organizationId, changes.categoryId);
          before.categoryId = row.categoryId;
          after.categoryId = changes.categoryId;
        }
        if (
          changes.payDay !== undefined &&
          changes.payDay !== row.scheduleDay
        ) {
          const nextDueOn = nextPayDateOnNewDay(row, changes.payDay, today);
          if (nextDueOn === null) {
            return yield* Effect.fail(
              new Conflict({
                message: `That day has already passed this month, and this month's payroll run isn't drafted yet. Change the pay day once it is, from ${draftDateFor(row.nextDueOn)}.`,
              }),
            );
          }
          before.scheduleDay = row.scheduleDay;
          before.nextDueOn = row.nextDueOn;
          after.scheduleDay = changes.payDay;
          after.nextDueOn = nextDueOn;
        }
        if (Object.keys(after).length === 0) return;

        yield* query(() =>
          tx
            .update(recurringItems)
            .set(after)
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "salary.updated",
          entity: { type: "recurring_item", id: row.id },
          before,
          after,
        });
      }),
    );
    if (changes.payDay !== undefined) {
      yield* draftAfterChange(organizationId, now);
    }
    return yield* getSalary(tenant, salaryId);
  });
}

/** What the passkey signs: the company and exactly this change. */
export function salaryChangeIntentHash(
  organizationId: string,
  change: SalaryAmountChange,
): string {
  return sha256Hex(
    canonicalJson({ version: 1, kind: "salary", organizationId, change }),
  );
}

/**
 * Asks for the admin's passkey to change someone's net pay (spec §7.4).
 * Nothing changes until `confirmSalaryAmountChange`.
 */
export function requestSalaryAmountChange(
  tenant: Tenant,
  salaryId: string,
  amountKes: bigint,
): Effect.Effect<
  PendingSalaryAmountChange,
  SalaryError | Forbidden,
  SalaryDeps | ApprovalSettings
> {
  return Effect.gen(function* () {
    const row = yield* withScope(tenant, (tx) =>
      requireActiveAdmin(tx, tenant).pipe(
        Effect.zipRight(lockCurrentSalary(tx, tenant.organizationId, salaryId)),
      ),
    );
    if (row.amountKes === amountKes) {
      return yield* Effect.fail(
        new BadRequest({ message: "That's already their net pay." }),
      );
    }
    const change = { salaryId, amountKesCents: amountKes.toString() };
    const challenge = yield* startApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      purpose: "change_salary",
      intentHash: salaryChangeIntentHash(tenant.organizationId, change),
    });
    return { status: "confirmation_required", ...challenge, change };
  });
}

interface SalaryNotice {
  readonly recipients: readonly {
    readonly userId: string;
    readonly email: string;
  }[];
  readonly companyName: string;
  readonly actorName: string;
  readonly payeeName: string;
  readonly beforeKes: bigint;
  readonly afterKes: bigint;
}

function buildNotice(
  tx: Transaction,
  tenant: Tenant,
  change: Omit<SalaryNotice, "recipients" | "companyName" | "actorName">,
): Effect.Effect<SalaryNotice, DatabaseError> {
  return Effect.gen(function* () {
    const recipients = yield* activeAdminRecipients(tx, tenant.organizationId);
    const [company] = yield* query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, tenant.organizationId)),
    );
    const [actor] = yield* query(() =>
      tx
        .select({ fullName: users.fullName, email: users.email })
        .from(users)
        .where(eq(users.id, tenant.userId)),
    );
    return {
      ...change,
      recipients,
      companyName: company?.name ?? "your company",
      actorName: actor?.fullName ?? actor?.email ?? "An admin",
    };
  });
}

/**
 * Best effort, after the commit: a failed email never undoes the change
 * and is logged with the admin's user ID only.
 */
function sendNotice(
  notice: SalaryNotice,
): Effect.Effect<void, never, EmailSender> {
  return Effect.forEach(
    notice.recipients,
    ({ userId, email }) =>
      Effect.flatMap(EmailSender, (sender) =>
        sender.send(salaryChangeEmail({ ...notice, to: email })),
      ).pipe(
        Effect.catchTag("EmailSendError", (error) =>
          Effect.sync(() => {
            console.error(
              `[payroll] salary email to admin ${userId} not sent: ${error.message}`,
            );
          }),
        ),
      ),
    { discard: true },
  );
}

/**
 * Applies a new net pay once the admin's passkey has confirmed exactly
 * that change. The change is sent again with the signature; if it differs
 * from what was challenged, nothing happens. Audited, and every admin is
 * emailed.
 */
export function confirmSalaryAmountChange(
  tenant: Tenant,
  input: {
    readonly challengeId: string;
    readonly response: AuthenticationResponseJSON;
    readonly change: SalaryAmountChange;
  },
): Effect.Effect<
  SalaryView,
  SalaryError | Forbidden,
  SalaryDeps | ApprovalSettings | EmailSender
> {
  const { organizationId } = tenant;
  return Effect.gen(function* () {
    const approval = yield* verifyApproval({
      organizationId,
      userId: tenant.userId,
      purpose: "change_salary",
      challengeId: input.challengeId,
      response: input.response,
    });
    if (
      salaryChangeIntentHash(organizationId, input.change) !==
      approval.intentHash
    ) {
      return yield* Effect.fail(
        new Forbidden({
          message: "That isn't the change you confirmed. Confirm again.",
        }),
      );
    }
    const afterKes = BigInt(input.change.amountKesCents);
    const audit = yield* AuditLog;

    const notice = yield* withScope({ ...tenant, role: "admin" }, (tx) =>
      Effect.gen(function* () {
        yield* requireActiveAdmin(tx, tenant);
        const row = yield* lockCurrentSalary(
          tx,
          organizationId,
          input.change.salaryId,
        );
        if (row.amountKes === afterKes) return null;
        yield* query(() =>
          tx
            .update(recurringItems)
            .set({ amountKes: afterKes })
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "salary.amount_changed",
          entity: { type: "recurring_item", id: row.id },
          before: { amountKes: row.amountKes },
          after: { amountKes: afterKes, approvalId: approval.approvalId },
        });
        return yield* buildNotice(tx, tenant, {
          payeeName: row.payeeName,
          beforeKes: row.amountKes,
          afterKes,
        });
      }),
    );
    if (notice) yield* sendNotice(notice);
    return yield* getSalary(tenant, input.change.salaryId);
  });
}

/**
 * Takes someone off payroll for good: no more runs. A run already drafted
 * keeps them until an admin leaves them out of it.
 */
export function endSalary(
  tenant: Tenant,
  salaryId: string,
  now: Date = new Date(),
): Effect.Effect<SalaryView, SalaryError, SalaryDeps> {
  const { organizationId } = tenant;
  const today = nairobiDate(now);
  return Effect.gen(function* () {
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const row = yield* lockCurrentSalary(tx, organizationId, salaryId);
        const endsOn = row.startsOn > today ? row.startsOn : today;
        yield* query(() =>
          tx
            .update(recurringItems)
            .set({ endsOn, nextDueOn: null })
            .where(eq(recurringItems.id, row.id)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId,
          action: "salary.ended",
          entity: { type: "recurring_item", id: row.id },
          before: { endsOn: row.endsOn, nextDueOn: row.nextDueOn },
          after: { endsOn, nextDueOn: null },
        });
      }),
    );
    return yield* getSalary(tenant, salaryId);
  });
}
