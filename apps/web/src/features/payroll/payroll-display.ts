import type {
  CreateSalaryRequest,
  Payee,
  PayrollRun,
  PayrollRunStatus,
  Salary,
  UpdateSalaryRequest,
} from "@expendi-business/shared";
import {
  PAYROLL_DRAFT_LEAD_DAYS,
  SALARY_PAYEE_KINDS,
  SALARY_PAYEE_METHODS,
} from "@expendi-business/shared";

import type { Tone } from "~/features/payment-ui";
import { blankToNull, centsToTyped } from "~/features/bills/bill-draft";

/**
 * Copied from `apps/mobile/src/features/payroll/payroll-display.ts`: the
 * labels for salaries and runs, the cap, who can go on payroll, and the
 * salary form.
 */

export const RUN_STATUS_LABELS: Record<
  PayrollRunStatus,
  { label: string; tone: Tone }
> = {
  draft: { label: "Draft", tone: "warning" },
  paying: { label: "Being paid", tone: "neutral" },
  paid: { label: "Paid", tone: "success" },
  partly_failed: { label: "Some payments failed", tone: "danger" },
};

export const SALARY_STATE_LABELS: Record<
  Salary["state"],
  { label: string; tone: Tone }
> = {
  active: { label: "On payroll", tone: "success" },
  paused: { label: "Paused", tone: "warning" },
  ended: { label: "Ended", tone: "neutral" },
};

function ordinal(day: number): string {
  const tens = day % 100;
  if (tens >= 11 && tens <= 13) return `${String(day)}th`;
  return `${String(day)}${["th", "st", "nd", "rd"][day % 10] ?? "th"}`;
}

/** e.g. "The 31st of each month, or the month’s last day". */
export function payDayInWords(payDay: number): string {
  const lastDay = payDay > 28 ? ", or the month’s last day" : "";
  return `The ${ordinal(payDay)} of each month${lastDay}`;
}

export const DRAFT_TIMING = `Expendi drafts each payroll run ${String(PAYROLL_DRAFT_LEAD_DAYS)} days before pay day, with everyone on payroll. You can change it until it’s approved.`;

/** How far the run's total is under its cap, or over it, in KES cents. */
export function capRoom(run: Pick<PayrollRun, "totalKes" | "capKes">): {
  readonly overCap: boolean;
  readonly cents: string;
} {
  const room = BigInt(run.capKes) - BigInt(run.totalKes);
  return {
    overCap: room < 0n,
    cents: (room < 0n ? -room : room).toString(),
  };
}

const isSalaryKind = (kind: Payee["kind"]): boolean =>
  (SALARY_PAYEE_KINDS as readonly string[]).includes(kind);

export const canBePaidSalary = (payee: Payee): boolean =>
  payee.details !== null &&
  (SALARY_PAYEE_METHODS as readonly string[]).includes(payee.details.method);

/** Who can go on payroll: employees and other personnel who aren't archived. */
export function salaryPayees(payees: readonly Payee[]): Payee[] {
  return payees.filter((payee) => !payee.archived && isSalaryKind(payee.kind));
}

/** The salary form as typed; the API parses net pay into integer cents. */
export interface SalaryDraft {
  payeeId: string | null;
  amount: string;
  payDay: string;
  /** Blank starts today. */
  startsOn: string;
  categoryId: string | null;
}

export function blankSalaryDraft(today: string): SalaryDraft {
  return {
    payeeId: null,
    amount: "",
    payDay: "28",
    startsOn: today,
    categoryId: null,
  };
}

export function draftFromSalary(salary: Salary): SalaryDraft {
  return {
    payeeId: salary.payee.id,
    amount: centsToTyped(salary.amountKes),
    payDay: String(salary.payDay),
    startsOn: salary.startsOn,
    categoryId: salary.category.id,
  };
}

const wholeNumber = (typed: string): number =>
  /^\d+$/.test(typed.trim()) ? Number(typed.trim()) : Number.NaN;

export function toCreateSalaryRequest(draft: SalaryDraft): CreateSalaryRequest {
  return {
    payeeId: draft.payeeId ?? "",
    amountKes: draft.amount.trim(),
    payDay: wholeNumber(draft.payDay),
    startsOn: blankToNull(draft.startsOn)?.trim() ?? undefined,
    categoryId: draft.categoryId ?? "",
  };
}

/** Only what changed; net pay goes through its own passkey step. */
export function toUpdateSalaryRequest(
  salary: Salary,
  draft: SalaryDraft,
): UpdateSalaryRequest {
  const payDay = wholeNumber(draft.payDay);
  return {
    ...(payDay !== salary.payDay && { payDay }),
    ...(draft.categoryId !== null &&
      draft.categoryId !== salary.category.id && {
        categoryId: draft.categoryId,
      }),
  };
}
