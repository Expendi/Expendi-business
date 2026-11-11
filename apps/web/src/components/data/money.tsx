import type { JSX, ReactNode } from "react";
import { cn } from "cn";

import type { ApproxKesTotal } from "~/lib/money";
import { formatKes, formatUsdc } from "~/lib/money";

/** KES is in cents; USD and USDC are in USDC base units (6 decimals). */
export type MoneyCurrency = "KES" | "USD" | "USDC";

export function CurrencyCode({ code }: { code: string }): JSX.Element {
  return (
    <span
      data-ccy=""
      className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-muted-foreground"
    >
      {code}
    </span>
  );
}

/**
 * An amount with its currency code small and muted: "KES 48,500",
 * "USD 45.00", "16,420.80 USDC". The number carries the weight.
 */
export function Money({
  amount,
  currency,
  className,
}: {
  amount: string;
  currency: MoneyCurrency;
  className?: string;
}): JSX.Element {
  const number = currency === "KES" ? formatKes(amount) : formatUsdc(amount);
  return (
    <span className={cn("whitespace-nowrap tabular-nums", className)}>
      {currency === "USDC" ? (
        <>
          {number} <CurrencyCode code="USDC" />
        </>
      ) : (
        <>
          <CurrencyCode code={currency} /> {number}
        </>
      )}
    </span>
  );
}

/**
 * One KES figure for a total that may include USD (from `approxKesTotal`),
 * after a muted "≈" when USD was converted at today's rate.
 */
export function KesTotal({
  total,
  unavailable = "Rate unavailable",
  className,
}: {
  total: ApproxKesTotal | null;
  unavailable?: ReactNode;
  className?: string;
}): JSX.Element {
  if (total === null) {
    return <span className="text-muted-foreground">{unavailable}</span>;
  }
  return (
    <span className={cn("whitespace-nowrap", className)}>
      {total.approximate ? (
        <span className="font-(--w-ui) text-muted-foreground">≈ </span>
      ) : null}
      <Money amount={total.kesCents} currency="KES" />
    </span>
  );
}

/**
 * An amount cell: the amount on top (16/24 at 500 in rows), an optional
 * muted line under it, e.g. "≈ KES 5,805 today" for a USD bill.
 */
export function AmountStack({
  children,
  sub,
  align = "end",
  size = "row",
}: {
  children: ReactNode;
  sub?: ReactNode;
  align?: "start" | "end";
  size?: "row" | "inherit";
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex flex-col",
        align === "end" ? "items-end" : "items-start",
      )}
    >
      <span
        className={
          size === "row"
            ? "text-base leading-6 font-(--w-amount) whitespace-nowrap"
            : undefined
        }
      >
        {children}
      </span>
      {sub ? (
        <span className="text-xs leading-4 font-normal tracking-normal whitespace-nowrap text-muted-foreground tabular-nums">
          {sub}
        </span>
      ) : null}
    </span>
  );
}
