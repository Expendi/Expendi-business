import { z } from "zod";

import { OVERVIEW_HEADINGS } from "./claims.js";
import { formatKesAmount } from "./kes-amount.js";
import { RECURRING_SCHEDULES } from "./recurring.js";

const units = z.string().regex(/^-?\d+$/);
export const overviewQuerySchema = z.object({
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .refine(
      (value) => value >= "1900-01" && value <= "9998-12",
      "Choose a month between 1900 and 9998.",
    )
    .optional(),
});
export const OVERVIEW_HEADING_LABELS = {
  petty_cash: "Petty cash",
  transactions: "Transactions",
  salaries: "Salaries & personnel",
  subscriptions: "Subscriptions",
} as const;
export const overviewPaymentSchema = z.object({
  id: z.string(),
  subjectId: z.string(),
  kind: z.enum(["claim", "bill", "company", "float"]),
  name: z.string(),
  date: z.string(),
  amountKes: units,
  heading: z.enum(OVERVIEW_HEADINGS),
  categoryId: z.string(),
  categoryName: z.string(),
  personId: z.string().nullable(),
  channel: z.enum(["expendi", "outside", "float"]),
});
export const cashObligationSchema = z.object({
  /**
   * The bill (`/bills?billId=`), the payroll run (`/payroll?runId=`), or
   * for a forecast the recurring payment or salary it will be billed from.
   */
  id: z.string(),
  kind: z.enum(["bill", "payroll", "forecast"]),
  name: z.string(),
  /** The bill's or recurring payment's note, e.g. "PAYE for October". */
  notes: z.string().nullable(),
  /** How often it repeats when it comes from a recurring payment or salary. */
  schedule: z.enum(RECURRING_SCHEDULES).nullable(),
  /** A payroll run's people still to pay; null for anything else. */
  people: z.number().int().nonnegative().nullable(),
  dueOn: z.string(),
  amountKes: units.nullable(),
  status: z.string(),
  payVia: z.enum(["expendi", "outside"]),
  needsAmount: z.boolean(),
  heading: z.enum(OVERVIEW_HEADINGS),
});
export const cashProjectionSchema = z.object({
  today: z.string(),
  through: z.string(),
  totalKes: units,
  unknownAmounts: z.number().int().nonnegative(),
  obligations: z.array(cashObligationSchema),
});
const breakdown = z.object({
  id: z.string(),
  name: z.string(),
  currentKes: units,
  previousKes: units,
});
const outstandingExpense = z.object({
  id: z.string(),
  name: z.string(),
  amountKes: units,
  floatId: z.string().nullable(),
  spentOn: z.string(),
  /** The claimant or float holder. */
  personName: z.string(),
  categoryName: z.string(),
  description: z.string().nullable(),
});
export const spendingOverviewSchema = z.object({
  month: z.string(),
  previousMonth: z.string(),
  currentKes: units,
  previousKes: units,
  headings: z.array(breakdown),
  categories: z.array(breakdown),
  recentPayments: z.array(overviewPaymentSchema),
  outstanding: z.object({
    overdue: z.array(cashObligationSchema),
    dueToday: z.array(cashObligationSchema),
    claims: z.array(outstandingExpense),
    noReceipt: z.array(outstandingExpense),
    /**
     * Petty cash spending with a receipt but no eTIMS invoice, in a
     * category that expects one.
     */
    noEtims: z.array(outstandingExpense),
  }),
  cash: cashProjectionSchema.extend({
    balanceUsdc: units,
    reservedUsdc: units,
    balanceKes: units.nullable(),
    availableKes: units.nullable(),
    rate: z.string().nullable(),
    status: z.enum(["covered", "short", "unknown"]),
    shortKes: units.nullable(),
    outsideKes: units,
  }),
  people: z.array(z.object({ id: z.string(), name: z.string() })),
});
export const overviewPersonSchema = z.object({
  id: z.string(),
  name: z.string(),
  salaries: z.array(
    z.object({
      id: z.string(),
      amountKes: units,
      active: z.boolean(),
      nextDueOn: z.string().nullable(),
    }),
  ),
  payments: z.array(overviewPaymentSchema),
  claims: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      amountKes: units,
      status: z.string(),
    }),
  ),
  floats: z.array(
    z.object({ id: z.string(), status: z.string(), leftKes: units }),
  ),
});
export type SpendingOverview = z.infer<typeof spendingOverviewSchema>;
export type OverviewPerson = z.infer<typeof overviewPersonSchema>;
export type OverviewPayment = z.infer<typeof overviewPaymentSchema>;
export type CashObligation = z.infer<typeof cashObligationSchema>;
export type CashProjection = z.infer<typeof cashProjectionSchema>;

/**
 * How the app and the web dashboard word the overview's figures (spec
 * §6.24), so both show the API's numbers the same way and neither adds
 * anything up itself.
 */

/** KES cents for people to read, e.g. "150050" → "KES 1,500.50". */
export function overviewKes(cents: string): string {
  const amount = BigInt(cents);
  return amount < 0n
    ? formatKesAmount(-amount).replace("KES ", "KES -")
    : formatKesAmount(amount);
}

export function cashHeadline(cash: SpendingOverview["cash"]): string {
  switch (cash.status) {
    case "covered":
      return "Covered";
    case "short":
      return `Short by ${overviewKes(cash.shortKes ?? "0")}`;
    case "unknown":
      return "Can't check without today's KES rate";
  }
}

export function cashFootnote(cash: SpendingOverview["cash"]): string {
  const unknown =
    cash.unknownAmounts === 0
      ? ""
      : ` Not counting ${String(cash.unknownAmounts)} ${cash.unknownAmounts === 1 ? "payment" : "payments"} with no amount yet.`;
  return `${overviewKes(cash.totalKes)} to pay through Expendi by ${cash.through}, overdue included.${unknown} Cash-out fees and bills paid outside Expendi aren't counted.`;
}

/** Null when nothing's due outside Expendi, so the line is left out. */
export function cashOutsideLine(cash: SpendingOverview["cash"]): string | null {
  return BigInt(cash.outsideKes) === 0n
    ? null
    : `Also due outside Expendi: ${overviewKes(cash.outsideKes)}`;
}

/** What an admin can do with a payment that's due; a forecast can only be viewed. */
export function obligationAction(row: CashObligation): string {
  if (row.kind === "forecast") return "View";
  if (row.needsAmount) return "Enter amount";
  return row.payVia === "outside" ? "Mark paid" : "Pay";
}

export function obligationAmount(row: CashObligation): string {
  if (row.amountKes !== null) return overviewKes(row.amountKes);
  return row.needsAmount ? "Amount not entered" : "Amount unknown";
}
