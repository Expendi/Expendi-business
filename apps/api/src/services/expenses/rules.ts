import { and, asc, between, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import type {
  DuplicateOf,
  ExpenseKind,
  ExpenseWarning,
} from "@expendi-business/shared";
import {
  expenseWarningSchema,
  formatKesAmount,
  STALE_EXPENSE_DAYS,
} from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { expenses } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";

/**
 * The rules every expense goes through, whatever its kind: staff claims now,
 * petty cash and company spending in Phase 2B (spec §6.5). Duplicate checks
 * look at every expense in the company, imported history included, so none
 * of them filter by source, kind or status.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
/** spent_on within this many days either side counts as the same day. */
export const NEAR_DUPLICATE_WINDOW_DAYS = 1;
/** One warning per match is plenty for the admin to follow up. */
const MAX_NEAR_DUPLICATES = 5;

/** Expense dates are calendar days in Kenya (spec §6.24). */
export function nairobiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
  }).format(now);
}

/** Whole days from one `YYYY-MM-DD` to another. */
export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

/** Exactly 60 days old is fine; 61 isn't (spec §6.5: "more than 60 days"). */
export function ageWarning(
  spentOn: string,
  today: string,
): ExpenseWarning | null {
  const ageDays = daysBetween(spentOn, today);
  return ageDays > STALE_EXPENSE_DAYS
    ? { code: "older_than_60_days", spentOn, ageDays }
    : null;
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

/** The expense being checked; `id` is null before it's written. */
export interface RuleSubject {
  readonly id: string | null;
  readonly organizationId: string;
  readonly membershipId: string;
  readonly amountKes: bigint;
  readonly spentOn: string;
}

/**
 * Another live expense by the same person for the same amount, dated a day
 * either side or the same day. Rejected ones don't count: they were turned
 * down, often for being duplicates.
 */
export function nearDuplicateWarnings(
  tx: Transaction,
  subject: RuleSubject,
): Effect.Effect<ExpenseWarning[], DatabaseError> {
  return query(() =>
    tx
      .select({
        id: expenses.id,
        spentOn: expenses.spentOn,
        amountKes: expenses.amountKes,
      })
      .from(expenses)
      .where(
        and(
          eq(expenses.organizationId, subject.organizationId),
          eq(expenses.membershipId, subject.membershipId),
          eq(expenses.amountKes, subject.amountKes),
          between(
            expenses.spentOn,
            addDays(subject.spentOn, -NEAR_DUPLICATE_WINDOW_DAYS),
            addDays(subject.spentOn, NEAR_DUPLICATE_WINDOW_DAYS),
          ),
          ne(expenses.status, "rejected"),
          subject.id === null ? undefined : ne(expenses.id, subject.id),
        ),
      )
      .orderBy(asc(expenses.spentOn), asc(expenses.createdAt))
      .limit(MAX_NEAR_DUPLICATES),
  ).pipe(
    Effect.map((rows) =>
      rows.map((row): ExpenseWarning => ({
        code: "near_duplicate",
        expenseId: row.id,
        spentOn: row.spentOn,
        amountKes: row.amountKes.toString(),
      })),
    ),
  );
}

/** Recomputed whenever an expense is recorded or edited. */
export function expenseWarnings(
  tx: Transaction,
  subject: RuleSubject,
  today: string = nairobiToday(),
): Effect.Effect<ExpenseWarning[], DatabaseError> {
  return nearDuplicateWarnings(tx, subject).pipe(
    Effect.map((nearDuplicates) => {
      const age = ageWarning(subject.spentOn, today);
      return age ? [...nearDuplicates, age] : nearDuplicates;
    }),
  );
}

/** Stored warnings as the API returns them; anything malformed is dropped. */
export function readWarnings(stored: unknown): ExpenseWarning[] {
  if (!Array.isArray(stored)) return [];
  return stored.flatMap((warning) => {
    const parsed = expenseWarningSchema.safeParse(warning);
    return parsed.success ? [parsed.data] : [];
  });
}

export const NEEDS_EVIDENCE =
  "Add a photo or screenshot of the receipt, or paste the M-Pesa SMS.";

/** spec §6.5: no receipt, screenshot or SMS, no expense. */
export function requireEvidence(
  receiptCount: number,
): Effect.Effect<void, BadRequest> {
  return receiptCount > 0
    ? Effect.void
    : Effect.fail(new BadRequest({ message: NEEDS_EVIDENCE }));
}

/** Who's asking, to word a duplicate and decide whether to link to it. */
export interface Viewer {
  readonly membershipId: string;
  readonly isAdmin: boolean;
}

interface EarlierExpense {
  readonly id: string;
  readonly membershipId: string;
  readonly kind: ExpenseKind;
  readonly source: "app" | "import";
  readonly spentOn: string;
  readonly amountKes: bigint;
}

const earlierExpenseColumns = {
  id: expenses.id,
  membershipId: expenses.membershipId,
  kind: expenses.kind,
  source: expenses.source,
  spentOn: expenses.spentOn,
  amountKes: expenses.amountKes,
};

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** `2026-10-15` → `15 Oct 2026`. */
function formatDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

const KIND_NAMES: Readonly<Record<ExpenseKind, string>> = {
  claim: "claim",
  float: "petty cash spending",
  company: "company spending",
};

/**
 * "your claim of 15 Oct 2026 for KES 1,500.50": whose it is, the date and
 * the amount, and nothing else about someone else's expense.
 */
function describe(earlier: EarlierExpense, viewer: Viewer): string {
  const yours = earlier.membershipId === viewer.membershipId;
  const owner = yours
    ? "your"
    : earlier.kind === "company"
      ? "the company's"
      : "another employee's";
  const imported = earlier.source === "import" ? " (from the spreadsheet)" : "";
  return `${owner} ${KIND_NAMES[earlier.kind]} of ${formatDay(earlier.spentOn)} for ${formatKesAmount(earlier.amountKes)}${imported}`;
}

/** Admins can open any expense in their company; others only their own. */
function duplicateOf(earlier: EarlierExpense, viewer: Viewer): DuplicateOf {
  const yours = earlier.membershipId === viewer.membershipId;
  return {
    expenseId: yours || viewer.isAdmin ? earlier.id : null,
    kind: earlier.kind,
    spentOn: earlier.spentOn,
    amountKes: earlier.amountKes.toString(),
    yours,
  };
}

/** A 409 that names the earlier expense the new one duplicates. */
export function duplicateConflict(
  what: string,
  earlier: EarlierExpense,
  viewer: Viewer,
): Conflict {
  return new Conflict({
    message: `${what} is already on ${describe(earlier, viewer)}.`,
    details: { duplicateOf: duplicateOf(earlier, viewer) },
  });
}

export interface DuplicateKeys {
  readonly mpesaCode: string | null;
  readonly etimsInvoiceNumber: string | null;
}

/**
 * spec §6.5: the same M-Pesa code or eTIMS invoice number twice in a
 * company is blocked, pointing at the earlier expense. The unique indexes
 * still catch a race between two writes.
 */
export function checkDuplicateKeys(
  tx: Transaction,
  organizationId: string,
  keys: DuplicateKeys,
  viewer: Viewer,
  excludeExpenseId: string | null,
): Effect.Effect<void, Conflict | DatabaseError> {
  const checks = [
    {
      value: keys.mpesaCode,
      column: expenses.mpesaCode,
      what: "This M-Pesa code",
    },
    {
      value: keys.etimsInvoiceNumber,
      column: expenses.etimsInvoiceNumber,
      what: "This eTIMS invoice number",
    },
  ];
  return Effect.forEach(
    checks,
    ({ value, column, what }) =>
      value === null
        ? Effect.void
        : query(() =>
            tx
              .select(earlierExpenseColumns)
              .from(expenses)
              .where(
                and(
                  eq(expenses.organizationId, organizationId),
                  eq(column, value),
                  excludeExpenseId === null
                    ? undefined
                    : ne(expenses.id, excludeExpenseId),
                ),
              )
              .limit(1),
          ).pipe(
            Effect.flatMap(([earlier]) =>
              earlier
                ? Effect.fail(duplicateConflict(what, earlier, viewer))
                : Effect.void,
            ),
          ),
    { discard: true },
  );
}

/** The expense a receipt file already belongs to, for a duplicate upload. */
export function findExpense(
  tx: Transaction,
  organizationId: string,
  expenseId: string,
): Effect.Effect<EarlierExpense | null, DatabaseError> {
  return query(() =>
    tx
      .select(earlierExpenseColumns)
      .from(expenses)
      .where(
        and(
          eq(expenses.organizationId, organizationId),
          eq(expenses.id, expenseId),
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([earlier]) => earlier ?? null));
}
