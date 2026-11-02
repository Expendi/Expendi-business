import { randomUUID } from "node:crypto";

import type { Database } from "../../db/client.js";
import type {
  Expense,
  NewExpense,
  NewPayout,
  Payout,
} from "../../db/schema/index.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { TestCompany, TestWallet } from "./db.js";
import type { PayrollPerson } from "./payroll.js";
import {
  expenses,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertPayee } from "./bills.js";
import { addCategory } from "./claims.js";
import { createActiveWallet, createCompany } from "./db.js";
import { addEmployeePayee } from "./payroll.js";

/** 2 Nov 2026, 11:00 in Nairobi. */
export const OVERVIEW_NOW = new Date("2026-11-02T08:00:00Z");
export const OVERVIEW_TODAY = "2026-11-02";

export interface OverviewCompany {
  readonly company: TestCompany;
  readonly wallet: TestWallet;
  readonly tenant: Tenant;
  readonly categoryId: string;
  readonly supplierId: string;
  readonly employee: PayrollPerson;
  readonly insertExpense: (values?: Partial<NewExpense>) => Promise<Expense>;
  /** A payout, paid on `OVERVIEW_NOW` unless told otherwise. */
  readonly insertPayout: (
    values: Partial<NewPayout> & Pick<NewPayout, "subjectType" | "subjectId">,
  ) => Promise<Payout>;
  readonly deposit: (usdc: bigint) => Promise<void>;
}

/**
 * A company with an active wallet, one category, a supplier and an
 * employee on payroll. Rows are written straight to the tables, in states
 * the flows that make them have already been tested to reach.
 */
export async function seedOverviewCompany(
  db: Database,
): Promise<OverviewCompany> {
  const company = await createCompany(db);
  const wallet = await createActiveWallet(db, company);
  const categoryId = await addCategory(db, company, "Office");
  const employee = await addEmployeePayee(db, company, "Amina");
  const supplierId = await insertPayee(db, company, { name: "Supplier" });
  const tenant: Tenant = {
    organizationId: company.organizationId,
    userId: company.admin.id,
    membershipId: company.adminMembershipId,
    role: "admin",
  };

  const insertExpense = async (values: Partial<NewExpense> = {}) => {
    const [row] = await runInScope(db, tenant, (tx) =>
      tx
        .insert(expenses)
        .values({
          organizationId: company.organizationId,
          membershipId: employee.membershipId,
          categoryId,
          kind: "company",
          overviewHeading: "transactions",
          merchant: "Office supplies",
          amountKes: 1_000n,
          spentOn: OVERVIEW_TODAY,
          status: "recorded",
          ...values,
        })
        .returning(),
    );
    if (!row) throw new Error("expense insert returned no row");
    return row;
  };

  const insertPayout = async (
    values: Partial<NewPayout> & Pick<NewPayout, "subjectType" | "subjectId">,
  ) => {
    const amountKes = values.amountKes ?? 1_000n;
    const [row] = await runInScope(db, tenant, (tx) =>
      tx
        .insert(payouts)
        .values({
          organizationId: company.organizationId,
          walletId: wallet.id,
          idempotencyKey: randomUUID(),
          method: "mpesa_phone",
          recipient: {
            method: "mpesa_phone",
            phone: "+254712345678",
            accountName: "Amina",
          },
          requestedKesCents: amountKes,
          amountKes,
          quotedRate: "128.68",
          quotedUsdc: 100_000n,
          maxDebitUsdc: 100_000n,
          status: "paid",
          paidAt: OVERVIEW_NOW,
          approvalId: randomUUID(),
          approvedBy: company.admin.id,
          approvedAt: OVERVIEW_NOW,
          amountToTransferUsdc: 100_000n,
          depositAddress: `0x${"1".repeat(40)}`,
          fundingStartedAt: OVERVIEW_NOW,
          providerOrderId: randomUUID(),
          ...values,
        })
        .returning(),
    );
    if (!row) throw new Error("payout insert returned no row");
    return row;
  };

  const deposit = async (usdc: bigint) => {
    await runInScope(db, tenant, (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: company.organizationId,
        walletId: wallet.id,
        type: "deposit",
        usdcAmount: usdc,
        txHash: `0x${randomUUID().replaceAll("-", "").padEnd(64, "0")}`,
        logIndex: 0,
        blockNumber: 1n,
      }),
    );
  };

  return {
    company,
    wallet,
    tenant,
    categoryId,
    supplierId,
    employee,
    insertExpense,
    insertPayout,
    deposit,
  };
}
