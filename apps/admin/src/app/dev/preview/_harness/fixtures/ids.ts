/** A stable sample UUID: `sampleId(7)` → "00000000-0000-4000-8000-000000000007". */
export function sampleId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** The sample data assumes it is this moment, in Nairobi 11:30 on 11 Nov 2026. */
export const NOW = "2026-11-11T08:30:00.000Z";

/** An ISO time `minutes` before the sample "now". */
export function minutesAgo(minutes: number): string {
  return new Date(Date.parse(NOW) - minutes * 60_000).toISOString();
}

export const STAFF = {
  email: "amina.hassan@expendi.app",
  role: "ops_admin",
} as const;

export const VIEWER_STAFF = {
  email: "peter.otieno@expendi.app",
  role: "ops_viewer",
} as const;
