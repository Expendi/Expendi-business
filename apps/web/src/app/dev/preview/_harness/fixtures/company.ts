/**
 * The mocks' company (docs/mocks/*.html): Mwangaza Logistics, seen by its
 * admin Wanjiru Kamau. The sample dates assume today is 6 Nov 2026.
 */
export const ORGANIZATION_ID = "00000000-0000-4000-8000-0000000000aa";
export const COMPANY_NAME = "Mwangaza Logistics";
export const TODAY = "2026-11-06";
/** KES per USDC, as the wallet reports today's rate. */
export const KES_RATE = "129";

export const VIEWER = {
  userId: "00000000-0000-4000-8000-0000000000b1",
  name: "Wanjiru Kamau",
  email: "wanjiru@mwangaza.co.ke",
} as const;

/** A stable sample UUID: `sampleId(7)` → "00000000-0000-4000-8000-000000000007". */
export function sampleId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}
