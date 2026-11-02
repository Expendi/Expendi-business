import { sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatedBillStatus } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import { query, withScope } from "../../db/scope.js";

const NAIROBI_DAY = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** The calendar day in Kenya at `at`, as `YYYY-MM-DD`. Bill dates are Kenyan days (spec §6.24). */
export function nairobiDate(at: Date): string {
  const parts = Object.fromEntries(
    NAIROBI_DAY.formatToParts(at).map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** Where an unpaid bill stands on `today` (spec §6.20). Both are `YYYY-MM-DD`. */
export function scheduledStatus(dueOn: string, today: string): DatedBillStatus {
  if (dueOn > today) return "upcoming";
  return dueOn === today ? "due" : "overdue";
}

export interface BillStatusRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  /** Bills that became due today. */
  readonly due: number;
  readonly overdue: number;
}

/**
 * Moves every company's bills forward by date: `upcoming` to `due` on the
 * due date, and on to `overdue` after it, by Nairobi time. Safe to run any
 * number of times; it never moves a bill back, and never touches a bill
 * being paid, paid, failed, paid outside or cancelled (see
 * `advance_bill_statuses`). `now` is read when the effect runs.
 */
export function advanceBillStatuses(
  now?: Date,
): Effect.Effect<BillStatusRun, DatabaseError, DatabaseService> {
  return Effect.suspend(() => {
    const today = nairobiDate(now ?? new Date());
    return withScope({}, (tx) =>
      query(() =>
        tx.execute<{ status: DatedBillStatus }>(
          sql`SELECT status FROM advance_bill_statuses(${today}::date)`,
        ),
      ),
    ).pipe(
      Effect.map(({ rows }) => ({
        today,
        due: rows.filter((row) => row.status === "due").length,
        overdue: rows.filter((row) => row.status === "overdue").length,
      })),
    );
  });
}
