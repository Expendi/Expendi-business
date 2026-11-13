import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import { OUTSTANDING_BILL_STATUSES } from "@expendi-business/shared";

import { bills, recurringItems } from "../../db/schema/index.js";

/**
 * When a recurring payment stops being paid by its company-held card
 * (spec §6.20, §6.25). The one rule every card path asks.
 *
 * A null `next_due_on` alone doesn't say it: `createNextRecurringBill` sets
 * it to null as it creates the last bill of a schedule with an end date,
 * and that bill is still owed. Until it's paid (by any means) or cancelled,
 * the card keeps paying it: its merchant is approved, the card can't close,
 * and the card still lists the payment. Pausing (`active = false`) or
 * switching away from card is a separate question each caller asks.
 */

export interface CardPaidItemColumns {
  readonly id: AnyPgColumn;
  readonly nextDueOn: AnyPgColumn;
}

const OPEN_BILL = "card_paid_open_bill";
const openBill = alias(bills, OPEN_BILL);

/**
 * True when the recurring payment whose columns are given has ended for
 * its card. A correlated `NOT EXISTS` on the one-outstanding-bill index, so
 * it costs no extra round trip in a `WHERE`, a join or a select list. Pass
 * an aliased table's columns when the query aliases `recurring_items`.
 */
export function hasEndedForCardsSql(
  item: CardPaidItemColumns = recurringItems,
): SQL<boolean> {
  return sql<boolean>`(${isNull(item.nextDueOn)} AND NOT EXISTS (SELECT 1 FROM ${bills} AS ${sql.identifier(OPEN_BILL)} WHERE ${and(
    eq(openBill.recurringItemId, item.id),
    // Lets Postgres use `bills_recurring_item_outstanding_unique`; salaries
    // are never paid by card.
    isNull(openBill.payrollRunId),
    inArray(openBill.status, [...OUTSTANDING_BILL_STATUSES]),
  )}))`;
}

/** The negation, for "still paid by its card" filters. */
export function hasNotEndedForCardsSql(
  item: CardPaidItemColumns = recurringItems,
): SQL<boolean> {
  return sql<boolean>`NOT ${hasEndedForCardsSql(item)}`;
}
