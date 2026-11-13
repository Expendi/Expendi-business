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
 * due-today and overdue reminder, and a warning when the wallet, or the
 * Card balance, won't cover what's due in the next 7 days. All by Nairobi
 * date. A bill a company-held card pays gets only the overdue one: the
 * purchase comes without anyone acting, so only its not arriving is news.
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
 * own lead time, and a card-paid one only once overdue. Returns how many
 * bills it newly reminded.
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
          payVia: recurringItems.payVia,
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
      if (kind === null) return [];
      if (bill.payVia === "card" && kind !== "bill_overdue") return [];
      return [{ kind, billId: bill.id, key: `${kind}:${bill.id}` }];
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

export interface BalanceWarnings {
  readonly wallet: boolean;
  readonly card: boolean;
}

/**
 * Warns the admins once a Nairobi day while the wallet is short for what's
 * due in the next 7 days, by T42's cash check, and once a day while the
 * Card balance is short for what company-held cards will pay in them. The
 * wallet can't be checked when the cash-out provider's rate is unavailable;
 * the Card balance, in USD, still can. Returns which it warned about.
 */
export function queueBalanceWarnings(
  organizationId: string,
  today: string,
): Effect.Effect<
  BalanceWarnings,
  DatabaseError,
  DatabaseService | Paycrest | Pretium
> {
  return Effect.gen(function* () {
    const admin = { organizationId, role: "admin" } as const;
    const walletKey = `wallet_short:${today}`;
    const cardKey = `card_balance_short:${today}`;
    const warned = yield* withScope(admin, (tx) =>
      alreadyQueued(tx, organizationId, [walletKey, cardKey]),
    );
    if (warned.has(walletKey) && warned.has(cardKey)) {
      return { wallet: false, card: false };
    }
    const cash = yield* checkCash({
      organizationId,
      today,
      days: WALLET_SHORT_WINDOW_DAYS,
    });
    const shortKes =
      !warned.has(walletKey) && cash.status === "short" ? cash.shortKes : null;
    const cardBills =
      !warned.has(cardKey) && cash.cardBills?.short ? cash.cardBills : null;
    if (shortKes === null && cardBills === null) {
      return { wallet: false, card: false };
    }
    yield* withScope(admin, (tx) =>
      Effect.gen(function* () {
        if (shortKes !== null) {
          yield* notify(tx, {
            kind: "wallet_short",
            organizationId,
            today,
            through: cash.through,
            shortKes,
          });
        }
        if (cardBills !== null) {
          yield* notify(tx, {
            kind: "card_balance_short",
            organizationId,
            today,
            dueUsdCents: cardBills.dueUsdCents,
            availableUsdCents: cardBills.availableUsdCents,
          });
        }
      }),
    );
    return { wallet: shortKes !== null, card: cardBills !== null };
  });
}

/** `queueBalanceWarnings`, answering whether it warned about the wallet. */
export function queueWalletShortReminder(
  organizationId: string,
  today: string,
): Effect.Effect<boolean, DatabaseError, DatabaseService | Paycrest | Pretium> {
  return queueBalanceWarnings(organizationId, today).pipe(
    Effect.map((warnings) => warnings.wallet),
  );
}

export interface RemindersRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  readonly companies: number;
  /** Bills newly reminded. */
  readonly bills: number;
  readonly walletWarnings: number;
  readonly cardBalanceWarnings: number;
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
    let cardBalanceWarnings = 0;
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
      const warned = outcome(
        organizationId,
        "balance check",
        yield* Effect.exit(queueBalanceWarnings(organizationId, today)),
      );
      if (warned?.wallet) walletWarnings += 1;
      if (warned?.card) cardBalanceWarnings += 1;
    }
    return {
      today,
      companies: rows.length,
      bills: billCount,
      walletWarnings,
      cardBalanceWarnings,
      failed,
    };
  });
}
