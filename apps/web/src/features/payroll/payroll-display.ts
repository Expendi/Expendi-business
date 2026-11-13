import type {
  BillStatus,
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

import type { SortState } from "~/components/data/data-table";
import type { StatusTone } from "~/components/data/status-badge";
import { blankToNull, centsToTyped } from "~/features/bills/bill-draft";
import { METHOD_LABELS } from "~/features/payees/payee-display";

/**
 * Copied from `apps/mobile/src/features/payroll/payroll-display.ts`, with
 * the dashboard's tones and table order (docs/mocks/payroll.html): the
 * labels for salaries and runs, the cap, who can go on payroll, and the
 * salary form.
 */

interface Badge {
  readonly label: string;
  readonly tone: StatusTone;
}

export const RUN_STATUS_LABELS: Record<PayrollRunStatus, Badge> = {
  draft: { label: "Draft", tone: "waiting" },
  paying: { label: "Being paid", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  partly_failed: { label: "Some payments failed", tone: "failed" },
};

export const SALARY_STATE_LABELS: Record<Salary["state"], Badge> = {
  active: { label: "On payroll", tone: "quiet" },
  paused: { label: "Paused", tone: "waiting" },
  ended: { label: "Ended", tone: "rejected" },
};

/** One person's payment in a run; a left-out one is cancelled underneath. */
const PAYMENT_STATUS_LABELS: Record<BillStatus, Badge> = {
  upcoming: { label: "Upcoming", tone: "quiet" },
  due: { label: "Due today", tone: "waiting" },
  overdue: { label: "Overdue", tone: "overdue" },
  paying: { label: "Being paid", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  payout_failed: { label: "Payment failed", tone: "failed" },
  paid_outside: { label: "Paid outside Expendi", tone: "paid" },
  paid_by_card: { label: "Paid by card", tone: "paid" },
  cancelled: { label: "Cancelled", tone: "rejected" },
};

export function paymentStatusBadge(
  status: BillStatus,
  leftOut: boolean,
): Badge {
  return leftOut
    ? { label: "Left out", tone: "rejected" }
    : PAYMENT_STATUS_LABELS[status];
}

/** Where a run's money shows on the overview (spec §5). */
export const OVERVIEW_HEADING = "Salaries & personnel";

export const UNCONFIRMED_NUMBER = "Hasn’t confirmed their M-Pesa number yet.";

export const ZOHO_NOTE =
  "In Zoho Books, this run is one expense for its total, with no names.";

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

type PaidByPayee = Pick<Salary["payee"], "kind" | "method" | "accountEnding">;

/**
 * "Bank account ending 0915". An employee's own M-Pesa number is never
 * shown, not even its ending, so it reads "M-Pesa number" alone.
 */
export function paidByInWords(payee: PaidByPayee): string {
  if (payee.method === null) return "No payment details yet";
  const label = METHOD_LABELS[payee.method];
  const ownNumber = payee.kind === "employee" && payee.method === "mpesa_phone";
  return payee.accountEnding === null || ownNumber
    ? label
    : `${label} ending ${payee.accountEnding}`;
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

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Today's calendar day in Nairobi, as the API dates runs and salaries. */
export function nairobiToday(now: Date = new Date()): string {
  return NAIROBI_DAY.format(now);
}

const DAY_MS = 86_400_000;

const dayNumber = (isoDate: string): number =>
  Math.round(Date.parse(`${isoDate}T00:00:00Z`) / DAY_MS);

/** `isoDate` moved by `days`, e.g. the day a salary's run is drafted. */
export function addDays(isoDate: string, days: number): string {
  return new Date((dayNumber(isoDate) + days) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

/** "In 4 days", "Today" or "2 days late", for a draft run's pay day. */
export function payDayHint(payDate: string, today: string): string {
  const days = dayNumber(payDate) - dayNumber(today);
  const count = (n: number) => `${String(n)} ${n === 1 ? "day" : "days"}`;
  if (days < 0) return `${count(-days)} late`;
  if (days === 0) return "Today";
  return `In ${count(days)}`;
}

/** "4 people, 1 left out · In 4 days": a run row's second line. */
export function runMeta(run: PayrollRun, today: string): string {
  const people = `${String(run.people)} ${run.people === 1 ? "person" : "people"}`;
  const leftOut = run.leftOut > 0 ? `, ${String(run.leftOut)} left out` : "";
  const hint =
    run.status === "draft" ? ` · ${payDayHint(run.payDate, today)}` : "";
  return `${people}${leftOut}${hint}`;
}

/** Draft runs to review, then runs with a failed payment, latest first. */
export function waitingRuns(runs: readonly PayrollRun[]): PayrollRun[] {
  const rank = (run: PayrollRun) => (run.status === "draft" ? 0 : 1);
  return runs
    .filter((run) => run.status === "draft" || run.status === "partly_failed")
    .sort((a, b) => rank(a) - rank(b) || b.payDate.localeCompare(a.payDate));
}

export type RunSortKey = "payDate" | "total" | "status";
export type SalarySortKey = "person" | "next" | "amount" | "status";

export const RUN_SORT_FIRST: Record<RunSortKey, "asc" | "desc"> = {
  payDate: "desc",
  total: "desc",
  status: "asc",
};

export const SALARY_SORT_FIRST: Record<SalarySortKey, "asc" | "desc"> = {
  person: "asc",
  next: "asc",
  amount: "desc",
  status: "asc",
};

export const DEFAULT_RUN_SORT: SortState<RunSortKey> = {
  key: "payDate",
  dir: "desc",
};

export const DEFAULT_SALARY_SORT: SortState<SalarySortKey> = {
  key: "person",
  dir: "asc",
};

const RUN_URGENCY: Record<PayrollRunStatus, number> = {
  draft: 0,
  partly_failed: 1,
  paying: 2,
  paid: 3,
};

const SALARY_ORDER: Record<Salary["state"], number> = {
  active: 0,
  paused: 1,
  ended: 2,
};

const compareCents = (a: string, b: string): number => {
  const diff = BigInt(a) - BigInt(b);
  return diff === 0n ? 0 : diff < 0n ? -1 : 1;
};

/** One flat list: latest pay day first unless a header says otherwise. */
export function sortRuns(
  runs: readonly PayrollRun[],
  sort: SortState<RunSortKey>,
): PayrollRun[] {
  return [...runs].sort((a, b) => {
    const byDate = a.payDate.localeCompare(b.payDate);
    const primary =
      sort.key === "payDate"
        ? byDate
        : sort.key === "total"
          ? compareCents(a.totalKes, b.totalKes)
          : RUN_URGENCY[a.status] - RUN_URGENCY[b.status];
    return (
      (sort.dir === "asc" ? primary : -primary) ||
      -byDate ||
      a.id.localeCompare(b.id)
    );
  });
}

/** A to Z with ended salaries last, unless a header says otherwise. */
export function sortSalaries(
  salaries: readonly Salary[],
  sort: SortState<SalarySortKey>,
): Salary[] {
  return [...salaries].sort((a, b) => {
    const byName = a.payee.name.localeCompare(b.payee.name);
    if (sort.key === "person") {
      const ended = Number(a.state === "ended") - Number(b.state === "ended");
      return ended || (sort.dir === "asc" ? byName : -byName);
    }
    const primary =
      sort.key === "next"
        ? (a.nextPayDate ?? "9999").localeCompare(b.nextPayDate ?? "9999")
        : sort.key === "amount"
          ? compareCents(a.amountKes, b.amountKes)
          : SALARY_ORDER[a.state] - SALARY_ORDER[b.state];
    return (sort.dir === "asc" ? primary : -primary) || byName;
  });
}
