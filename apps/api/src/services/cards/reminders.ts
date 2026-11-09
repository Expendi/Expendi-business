import { and, eq, lt, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { cardPurchases, expenses } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { notify } from "../notification/notify.js";
import {
  alreadyQueued,
  nairobiHour,
  REMINDER_HOUR,
} from "../notification/reminders.js";
import { needsReceiptSql } from "./purchases.js";
import { companyScope } from "./transactions.js";

/**
 * Reminds a cardholder, once a Nairobi day from the morning on, about any
 * purchase still missing its receipt a day after it was made. The card is
 * never frozen for a missing receipt, so the reminder is the only nudge.
 */

const OVERDUE_MS = 24 * 60 * 60 * 1000;

function queueReminders(
  tx: Transaction,
  organizationId: string,
  at: Date,
  today: string,
): Effect.Effect<number, DatabaseError> {
  return Effect.gen(function* () {
    const overdue = yield* query(() =>
      tx
        .select({ id: cardPurchases.id })
        .from(cardPurchases)
        .leftJoin(expenses, eq(expenses.id, cardPurchases.expenseId))
        .where(
          and(
            eq(cardPurchases.organizationId, organizationId),
            lt(cardPurchases.authorizedAt, new Date(at.getTime() - OVERDUE_MS)),
            needsReceiptSql,
          ),
        ),
    );
    const owed = overdue.map(({ id }) => ({
      id,
      key: `card_receipt_reminder:${id}:${today}`,
    }));
    const queued = yield* alreadyQueued(
      tx,
      organizationId,
      owed.map(({ key }) => key),
    );
    const due = owed.filter(({ key }) => !queued.has(key));
    for (const { id: purchaseId } of due) {
      yield* notify(tx, {
        kind: "card_receipt_reminder",
        organizationId,
        purchaseId,
        today,
      });
    }
    return due.length;
  });
}

export interface CardReceiptRemindersRun {
  readonly today: string;
  readonly companies: number;
  readonly reminded: number;
  readonly failed: number;
}

/** Null before `REMINDER_HOUR` in Nairobi. */
export function runCardReceiptReminders(
  now?: Date,
): Effect.Effect<
  CardReceiptRemindersRun | null,
  DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const at = now ?? new Date();
    if (nairobiHour(at) < REMINDER_HOUR) return null;
    const today = nairobiDate(at);
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<{ organization_id: string }>(
          sql`SELECT organization_id FROM card_reminder_companies()`,
        ),
      ),
    );
    let reminded = 0;
    let failed = 0;
    for (const { organization_id: organizationId } of rows) {
      const exit = yield* Effect.exit(
        withScope(companyScope(organizationId), (tx) =>
          queueReminders(tx, organizationId, at, today),
        ),
      );
      if (Exit.isSuccess(exit)) {
        reminded += exit.value;
      } else {
        failed += 1;
        console.error(
          `[card-reminders] company ${organizationId} failed`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { today, companies: rows.length, reminded, failed };
  });
}
