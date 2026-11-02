import { PAYROLL_DRAFT_LEAD_DAYS } from "@expendi-business/shared";

const DAY_MS = 86_400_000;

/** The Nairobi day a pay date's run is drafted: 5 days before it (spec §6.21). */
export function draftDateFor(payDate: string): string {
  const [year = 0, month = 1, day = 1] = payDate.split("-").map(Number);
  return new Date(
    Date.UTC(year, month - 1, day) - PAYROLL_DRAFT_LEAD_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
}
