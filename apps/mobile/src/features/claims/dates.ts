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

/** The phone's calendar day as `YYYY-MM-DD`, the format claims store. */
export function localIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `2026-10-15` → `15 Oct 2026`; anything else is shown as it is. */
export function formatIsoDate(isoDate: string): string {
  const match = ISO_DATE.exec(isoDate);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  if (!match || !month) return isoDate;
  return `${Number(match[3])} ${month} ${match[1]}`;
}
