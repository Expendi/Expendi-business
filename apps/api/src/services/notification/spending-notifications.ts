import { and, count, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { SpendingNotificationType } from "@expendi-business/shared";
import {
  formatKesAmount,
  formatUsdAmount,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import {
  bills,
  cards,
  floatMovements,
  floats,
  payees,
  payrollRuns,
  recurringItems,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

export type BillReminderKind = Extract<
  SpendingNotificationType,
  "bill_due_soon" | "bill_due_today" | "bill_overdue"
>;

/**
 * Bills, payroll, the wallet and floats (spec §6.10). Each is sent at most
 * once (its `dedupeKey`), and only while it's still true when queued: a
 * bill paid since its reminder was due sends nothing.
 */
export type SpendingNotificationEvent =
  | {
      readonly kind: BillReminderKind;
      readonly organizationId: string;
      readonly billId: string;
    }
  | {
      readonly kind: "payroll_ready";
      readonly organizationId: string;
      readonly payrollRunId: string;
    }
  | {
      readonly kind: "wallet_short";
      readonly organizationId: string;
      /** The Nairobi day of the check; one warning a day at most. */
      readonly today: string;
      /** The window's last day, included. */
      readonly through: string;
      readonly shortKes: bigint;
    }
  | {
      readonly kind: "salary_paid";
      readonly organizationId: string;
      readonly billId: string;
    }
  | {
      readonly kind: "float_issued" | "float_topped_up";
      readonly organizationId: string;
      readonly movementId: string;
    };

const ADMINS = { to: "admins", exceptMembershipId: null } as const;

const DAY_FORMAT = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});

/** `2026-11-05` → "Thu 5 Nov": the dates are Nairobi days already. */
function day(isoDate: string): string {
  return DAY_FORMAT.format(new Date(`${isoDate}T00:00:00Z`));
}

/** "KES 1,500" for whole shillings, "KES 1,500.50" otherwise. */
function kes(cents: bigint): string {
  return formatKesAmount(cents).replace(/\.00$/, "");
}

const NONE: readonly OutgoingNotification[] = [];

/**
 * Due soon, due today, overdue: to admins, by push and email. A bill a
 * company-held card pays is reminded only once overdue, as a Card purchase
 * that hasn't arrived.
 */
export function billReminderNotifications(
  tx: Transaction,
  event: Extract<SpendingNotificationEvent, { kind: BillReminderKind }>,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return query(() =>
    tx
      .select({
        status: bills.status,
        dueOn: bills.dueOn,
        currency: bills.currency,
        amountKes: bills.amountKes,
        amountUsdc: bills.amountUsdc,
        payrollRunId: bills.payrollRunId,
        payeeName: payees.name,
        payVia: recurringItems.payVia,
        cardLastFour: cards.lastFour,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .leftJoin(cards, eq(cards.id, recurringItems.cardId))
      .where(
        and(
          eq(bills.id, event.billId),
          eq(bills.organizationId, event.organizationId),
        ),
      ),
  ).pipe(
    Effect.map(([bill]) => {
      if (
        bill?.payrollRunId !== null ||
        !UNPAID_BILL_STATUSES.some((status) => status === bill.status)
      ) {
        return NONE;
      }
      const byCard = bill.payVia === "card";
      if (byCard && event.kind !== "bill_overdue") return NONE;
      const amount =
        bill.currency === "usd"
          ? bill.amountUsdc === null
            ? null
            : formatUsdAmount(bill.amountUsdc)
          : bill.amountKes === null
            ? null
            : kes(bill.amountKes);
      const what =
        amount === null
          ? `The bill from ${bill.payeeName}`
          : `${amount} to ${bill.payeeName}`;
      const card =
        bill.cardLastFour === null
          ? "its company-held card"
          : `card •••• ${bill.cardLastFour}`;
      const { title, body } = byCard
        ? {
            title: "Card payment overdue",
            body: `${bill.payeeName} hasn't charged ${card} yet for the bill due ${day(bill.dueOn)}. Check the subscription with them, or mark the bill paid if it was paid another way.`,
          }
        : event.kind === "bill_due_soon"
          ? {
              title: "Bill due soon",
              body: `${what} is due ${day(bill.dueOn)}.`,
            }
          : event.kind === "bill_due_today"
            ? { title: "Bill due today", body: `${what} is due today.` }
            : {
                title: "Bill overdue",
                body: `${what} was due ${day(bill.dueOn)} and hasn't been paid.`,
              };
      return [
        {
          audience: ADMINS,
          title,
          body,
          data: {
            type: event.kind,
            organizationId: event.organizationId,
            billId: event.billId,
          },
          alsoByEmail: true,
          dedupeKey: `${event.kind}:${event.billId}`,
        },
      ];
    }),
  );
}

/**
 * A draft run to admins, by push. Counts only, no amounts: salaries stay
 * out of the outbox, which isn't limited to admins in row-level security.
 */
export function payrollReadyNotifications(
  tx: Transaction,
  event: Extract<SpendingNotificationEvent, { kind: "payroll_ready" }>,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return Effect.gen(function* () {
    const [run] = yield* query(() =>
      tx
        .select({ payDate: payrollRuns.payDate, status: payrollRuns.status })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.id, event.payrollRunId),
            eq(payrollRuns.organizationId, event.organizationId),
          ),
        ),
    );
    if (run?.status !== "draft") return NONE;
    const [included] = yield* query(() =>
      tx
        .select({ payments: count() })
        .from(bills)
        .where(
          and(
            eq(bills.payrollRunId, event.payrollRunId),
            ne(bills.status, "cancelled"),
          ),
        ),
    );
    const payments = included?.payments ?? 0;
    return [
      {
        audience: ADMINS,
        title: "Payroll ready to review",
        body: `Payroll for ${day(run.payDate)} has ${payments} ${payments === 1 ? "payment" : "payments"} to review before pay day.`,
        data: {
          type: event.kind,
          organizationId: event.organizationId,
          payrollRunId: event.payrollRunId,
        },
        dedupeKey: `${event.kind}:${event.payrollRunId}`,
      },
    ];
  });
}

/** The 7-day cash check came up short: to admins, by push and email. */
export function walletShortNotifications(
  event: Extract<SpendingNotificationEvent, { kind: "wallet_short" }>,
): readonly OutgoingNotification[] {
  if (event.shortKes <= 0n) return NONE;
  return [
    {
      audience: ADMINS,
      title: "Wallet short for upcoming payments",
      body: `Payments due by ${day(event.through)} need ${kes(event.shortKes)} more than the wallet holds. Top up to pay them on time.`,
      data: { type: event.kind, organizationId: event.organizationId },
      alsoByEmail: true,
      dedupeKey: `${event.kind}:${event.today}`,
    },
  ];
}

/**
 * Only to the employee paid, once the whole bill is paid (a split salary's
 * every part). No amount, like `payrollReadyNotifications`. Personnel
 * without a login have no membership and get nothing.
 */
export function salaryPaidNotifications(
  tx: Transaction,
  event: Extract<SpendingNotificationEvent, { kind: "salary_paid" }>,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return query(() =>
    tx
      .select({
        status: bills.status,
        dueOn: bills.dueOn,
        payrollRunId: bills.payrollRunId,
        membershipId: payees.membershipId,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .where(
        and(
          eq(bills.id, event.billId),
          eq(bills.organizationId, event.organizationId),
        ),
      ),
  ).pipe(
    Effect.map(([bill]) => {
      if (
        bill?.status !== "paid" ||
        bill.payrollRunId === null ||
        bill.membershipId === null
      ) {
        return NONE;
      }
      return [
        {
          audience: { to: "member", membershipId: bill.membershipId },
          title: "Salary paid",
          body: `Your salary for ${day(bill.dueOn)} has been paid.`,
          data: {
            type: event.kind,
            organizationId: event.organizationId,
            billId: event.billId,
          },
          dedupeKey: `${event.kind}:${event.billId}`,
        },
      ];
    }),
  );
}

/** A float issue or top-up paid: to its holder, by push. */
export function floatPaidNotifications(
  tx: Transaction,
  event: Extract<
    SpendingNotificationEvent,
    { kind: "float_issued" | "float_topped_up" }
  >,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return query(() =>
    tx
      .select({
        floatId: floatMovements.floatId,
        type: floatMovements.type,
        status: floatMovements.status,
        amountKes: floatMovements.amountKes,
        membershipId: floats.membershipId,
      })
      .from(floatMovements)
      .innerJoin(floats, eq(floats.id, floatMovements.floatId))
      .where(
        and(
          eq(floatMovements.id, event.movementId),
          eq(floatMovements.organizationId, event.organizationId),
        ),
      ),
  ).pipe(
    Effect.map(([movement]) => {
      const expectedType = event.kind === "float_issued" ? "issue" : "top_up";
      if (movement?.status !== "paid" || movement.type !== expectedType) {
        return NONE;
      }
      const amount = kes(movement.amountKes);
      return [
        {
          audience: { to: "member", membershipId: movement.membershipId },
          ...(event.kind === "float_issued"
            ? {
                title: "Petty cash float issued",
                body: `${amount} was sent to you for petty cash.`,
              }
            : {
                title: "Petty cash float topped up",
                body: `${amount} was added to your petty cash float.`,
              }),
          data: {
            type: event.kind,
            organizationId: event.organizationId,
            floatId: movement.floatId,
          },
          dedupeKey: `${event.kind}:${event.movementId}`,
        },
      ];
    }),
  );
}
