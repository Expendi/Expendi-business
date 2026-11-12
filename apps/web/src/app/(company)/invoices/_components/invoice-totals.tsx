import type { JSX } from "react";

import { Usd } from "~/features/invoices/invoice-status";

/** Subtotal, tax (when there is one) and the total, right-aligned, under the lines. */
export function InvoiceTotalsBlock({
  subtotalCents,
  taxCents,
  taxLabel,
  taxRatePercent,
  totalCents,
}: {
  subtotalCents: string;
  taxCents: string;
  taxLabel: string;
  /** Null when the invoice has no tax. */
  taxRatePercent: string | null;
  totalCents: string;
}): JSX.Element {
  return (
    <dl className="ml-auto flex w-full max-w-72 flex-col gap-1.5 tabular-nums">
      <div className="flex justify-between gap-4">
        <dt className="text-muted-foreground">Subtotal</dt>
        <dd>
          <Usd cents={subtotalCents} />
        </dd>
      </div>
      {taxRatePercent === null ? null : (
        <div className="flex justify-between gap-4">
          <dt className="text-muted-foreground">
            {taxLabel} ({taxRatePercent}%)
          </dt>
          <dd>
            <Usd cents={taxCents} />
          </dd>
        </div>
      )}
      <div className="flex justify-between gap-4 border-t border-hairline pt-2 text-base font-(--w-amount)">
        <dt>Total</dt>
        <dd>
          <Usd cents={totalCents} />
        </dd>
      </div>
    </dl>
  );
}
