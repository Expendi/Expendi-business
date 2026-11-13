const nairobiTime = new Intl.DateTimeFormat("en-KE", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Staff read every time in Nairobi, where the companies are (spec §6.13). */
export function formatNairobiTime(iso: string): string {
  return `${nairobiTime.format(new Date(iso))} EAT`;
}

const grouped = new Intl.NumberFormat("en-KE");

/** Integer strings only: money never goes through a float. */
function formatFixed(units: string, decimals: number): string {
  const negative = units.startsWith("-");
  const digits = (negative ? units.slice(1) : units).padStart(
    decimals + 1,
    "0",
  );
  const whole = digits.slice(0, digits.length - decimals);
  const fraction = digits.slice(digits.length - decimals);
  return `${negative ? "-" : ""}${grouped.format(BigInt(whole))}.${fraction}`;
}

/** KES cents as e.g. "KES 1,500.00". */
export function formatKesCents(cents: string): string {
  return `KES ${formatFixed(cents, 2)}`;
}

/** US cents as e.g. "USD 1,500.50", as Expendi cards show amounts. */
export function formatUsdCents(cents: string): string {
  return `USD ${formatFixed(cents, 2)}`;
}

/** USDC base units (6 decimals) as e.g. "12.500000 USDC". */
export function formatUsdc(baseUnits: string): string {
  return `${formatFixed(baseUnits, 6)} USDC`;
}
