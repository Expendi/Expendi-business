const NAIROBI_DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/**
 * An API timestamp (ISO 8601, UTC) as Nairobi wall-clock time, e.g.
 * `2026-11-01T21:30:00Z` → `2 Nov 2026, 00:30`. Companies work in Nairobi
 * time whatever the viewer's browser is set to.
 */
export function formatNairobiDateTime(isoDateTime: string): string {
  const at = new Date(isoDateTime);
  return Number.isNaN(at.getTime())
    ? isoDateTime
    : NAIROBI_DATE_TIME.format(at);
}
