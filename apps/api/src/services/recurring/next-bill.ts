import { and, eq, inArray, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { OUTSTANDING_BILL_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { BillRow, NewBill } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { bills, payees, recurringItems } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate, scheduledStatus } from "../bills/status.js";
import { dueAfter } from "./schedule.js";

/**
 * Keeps each recurring payment's next bill in place (spec §6.20): every
 * active item has exactly one bill still owed. The next one is created
 * when the current one is paid, paid outside or cancelled, in the same
 * transaction, and the daily job (`createOwedRecurringBills`) is the
 * safety net for anything that slipped through.
 *
 * "Exactly one" is the `bills_recurring_item_outstanding_unique` index: a
 * second bill still owed for the same item can't be written, however the
 * attempts interleave, and that's how an attempt learns the bill is
 * already there.
 */

const RECURRING_BILLS: AuditActor = { type: "system", id: "recurring-bills" };

const OUTSTANDING_UNIQUE = "bills_recurring_item_outstanding_unique";

export type NextBillOutcome =
  | {
      readonly kind: "created";
      readonly billId: string;
      readonly dueOn: string;
    }
  /** The item already has a bill still owed. */
  | { readonly kind: "already_there" }
  | { readonly kind: "paused" }
  | { readonly kind: "ended" }
  /** An archived payee gets no new bills (as with one-off bills). */
  | { readonly kind: "payee_archived" }
  /** Salaries are billed by payroll runs (T38). */
  | { readonly kind: "payroll" };

/** Inserts the bill, or reports that the item already has one still owed. */
function insertUnlessOutstanding(
  tx: Transaction,
  values: NewBill,
): Effect.Effect<string | null, DatabaseError> {
  return query(() =>
    // A savepoint, so a clash rolls back only this insert, not the
    // transaction settling the bill before it.
    tx.transaction((savepoint) =>
      savepoint.insert(bills).values(values).returning({ id: bills.id }),
    ),
  ).pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed<string | null>(row.id)
        : Effect.dieMessage("bill insert wrote no row"),
    ),
    Effect.catchTag("DatabaseError", (error) =>
      violatedUniqueConstraint(error.cause) === OUTSTANDING_UNIQUE
        ? Effect.succeed(null)
        : Effect.fail(error),
    ),
  );
}

/**
 * Locks the item's bill still owed, if any. Anything that locks a recurring
 * item and then writes its bills takes this first: settling a bill locks
 * the bill and then the item, and the same order everywhere means no
 * deadlock. A path that also locks a card's merchants takes them before
 * this (`cards/merchants.ts`).
 */
export function lockOutstandingBills(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
): Effect.Effect<void, DatabaseError> {
  return query(() =>
    tx
      .select({ id: bills.id })
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, organizationId),
          eq(bills.recurringItemId, recurringItemId),
          inArray(bills.status, [...OUTSTANDING_BILL_STATUSES]),
        ),
      )
      .for("update"),
  ).pipe(Effect.asVoid);
}

/**
 * Creates the item's next bill, due on its `next_due_on`, and moves
 * `next_due_on` on to the following due date (null once the schedule
 * ends). The bill takes the item's amount (none if variable), heading and
 * category, and its status from the due date against `today` in Nairobi.
 * Audited as the system: the schedule made the bill, not a person.
 *
 * Runs inside the caller's transaction and company scope, which must carry
 * the admin role. Whether a bill is already owed is left to the unique
 * index rather than checked first, so no interleaving can slip a second
 * one in.
 */
export function createNextRecurringBill(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
  today: string,
): Effect.Effect<NextBillOutcome, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* lockOutstandingBills(tx, organizationId, recurringItemId);
    const [found] = yield* query(() =>
      tx
        .select({ item: recurringItems, payeeArchived: payees.archived })
        .from(recurringItems)
        .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.id, recurringItemId),
          ),
        )
        .for("update", { of: recurringItems }),
    );
    if (!found) {
      return yield* Effect.dieMessage(
        `recurring item ${recurringItemId} not found in its company`,
      );
    }
    const { item } = found;
    if (item.overviewHeading === "salaries") return { kind: "payroll" };
    if (item.nextDueOn === null) return { kind: "ended" };
    if (!item.active) return { kind: "paused" };
    if (found.payeeArchived) return { kind: "payee_archived" };

    const dueOn = item.nextDueOn;
    const values = {
      payeeId: item.payeeId,
      recurringItemId: item.id,
      overviewHeading: item.overviewHeading,
      categoryId: item.categoryId,
      variable: item.amountKes === null && item.amountUsdc === null,
      currency: item.currency,
      amountKes: item.amountKes,
      amountUsdc: item.amountUsdc,
      dueOn,
      status: scheduledStatus(dueOn, today),
    };
    const billId = yield* insertUnlessOutstanding(tx, {
      organizationId,
      ...values,
    });
    if (billId === null) return { kind: "already_there" };

    const following = dueAfter(item, dueOn);
    yield* query(() =>
      tx
        .update(recurringItems)
        .set({ nextDueOn: following })
        .where(eq(recurringItems.id, item.id)),
    );
    yield* audit.record(tx, {
      actor: RECURRING_BILLS,
      organizationId,
      action: "bill.created",
      entity: { type: "bill", id: billId },
      after: { ...values, nextDueOn: following },
    });
    return { kind: "created", billId, dueOn };
  });
}

/**
 * Call when a bill is paid, paid outside or cancelled, in the transaction
 * that settles it and after its status has changed: a recurring bill's
 * next one is created there and then. Nothing happens for a one-off bill.
 * Paying bills through Expendi (T37) calls this when the payout lands and
 * the bill becomes `paid`.
 */
export function onRecurringBillSettled(
  tx: Transaction,
  bill: Pick<BillRow, "organizationId" | "recurringItemId">,
  now: Date,
): Effect.Effect<NextBillOutcome | null, DatabaseError, AuditLog> {
  return bill.recurringItemId === null
    ? Effect.succeed(null)
    : createNextRecurringBill(
        tx,
        bill.organizationId,
        bill.recurringItemId,
        nairobiDate(now),
      );
}

export interface RecurringBillsRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  readonly created: number;
  /** Items another run, or a settled bill, had already given a bill. */
  readonly alreadyThere: number;
  readonly failed: number;
}

interface OwedItem extends Record<string, unknown> {
  readonly recurring_item_id: string;
  readonly organization_id: string;
}

/**
 * The daily safety net (spec §6.20): gives every active item that has no
 * bill still owed its next bill, across companies. Each item is its own
 * transaction in its company's scope, so one failure doesn't stop the
 * rest. Safe to run any number of times, or in two places at once: the
 * unique index lets only one bill through. `now` is read when it runs.
 */
export function createOwedRecurringBills(
  now?: Date,
  maxRows = 200,
): Effect.Effect<RecurringBillsRun, DatabaseError, DatabaseService | AuditLog> {
  return Effect.gen(function* () {
    const today = nairobiDate(now ?? new Date());
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<OwedItem>(
          sql`SELECT recurring_item_id, organization_id FROM recurring_items_owed_a_bill(${maxRows})`,
        ),
      ),
    );

    let created = 0;
    let alreadyThere = 0;
    let failed = 0;
    for (const owed of rows) {
      const exit = yield* Effect.exit(
        withScope(
          { organizationId: owed.organization_id, role: "admin" },
          (tx) =>
            createNextRecurringBill(
              tx,
              owed.organization_id,
              owed.recurring_item_id,
              today,
            ),
        ),
      );
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[recurring-bills] item ${owed.recurring_item_id}: next bill failed`,
          Cause.pretty(exit.cause),
        );
      } else if (exit.value.kind === "created") {
        created += 1;
      } else if (exit.value.kind === "already_there") {
        alreadyThere += 1;
      }
    }
    return { today, created, alreadyThere, failed };
  });
}
