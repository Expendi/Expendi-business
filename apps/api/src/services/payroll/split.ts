/**
 * Paycrest's largest KES order is about 3,000 USDC, roughly KES 386,000
 * (T7, 2026-11-01). A salary above the active cash-out provider's largest
 * cash-out is paid as several under the same approval (spec §7.5), each
 * its own payout. Through Paycrest each part stays at or under KES 300,000,
 * so a weaker shilling can't push one past the limit (`cashOutLimits`).
 */
export const MAX_KES_PER_ORDER_CENTS = 30_000_000n;

const ONE_SHILLING = 100n;

/**
 * A salary's cash-outs, in KES cents: one if it fits under `maxKesCents`
 * (whole shillings), otherwise as few as fit, as even as whole shillings
 * allow, the cents on the last. They add up to exactly `amountKes`, e.g.
 * KES 500,000.50 under KES 300,000 → 250,001 + 249,999.50. Part 1 is the
 * first.
 */
export function salaryParts(amountKes: bigint, maxKesCents: bigint): bigint[] {
  if (amountKes <= maxKesCents) return [amountKes];
  const count = (amountKes + maxKesCents - 1n) / maxKesCents;
  const perPart = (amountKes + count - 1n) / count;
  const whole = ((perPart + ONE_SHILLING - 1n) / ONE_SHILLING) * ONE_SHILLING;
  const parts = Array.from({ length: Number(count) - 1 }, () => whole);
  return [...parts, amountKes - whole * (count - 1n)];
}
