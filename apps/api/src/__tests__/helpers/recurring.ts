import { and, eq, inArray } from "drizzle-orm";

import { OUTSTANDING_BILL_STATUSES } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type {
  BillRow,
  NewRecurringItem,
  RecurringItemRow,
} from "../../db/schema/index.js";
import type { TestCompany } from "./db.js";
import { bills, recurringItems } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";

const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

/**
 * A recurring item written straight to the table, with no bill: what the
 * daily job is there to catch. By default monthly on the 15th, fixed at
 * KES 2,500, next due on 2026-03-15.
 */
export async function insertRecurringItem(
  db: Database,
  company: TestCompany,
  values: Partial<NewRecurringItem> &
    Pick<NewRecurringItem, "payeeId" | "categoryId">,
): Promise<string> {
  const [item] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(recurringItems)
      .values({
        organizationId: company.organizationId,
        overviewHeading: "transactions",
        amountKes: 250_000n,
        schedule: "monthly",
        scheduleDay: 15,
        startsOn: "2026-01-01",
        nextDueOn: "2026-03-15",
        ...values,
      })
      .returning({ id: recurringItems.id }),
  );
  if (!item) throw new Error("recurring item insert returned no row");
  return item.id;
}

export async function readRecurringItem(
  db: Database,
  company: TestCompany,
  itemId: string,
): Promise<RecurringItemRow> {
  const [item] = await runInScope(db, asAdmin(company), (tx) =>
    tx.select().from(recurringItems).where(eq(recurringItems.id, itemId)),
  );
  if (!item) throw new Error(`recurring item ${itemId} not found`);
  return item;
}

/** Every bill the item has created, by due date. */
export async function billsOfItem(
  db: Database,
  company: TestCompany,
  itemId: string,
): Promise<BillRow[]> {
  return runInScope(db, asAdmin(company), (tx) =>
    tx
      .select()
      .from(bills)
      .where(eq(bills.recurringItemId, itemId))
      .orderBy(bills.dueOn, bills.createdAt),
  );
}

/** The item's bills still owed: unpaid, or being paid. */
export async function outstandingBillsOfItem(
  db: Database,
  company: TestCompany,
  itemId: string,
): Promise<BillRow[]> {
  return runInScope(db, asAdmin(company), (tx) =>
    tx
      .select()
      .from(bills)
      .where(
        and(
          eq(bills.recurringItemId, itemId),
          inArray(bills.status, [...OUTSTANDING_BILL_STATUSES]),
        ),
      ),
  );
}
