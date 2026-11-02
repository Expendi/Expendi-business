/**
 * A payroll run's cap (spec §7.4): the net pay of the salaries drafted into
 * it plus the company's margin, 20% by default. Rounded down to the cent,
 * so the cap is never more than the margin allows.
 */
export function payrollCapKes(salariesKes: bigint, marginPct: number): bigint {
  return (salariesKes * BigInt(100 + marginPct)) / 100n;
}
