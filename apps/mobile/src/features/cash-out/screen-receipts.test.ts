import type { z } from "zod";
import { describe, expect, it } from "vitest";

import type { CashOutReceipt } from "@expendi-business/shared";
import {
  billDetailSchema,
  claimDetailSchema,
  floatDetailSchema,
  mySalaryPaymentsResponseSchema,
  payrollRunDetailSchema,
} from "@expendi-business/shared";

import { cashOutReceiptRows } from "./receipt-rows";

/**
 * Each screen reads `paymentReceipts` from a response parsed by its shared
 * schema; an API built before the field leaves it out.
 */

const ONE_MPESA: CashOutReceipt[] = [{ kind: "mpesa", code: "UKDCW299LW" }];
const ONE_BANK: CashOutReceipt[] = [{ kind: "bank", code: "FT26317XK9" }];
const SPLIT: CashOutReceipt[] = [
  { kind: "mpesa", code: "UKDCW299LW" },
  { kind: "mpesa", code: "UKDCW301MX" },
];

const AT = "2026-11-01T08:00:00.000Z";
const id = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const claim: z.input<typeof claimDetailSchema> = {
  id: id(1),
  status: "paid",
  merchant: "Java House",
  amountKes: "150000",
  spentOn: "2026-11-01",
  description: "Client lunch",
  category: { id: id(2), name: "Meals" },
  mpesaCode: "TJK4H7Q2LM",
  etimsInvoiceNumber: null,
  etimsSupplierPin: null,
  etimsQrPayload: null,
  etimsStatus: "none",
  rejectedReason: null,
  floatId: null,
  submittedBy: {
    membershipId: id(3),
    name: "Wanjiru",
    email: "wanjiru@example.com",
    payoutPhoneConfirmed: true,
  },
  approvedAt: AT,
  selfApproved: false,
  paidAt: AT,
  canEdit: false,
  warnings: [],
  receiptCount: 0,
  createdAt: AT,
  updatedAt: AT,
  receipts: [],
  payout: null,
};

const bill: z.input<typeof billDetailSchema> = {
  id: id(4),
  status: "paid",
  payee: {
    id: id(5),
    name: "Kenya Power",
    kind: "supplier",
    method: "mpesa_paybill",
    archived: false,
  },
  overviewHeading: "transactions",
  category: { id: id(6), name: "Utilities" },
  variable: false,
  currency: "kes",
  amountKes: "1500050",
  amountUsdc: null,
  reference: "INV-1",
  notes: null,
  dueOn: "2026-11-10",
  recurringItemId: null,
  payrollRunId: null,
  adjustmentReason: null,
  paidOn: "2026-11-09",
  paidAt: AT,
  markedPaidBy: null,
  paidOutsideNote: null,
  cancelledReason: null,
  cancelledAt: null,
  cancelledBy: null,
  payoutId: id(7),
  fileCount: 0,
  createdAt: AT,
  updatedAt: AT,
  files: [],
  payout: null,
};

const payrollPayment: z.input<
  typeof payrollRunDetailSchema
>["payments"][number] = {
  billId: id(8),
  kind: "salary",
  salaryId: id(9),
  payee: {
    id: id(10),
    name: "Otieno",
    kind: "employee",
    method: "mpesa_phone",
    archived: false,
    payoutPhoneConfirmed: true,
    accountEnding: null,
  },
  category: { id: id(11), name: "Salaries" },
  amountKes: "8000000",
  status: "paid",
  adjustmentReason: null,
  note: null,
  leftOut: null,
  paidOn: "2026-11-25",
};

const payrollRun = (
  payment: z.input<typeof payrollRunDetailSchema>["payments"][number],
): z.input<typeof payrollRunDetailSchema> => ({
  id: id(12),
  payDate: "2026-11-25",
  status: "paid",
  totalKes: "8000000",
  salariesKes: "8000000",
  capKes: "8800000",
  people: 1,
  leftOut: 0,
  adjusted: 0,
  oneOffs: 0,
  progress: { paid: 1, paying: 0, failed: 0 },
  createdAt: AT,
  approvedAt: AT,
  payments: [payment],
});

const salaryPayment: z.input<typeof mySalaryPaymentsResponseSchema>[number] = {
  id: id(13),
  kind: "salary",
  payDate: "2026-11-25",
  amountKes: "8000000",
  status: "paid",
  paidOn: "2026-11-25",
};

const floatMovement: z.input<typeof floatDetailSchema>["movements"][number] = {
  id: id(14),
  type: "issue",
  status: "paid",
  phase: "paid",
  amountKes: "500000",
  note: null,
  recordedBy: "Ann Admin",
  createdAt: AT,
  paidAt: AT,
  payout: null,
};

const float = (
  movement: z.input<typeof floatDetailSchema>["movements"][number],
): z.input<typeof floatDetailSchema> => ({
  id: id(15),
  status: "open",
  holder: { membershipId: id(16), name: "Kamau", email: "kamau@example.com" },
  yours: false,
  openedAt: AT,
  closedAt: null,
  issuedKes: "500000",
  spentKes: "0",
  returnedKes: "0",
  writtenOffKes: "0",
  leftKes: "500000",
  onTheWayKes: "0",
  awaitingApprovalKes: "0",
  spendingCount: 0,
  noReceiptCount: 0,
  movements: [movement],
  spending: [],
  overspendClaims: [],
});

/** An older API sends no `paymentReceipts` key at all. */
const withReceipts = (
  receipts: CashOutReceipt[] | undefined,
): { paymentReceipts?: CashOutReceipt[] } =>
  receipts ? { paymentReceipts: receipts } : {};

/** The receipts each screen shows, read the way the screen reads them. */
const SCREENS: readonly {
  readonly screen: string;
  readonly rowsFor: (
    receipts: CashOutReceipt[] | undefined,
  ) => ReturnType<typeof cashOutReceiptRows>;
}[] = [
  {
    screen: "claim detail",
    rowsFor: (receipts) =>
      cashOutReceiptRows(
        claimDetailSchema.parse({ ...claim, ...withReceipts(receipts) })
          .paymentReceipts,
      ),
  },
  {
    screen: "bill detail",
    rowsFor: (receipts) =>
      cashOutReceiptRows(
        billDetailSchema.parse({ ...bill, ...withReceipts(receipts) })
          .paymentReceipts,
      ),
  },
  {
    screen: "payroll run, per person",
    rowsFor: (receipts) => {
      const run = payrollRunDetailSchema.parse(
        payrollRun({ ...payrollPayment, ...withReceipts(receipts) }),
      );
      return cashOutReceiptRows(run.payments[0]?.paymentReceipts ?? []);
    },
  },
  {
    screen: "my salary payments",
    rowsFor: (receipts) => {
      const payments = mySalaryPaymentsResponseSchema.parse([
        { ...salaryPayment, ...withReceipts(receipts) },
      ]);
      return cashOutReceiptRows(payments[0]?.paymentReceipts ?? []);
    },
  },
  {
    screen: "petty cash float, money in and out",
    rowsFor: (receipts) => {
      const detail = floatDetailSchema.parse(
        float({ ...floatMovement, ...withReceipts(receipts) }),
      );
      return cashOutReceiptRows(detail.movements[0]?.paymentReceipts ?? []);
    },
  },
];

describe.each(SCREENS)("the $screen receipt row", ({ rowsFor }) => {
  it("shows one M-Pesa receipt", () => {
    // #when
    const rows = rowsFor(ONE_MPESA);

    // #then
    expect(rows).toEqual([{ label: "M-Pesa receipt", value: "UKDCW299LW" }]);
  });

  it("labels a bank transfer's code a bank reference", () => {
    // #when
    const rows = rowsFor(ONE_BANK);

    // #then
    expect(rows).toEqual([{ label: "Bank reference", value: "FT26317XK9" }]);
  });

  it("shows several receipts on one row, in order", () => {
    // #when
    const rows = rowsFor(SPLIT);

    // #then
    expect(rows).toEqual([
      { label: "M-Pesa receipts", value: "UKDCW299LW, UKDCW301MX" },
    ]);
  });

  it("has no row before a cash-out is paid", () => {
    // #when
    const rows = rowsFor([]);

    // #then
    expect(rows).toEqual([]);
  });

  it("has no row when an older API leaves the field out", () => {
    // #when
    const rows = rowsFor(undefined);

    // #then
    expect(rows).toEqual([]);
  });
});
