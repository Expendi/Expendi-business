/**
 * Chart scales for whole-shilling and USDC figures. Charts only place
 * marks with these numbers; every amount people read still comes from the
 * API's minor units.
 */

export interface NiceScale {
  readonly top: number;
  readonly ticks: readonly number[];
}

/** A rounded top and about `count` clean steps up to it, e.g. 0, 250K, 500K, 750K. */
export function niceScale(max: number, count = 4): NiceScale {
  if (!Number.isFinite(max) || max <= 0) return { top: 1, ticks: [0, 1] };
  const raw = max / count;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((x) => x * power).find((x) => x >= raw) ??
    10 * power;
  const top = Math.ceil(max / step) * step;
  return {
    top,
    ticks: Array.from(
      { length: Math.round(top / step) + 1 },
      (_, index) => index * step,
    ),
  };
}

/** 1240000 → "1.24M", 48200 → "48.2K", 950 → "950". */
export function compact(value: number): string {
  const size = Math.abs(value);
  if (size >= 1e6) {
    return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (size >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(value));
}

/** KES cents as whole shillings, for placing marks. */
export function kesValue(cents: string): number {
  return Number(BigInt(cents) / 100n);
}

/** "+14%", "−9%", "Same"; null when there's nothing to compare with. */
export function percentChange(
  current: number,
  previous: number,
): string | null {
  if (previous <= 0) return null;
  const change = Math.round((current / previous - 1) * 100);
  if (change === 0) return "Same";
  return `${change > 0 ? "+" : "−"}${String(Math.abs(change))}%`;
}

/** The path of a column with 4px rounded top corners and a square base. */
export function columnPath(
  x: number,
  top: number,
  width: number,
  height: number,
): string {
  const radius = Math.min(4, width / 2, height);
  const base = top + height;
  return `M${x} ${base}V${top + radius}Q${x} ${top} ${x + radius} ${top}H${x + width - radius}Q${x + width} ${top} ${x + width} ${top + radius}V${base}Z`;
}
