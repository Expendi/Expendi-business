import type { ReactNode } from "react";

import type {
  CardState,
  DatedBillStatus,
  StaffCardPaidPayment,
  StaffCardSimulations,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { StatusBadge } from "~/components/data/status-badge";
import { PageEmpty } from "~/components/page-state";
import { formatNairobiTime, formatUsdCents } from "~/lib/format";

const CARD_TONES: Record<CardState, StatusTone> = {
  open: "paid",
  frozen: "waiting",
  closed: "rejected",
};

const BILL_TONES: Record<DatedBillStatus, StatusTone> = {
  upcoming: "quiet",
  due: "waiting",
  overdue: "overdue",
};

const isDated = (status: string): status is DatedBillStatus =>
  status in BILL_TONES;

const LAST_OUTCOMES: Record<
  NonNullable<NonNullable<StaffCardPaidPayment["lastSimulation"]>["result"]>,
  string
> = {
  approved: "Approved",
  declined: "Declined",
  unknown: "Outcome unknown: Lithic didn't confirm it",
};

/** How the last pretend purchase went, in a few words. */
export function lastSimulationSummary(
  last: NonNullable<StaffCardPaidPayment["lastSimulation"]>,
): string {
  const outcome =
    last.result === null
      ? "Not seen by the purchase check yet"
      : LAST_OUTCOMES[last.result];
  const by = last.byStaff ? "by staff" : "by the daily job";
  return `${outcome} · ${formatUsdCents(last.amountUsdCents)} · ${by}`;
}

function Payment({
  payment,
  action,
}: {
  payment: StaffCardPaidPayment;
  action: ReactNode;
}) {
  const { card, nextBill, lastSimulation } = payment;
  return (
    <article
      aria-label={payment.payeeName}
      className="border-t px-4 py-4 sm:px-6"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold wrap-anywhere">
          {payment.payeeName}
        </h3>
        {payment.state === "paused" ? (
          <StatusBadge tone="waiting">Paused</StatusBadge>
        ) : null}
      </div>
      <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[10rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Estimate</dt>
        <dd>
          {payment.estimateUsdCents
            ? formatUsdCents(payment.estimateUsdCents)
            : "None"}
        </dd>
        <dt className="text-muted-foreground">Company-held card</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span className="wrap-anywhere">
            {card.nickname} ··{card.lastFour}
          </span>
          <StatusBadge tone={CARD_TONES[card.state]}>{card.state}</StatusBadge>
        </dd>
        <dt className="text-muted-foreground">Next bill</dt>
        <dd className="flex flex-wrap items-center gap-2">
          {nextBill ? (
            <>
              <span>
                Due {nextBill.dueOn}
                {nextBill.amountUsdCents
                  ? `, ${formatUsdCents(nextBill.amountUsdCents)}`
                  : ""}
              </span>
              <StatusBadge
                tone={
                  isDated(nextBill.status)
                    ? BILL_TONES[nextBill.status]
                    : "quiet"
                }
              >
                {nextBill.status}
              </StatusBadge>
            </>
          ) : (
            "None owed"
          )}
        </dd>
        <dt className="text-muted-foreground">Last simulation</dt>
        <dd>
          {lastSimulation ? (
            <>
              {lastSimulationSummary(lastSimulation)}
              <span className="block text-xs text-muted-foreground">
                {formatNairobiTime(lastSimulation.at)} · merchant{" "}
                <span className="font-mono">{lastSimulation.merchantKey}</span>
              </span>
            </>
          ) : (
            "None yet"
          )}
        </dd>
      </dl>
      {action}
    </article>
  );
}

/** The company's card-paid recurring payments, each with the action slot staff may use. */
export function CardSimulationsView({
  simulations,
  renderAction,
}: {
  simulations: StaffCardSimulations;
  renderAction: (payment: StaffCardPaidPayment) => ReactNode;
}) {
  if (!simulations.available) {
    return (
      <div className="px-4 pb-4 sm:px-6">
        <PageEmpty title="Simulated purchases are turned off for this environment.">
          The API needs CARD_SIMULATIONS_ENABLED=true and Lithic&apos;s sandbox
          key before staff or the daily job can make one.
        </PageEmpty>
      </div>
    );
  }
  if (simulations.payments.length === 0) {
    return (
      <div className="px-4 pb-4 sm:px-6">
        <PageEmpty title="No recurring payment is paid by a company-held card." />
      </div>
    );
  }
  return (
    <div className="mt-4">
      {simulations.payments.map((payment) => (
        <Payment
          key={payment.id}
          payment={payment}
          action={renderAction(payment)}
        />
      ))}
    </div>
  );
}
