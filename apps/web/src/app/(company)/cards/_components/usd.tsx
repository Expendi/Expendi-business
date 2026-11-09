import type { JSX } from "react";
import { cn } from "cn";

import { CurrencyCode } from "~/components/data/money";
import { usdNumber } from "./cards-display";

/**
 * US cents with the code small and muted, as `Money` shows other amounts.
 * The minus goes in front; `plus` marks money coming back, e.g. a refund.
 */
export function Usd({
  cents,
  plus = false,
  className,
}: {
  cents: string;
  plus?: boolean;
  className?: string;
}): JSX.Element {
  const sign = BigInt(cents) < 0n ? "−" : plus ? "+" : "";
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      {sign}
      <CurrencyCode code="USD" /> {usdNumber(cents)}
    </span>
  );
}
