import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import {
  REMINDER_DAYS_DEFAULT,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { BillReminderKind } from "./spending-notifications.js";
import {
  bills,
  notificationOutbox,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { addDays, checkCash } from "../overview/cash-check.js";
import { notify } from "./notify.js";

/**
 * The daily reminders (spec §6.10, §6.20): each unpaid bill's due-soon,
 * due-today and overdue reminder, and a warning when the wallet won't cover
 * what's due in the next 7 days. All by Nairobi date.
 *
 * Each goes out once: its outbox rows carry a `dedupeKey` (bill and stage,
 * or company and day) that the outbox's unique index allows once, so a
 * re-run, a restart or a second instance queues nothing more. Only a bill's
 * current stage is queued: after downtime an overdue bill gets its overdue
 * reminder, not a stale "due soon". Payroll bills are left out; their run
 * has its own "ready to review" (`payroll_ready`, queued by the draft job).
 */

/** Reminders wait for the Nairobi morning rather than arrive at midnight. */
export const REMINDER_HOUR = 8;

export const WALLET_SHORT_WINDOW_DAYS = 7;

const NAIROBI_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Nairobi",
  hour: "numeric",
  hourCycle: "h23",
});

export function nairobiHour(at: Date): number {
  return Number(NAIROBI_HOUR.format(at));
}

/** Which reminder an unpaid bill is owed on `today`, if any. */
export function billReminderStage(
  today: string,
  dueOn: string,
  leadDays: number,
): BillReminderKind | null {
  if (today > dueOn) return "bill_overdue";
  if (today === dueOn) return "bill_due_today";
  return addDays(today, leadDays) >= dueOn ? "bill_due_soon" : null;
}

/** Dedupe keys among `keys` already in the company's outbox. */
export function alreadyQueued(
  tx: Transaction,
  organizationId: string,
  keys: readonly string[],
): Effect.Effect<ReadonlySet<string>, DatabaseError> {
  if (keys.length === 0) return Effect.succeed(new Set());
  return query(() =>
    tx
      .selectDistinct({ key: notificationOutbox.dedupeKey })
      .from(notificationOutbox)
      .where(
        and(
          eq(notificationOutbox.organizationId, organizationId),
          inArray(notificationOutbox.dedupeKey, [...keys]),
        ),
      ),
  ).pipe(Effect.map((rows) => new Set(rows.map(({ key }) => key ?? ""))));
}

/**
 * Queues each unpaid bill's reminder for `today`, in the caller's admin
 * scope. A one-off bill is reminded 3 days ahead, a recurring one by its
 * own lead time. Returns how many bills it newly reminded.
 */
export function queueBillReminders(
  tx: Transaction,
  organizationId: string,
  today: string,
): Effect.Effect<number, DatabaseError> {
  return Effect.gen(function* () {
    const unpaid = yield* query(() =>
      tx
        .select({
          id: bills.id,
          dueOn: bills.dueOn,
          leadDays: recurringItems.reminderDays,
        })
        .from(bills)
        .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
        .where(
          and(
            eq(bills.organizationId, organizationId),
            inArray(bills.status, [...UNPAID_BILL_STATUSES]),
            isNull(bills.payrollRunId),
          ),
        ),
    );
    const owed = unpaid.flatMap((bill) => {
      const kind = billReminderStage(
        today,
        bill.dueOn,
        bill.leadDays ?? REMINDER_DAYS_DEFAULT,
      );
      return kind === null
        ? []
        : [{ kind, billId: bill.id, key: `${kind}:${bill.id}` }];
    });
    const queued = yield* alreadyQueued(
      tx,
      organizationId,
      owed.map(({ key }) => key),
    );
    const due = owed.filter(({ key }) => !queued.has(key));
    for (const { kind, billId } of due) {
      yield* notify(tx, { kind, organizationId, billId });
    }
    return due.length;
  });
}

/**
 * Warns the admins once a Nairobi day while the wallet is short for what's
 * due in the next 7 days, by T42's cash check. Nothing when the cash-out
 * provider's rate is unavailable: the check can't tell. Returns whether it warned.
 */
export function queueWalletShortReminder(
  organizationId: string,
  today: string,
): Effect.Effect<boolean, DatabaseError, DatabaseService | Paycrest | Pretium> {
  return Effect.gen(function* () {
    const admin = { organizationId, role: "admin" } as const;
    const dedupeKey = `wallet_short:${today}`;
    const warned = yield* withScope(admin, (tx) =>
      alreadyQueued(tx, organizationId, [dedupeKey]),
    );
    if (warned.size > 0) return false;
    const cash = yield* checkCash({
      organizationId,
      today,
      days: WALLET_SHORT_WINDOW_DAYS,
    });
    if (cash.status !== "short" || cash.shortKes === null) return false;
    const shortKes = cash.shortKes;
    yield* withScope(admin, (tx) =>
      notify(tx, {
        kind: "wallet_short",
        organizationId,
        today,
        through: cash.through,
        shortKes,
      }),
    );
    return true;
  });
}

export interface RemindersRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  readonly companies: number;
  /** Bills newly reminded. */
  readonly bills: number;
  readonly walletWarnings: number;
  readonly failed: number;
}

/**
 * The reminders job: every company with something to pay, each part in its
 * own transaction so one failure holds up nothing else. Null before
 * `REMINDER_HOUR` in Nairobi: nothing is checked yet. `now` is read when it
 * runs.
 */
export function runSpendingReminders(
  now?: Date,
): Effect.Effect<
  RemindersRun | null,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const at = now ?? new Date();
    if (nairobiHour(at) < REMINDER_HOUR) return null;
    const today = nairobiDate(at);
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<{ organization_id: string }>(
          sql`SELECT organization_id FROM reminder_companies()`,
        ),
      ),
    );

    let billCount = 0;
    let walletWarnings = 0;
    let failed = 0;
    const outcome = <A>(
      organizationId: string,
      what: string,
      exit: Exit.Exit<A, DatabaseError>,
    ): A | null => {
      if (Exit.isSuccess(exit)) return exit.value;
      failed += 1;
      console.error(
        `[reminders] company ${organizationId}: ${what} failed`,
        Cause.pretty(exit.cause),
      );
      return null;
    };
    for (const { organization_id: organizationId } of rows) {
      const reminded = yield* Effect.exit(
        withScope({ organizationId, role: "admin" }, (tx) =>
          queueBillReminders(tx, organizationId, today),
        ),
      );
      billCount += outcome(organizationId, "bill reminders", reminded) ?? 0;
      const warned = yield* Effect.exit(
        queueWalletShortReminder(organizationId, today),
      );
      if (outcome(organizationId, "wallet check", warned)) walletWarnings += 1;
    }
    return {
      today,
      companies: rows.length,
      bills: billCount,
      walletWarnings,
      failed,
    };
  });
}
