import type { JSX, ReactNode } from "react";

import type { CashObligation } from "@expendi-business/shared";

import { Money } from "~/components/data/money";
import { cardEstimateUsdc } from "./overview-display";

/**
 * A company-held card is charged whatever the payee charges, in USD from
 * the Card balance, so its payment shows the USD estimate the Card balance
 * is checked against, never the KES the cash check values it at.
 */
export function CardEstimate({
  row,
  none,
  about = "About",
}: {
  row: Pick<CashObligation, "amountUsdCents">;
  /** "No estimate", in the muted style the list gives a missing amount. */
  none: ReactNode;
  /** "about" mid-sentence. */
  about?: string;
}): JSX.Element {
  const usdc = cardEstimateUsdc(row);
  if (usdc === null) return <>{none}</>;
  return (
    <span className="whitespace-nowrap">
      <span className="font-(--w-ui) text-muted-foreground">{about} </span>
      <Money amount={usdc} currency="USD" />
    </span>
  );
}
