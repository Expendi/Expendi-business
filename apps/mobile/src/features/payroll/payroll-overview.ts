import type {
  MySalaryPayment,
  PayeeMethod,
  PayrollRun,
  Salary,
} from "@expendi-business/shared";

import { formatShortDate } from "../claims/dates";
import { formatKesCents } from "../../lib/money";
import { MY_PAYMENT_STATUS_LABELS, RUN_STATUS_LABELS } from "./payroll-display";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** `2026-10-28` → `October`; anything else is shown as it is. */
export function monthName(isoDate: string): string {
  const month = /^\d{4}-(\d{2})-\d{2}$/.exec(isoDate)?.[1];
  const name = month ? MONTH_NAMES[Number(month) - 1] : undefined;
  return name ?? isoDate;
}

/** The run to act on next: the earliest one that isn't paid yet. */
export function nextRun(runs: readonly PayrollRun[]): PayrollRun | null {
  const open = runs.filter((run) => run.status !== "paid");
  return (
    open.reduce<PayrollRun | null>(
      (earliest, run) =>
        earliest === null || run.payDate < earliest.payDate ? run : earliest,
      null,
    ) ?? null
  );
}

/** Every run except the next one, latest pay day first. */
export function pastRuns(runs: readonly PayrollRun[]): PayrollRun[] {
  const next = nextRun(runs);
  return runs
    .filter((run) => run.id !== next?.id)
    .sort((a, b) => b.payDate.localeCompare(a.payDate));
}

export const activeSalaries = (salaries: readonly Salary[]): Salary[] =>
  salaries.filter((salary) => salary.state === "active");

/** The soonest pay day among salaries still being paid; null when there is none. */
export function nextPayDay(salaries: readonly Salary[]): string | null {
  const days = activeSalaries(salaries)
    .map((salary) => salary.nextPayDate)
    .filter((day) => day !== null)
    .sort();
  return days[0] ?? null;
}

const PAYOUT_LABELS: Record<PayeeMethod, string> = {
  mpesa_phone: "M-PESA",
  mpesa_till: "M-PESA Till",
  mpesa_paybill: "M-PESA Paybill",
  bank: "Bank transfer",
  usdc: "USDC",
  outside: "Paid outside Expendi",
};

/** How a salary is paid out; says so when the payee has no payment details yet. */
export function payoutLabel(method: PayeeMethod | null): string {
  return method === null ? "No payment details yet" : PAYOUT_LABELS[method];
}

export interface RunRowData {
  title: string;
  meta: string;
  metaTone: "default" | "negative" | "positive";
  tone: "positive" | "neutral" | "negative";
}

/** A run in "Past runs": the month it paid for, and where it stands. */
export function runRowData(run: PayrollRun, today: string): RunRowData {
  const date = formatShortDate(run.payDate, today);
  switch (run.status) {
    case "paid":
      return {
        title: monthName(run.payDate),
        meta: `Paid ${date}`,
        metaTone: "positive",
        tone: "positive",
      };
    case "partly_failed":
      return {
        title: monthName(run.payDate),
        meta: `${RUN_STATUS_LABELS[run.status].label} · ${date}`,
        metaTone: "negative",
        tone: "negative",
      };
    default:
      return {
        title: monthName(run.payDate),
        meta: `${RUN_STATUS_LABELS[run.status].label} · pay day ${date}`,
        metaTone: "default",
        tone: "neutral",
      };
  }
}

export interface PaymentRowData {
  title: string;
  meta: string;
  metaTone: "default" | "positive";
  amount: string;
  paid: boolean;
}

/** One of the signed-in person's salary payments, in words. */
export function paymentRowData(
  payment: MySalaryPayment,
  today: string,
): PaymentRowData {
  const status = MY_PAYMENT_STATUS_LABELS[payment.status].label;
  const paid = payment.status === "paid";
  const date = formatShortDate(
    paid ? (payment.paidOn ?? payment.payDate) : payment.payDate,
    today,
  );
  return {
    title: payment.kind === "one_off" ? "Extra payment" : "Salary",
    meta: paid ? `${status} · ${date}` : `${status} · pay day ${date}`,
    metaTone: paid ? "positive" : "default",
    amount: formatKesCents(payment.amountKes),
    paid,
  };
}
