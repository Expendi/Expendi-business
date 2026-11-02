const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `2026-10-15` → `15 Oct 2026`; anything else is shown as it is. Dates are
 * calendar days in Nairobi already, so no time zone is applied.
 */
export function formatIsoDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return isoDate;
  return `${Number(match[3])} ${month} ${match[1]}`;
}

const nairobiDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** A moment, e.g. when a claim was paid, as its calendar day in Nairobi. */
export function formatNairobiDate(iso: string): string {
  return formatIsoDate(nairobiDate.format(new Date(iso)));
}
