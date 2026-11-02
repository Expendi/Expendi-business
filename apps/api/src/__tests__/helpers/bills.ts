import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type { BillRow, NewBill, NewPayee } from "../../db/schema/index.js";
import type { TestCompany } from "./db.js";
import { bills, payees, payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";

const asAdmin = (company: TestCompany) => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

/** `YYYY-MM-DD` moved by whole days, in calendar arithmetic only. */
export function shiftDays(isoDate: string, days: number): string {
  const [year = 0, month = 1, day = 1] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
}

/** A payee written straight to the table; by default a supplier with no payment details yet. */
export async function insertPayee(
  db: Database,
  company: TestCompany,
  values: Partial<NewPayee> = {},
): Promise<string> {
  const [payee] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(payees)
      .values({
        organizationId: company.organizationId,
        kind: "supplier",
        name: `Supplier ${randomUUID().slice(0, 8)}`,
        ...values,
      })
      .returning({ id: payees.id }),
  );
  if (!payee) throw new Error("payee insert returned no row");
  return payee.id;
}

/** A bill written straight to the table, e.g. in a state the API can't reach yet. */
export async function insertBill(
  db: Database,
  company: TestCompany,
  values: Partial<NewBill> & Pick<NewBill, "payeeId" | "categoryId">,
): Promise<string> {
  const [bill] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(bills)
      .values({
        organizationId: company.organizationId,
        overviewHeading: "transactions",
        amountKes: 250_000n,
        dueOn: "2026-03-15",
        status: "upcoming",
        ...values,
      })
      .returning({ id: bills.id }),
  );
  if (!bill) throw new Error("bill insert returned no row");
  return bill.id;
}

export async function readBill(
  db: Database,
  company: TestCompany,
  billId: string,
): Promise<BillRow> {
  const [bill] = await runInScope(db, asAdmin(company), (tx) =>
    tx.select().from(bills).where(eq(bills.id, billId)),
  );
  if (!bill) throw new Error(`bill ${billId} not found`);
  return bill;
}

/** A failed payout of a bill, for bills that were paid, or tried, through Expendi. */
export async function insertBillPayout(
  db: Database,
  company: TestCompany,
  walletId: string,
): Promise<string> {
  const [payout] = await runInScope(db, asAdmin(company), (tx) =>
    tx
      .insert(payouts)
      .values({
        organizationId: company.organizationId,
        walletId,
        subjectType: "bill",
        subjectId: randomUUID(),
        idempotencyKey: `bill:${randomUUID()}:1`,
        method: "mpesa_till",
        recipient: {
          method: "mpesa_till",
          tillNumber: "123456",
          accountName: "Kenya Power",
        },
        requestedKesCents: 250_000n,
        amountKes: 250_000n,
        quotedRate: "129.00",
        quotedUsdc: 19_380_000n,
        maxDebitUsdc: 19_500_000n,
        status: "failed",
      })
      .returning({ id: payouts.id }),
  );
  if (!payout) throw new Error("payout insert returned no row");
  return payout.id;
}
