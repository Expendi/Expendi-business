import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { Database } from "../../db/client.js";
import type {
  BillRow,
  NewBill,
  NewPayee,
  NewPayout,
} from "../../db/schema/index.js";
import type { TestCompany } from "./db.js";
import {
  bills,
  payees,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
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

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

const randomBase58 = (): string =>
  Array.from(
    randomBytes(44),
    (byte) => BASE58[byte % BASE58.length] ?? "1",
  ).join("");

/**
 * A bill paid through Expendi: a payout of it (M-Pesa Till, paid, unless
 * `values` say otherwise), the bill pointing at it, and the ledger's debit
 * for it on NEAR unless `recordDebit` is off.
 */
export async function insertBillPayment(
  db: Database,
  company: TestCompany,
  walletId: string,
  billId: string,
  values: Partial<NewPayout> = {},
  { recordDebit = true }: { recordDebit?: boolean } = {},
): Promise<string> {
  return runInScope(db, asAdmin(company), async (tx) => {
    const [payout] = await tx
      .insert(payouts)
      .values({
        organizationId: company.organizationId,
        walletId,
        subjectType: "bill",
        subjectId: billId,
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
        rate: "128.68",
        status: "paid",
        provider: "pretium",
        approvedBy: company.admin.id,
        approvalId: randomUUID(),
        approvedAt: new Date("2026-11-13T04:30:00Z"),
        amountToTransferUsdc: 19_430_000n,
        depositAddress: "pretium-settlement.near",
        fundingStartedAt: new Date("2026-11-13T04:30:30Z"),
        paidAt: new Date("2026-11-13T04:31:00Z"),
        providerReference: "UKDCW299LW",
        ...values,
      })
      .returning({ id: payouts.id });
    if (!payout) throw new Error("payout insert returned no row");
    const paid = (values.status ?? "paid") === "paid";
    await tx
      .update(bills)
      .set({
        payoutId: payout.id,
        ...(paid
          ? {
              status: "paid" as const,
              paidOn: "2026-11-13",
              paidAt: new Date("2026-11-13T04:31:00Z"),
            }
          : { status: "paying" as const }),
      })
      .where(eq(bills.id, billId));
    if (!recordDebit) return payout.id;
    await tx.insert(walletTransactions).values({
      organizationId: company.organizationId,
      walletId,
      type: "payout",
      chain: "near",
      usdcAmount: -19_430_000n,
      txHash: "6mKzv7RfQ9cYw2PqL8nXbT3jDe4HsUa1VgCoNiEp5MtY",
      receiptId: randomBase58(),
      logIndex: 0,
      transferIndex: 0,
      blockNumber: 150_000_000n,
      payoutId: payout.id,
    });
    return payout.id;
  });
}
