import { formatKesCents, formatUsdc } from "~/lib/money";

/** Cents are cents in any currency; the helper's name is the only KES part. */
export function formatUsd(cents: string): string {
  return `$${formatKesCents(cents)}`;
}

/** USDC base units with every non-zero decimal, e.g. "1,250.00". */
export function formatUsdcAmount(baseUnits: string): string {
  return formatUsdc(baseUnits);
}

/** 1600 becomes "16%", 1650 becomes "16.5%". */
export function formatRateBps(bps: number): string {
  return `${Number((bps / 100).toFixed(2))}%`;
}

/** "1:59:30" with hours left, "04:05" under an hour, null once passed. */
export function formatCountdown(msLeft: number): string | null {
  if (msLeft <= 0) return null;
  const totalSeconds = Math.ceil(msLeft / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${pad(minutes)}:${pad(seconds)}`;
}
