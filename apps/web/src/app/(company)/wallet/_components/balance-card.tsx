"use client";

import type { JSX, ReactNode } from "react";
import { InfoIcon } from "lucide-react";
import { useId } from "react";

import type { ActiveWallet } from "@expendi-business/shared";

import {
  MiniTable,
  TableToggle,
} from "~/app/(company)/reports/_components/viz/table-toggle";
import { Skel } from "~/components/data/states";
import { formatKes, formatUsdc, usdcToKesCents } from "~/lib/money";
import { BalanceChart } from "./balance-chart";
import { useBalanceHistory } from "./wallet-api";
import {
  addDays,
  dailyBalances,
  dayMonth,
  monthFlows,
  signedUsdc,
  splitUsdc,
} from "./wallet-display";

const TABLE_DAYS = [0, 7, 14, 21, 28, 30];

export const panelClass =
  "min-w-0 rounded-panel border border-gray-200 bg-surface shadow-panel";

/** "+6,000.00 USDC", the code small and muted. */
export function SignedUsdc({ amount }: { amount: string }): JSX.Element {
  return (
    <span className="whitespace-nowrap tabular-nums">
      {signedUsdc(amount)}{" "}
      <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-gray-500">
        USDC
      </span>
    </span>
  );
}

/** About how many whole shillings USDC is at `rate`; null without a rate. */
export function approxKes(units: string, rate: string | null): string | null {
  if (rate === null) return null;
  const cents = usdcToKesCents(units, rate);
  return cents === null ? null : wholeKes(cents);
}

/** KES cents to the shilling, for a figure that is only approximate. */
export function wholeKes(cents: string): string {
  return formatKes(((BigInt(cents) / 100n) * 100n).toString());
}

/**
 * The USDC wallet's balance, this month's money in and out, and the
 * balance at the end of each of the last 30 days.
 */
export function BalanceCard({
  organizationId,
  wallet,
  today,
}: {
  organizationId: string;
  wallet: ActiveWallet;
  /** Today in Nairobi, `YYYY-MM-DD`. */
  today: string;
}): JSX.Element {
  const rate = wallet.kesEquivalent?.rate ?? null;
  const month = today.slice(0, 7);
  const since =
    addDays(today, -30) < `${month}-01` ? addDays(today, -30) : `${month}-01`;
  const history = useBalanceHistory(organizationId, since);
  const [whole, cents] = splitUsdc(wallet.usdcBalance);
  const flows = history.items ? monthFlows(history.items, month) : null;
  const series =
    history.items && history.complete
      ? dailyBalances(wallet.usdcBalance, history.items, today)
      : null;

  return (
    <section
      aria-labelledby="balance-title"
      className={`${panelClass} px-6 pt-5 pb-4 max-[600px]:px-4 max-[600px]:pb-3`}
    >
      <div className="mb-4 flex items-center gap-2.5 border-b border-hairline pb-4">
        <h2
          id="balance-title"
          className="text-lg leading-[26px] font-(--w-title) text-gray-900"
        >
          USDC wallet
        </h2>
        <span className="inline-flex h-[22px] items-center rounded-full bg-gray-100 px-2 text-xs font-(--w-ui) text-gray-700">
          On Base
        </span>
      </div>
      <p className="flex items-center gap-1.5 text-sm font-(--w-ui) text-gray-600">
        Balance
        {rate ? (
          <InfoTip label="Exchange rate">
            Paycrest rate today: KES {rate} per USDC
          </InfoTip>
        ) : null}
      </p>
      <div className="mt-2 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
        <div>
          <p className="flex items-baseline gap-1.5">
            <span className="text-[32px] leading-10 font-(--w-display) tracking-[-0.025em] text-gray-900">
              {whole}
              <span className="text-gray-400">{cents}</span>
            </span>
            <span className="text-sm font-(--w-ui) tracking-[0.04em] text-gray-500">
              USDC
            </span>
          </p>
          <p className="mt-0.5 text-gray-500 tabular-nums">
            {wallet.kesEquivalent ? (
              <>
                <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em]">
                  ≈ KES
                </span>{" "}
                {wholeKes(wallet.kesEquivalent.kesCents)}
              </>
            ) : (
              "The KES value isn't available right now."
            )}
          </p>
        </div>
        <dl className="flex gap-8">
          <Flow label="In this month">
            {flows ? (
              <SignedUsdc amount={flows.in} />
            ) : (
              <Skel width={96} height={20} />
            )}
          </Flow>
          <Flow label="Out this month">
            {flows ? (
              <SignedUsdc amount={flows.out} />
            ) : (
              <Skel width={96} height={20} />
            )}
          </Flow>
        </dl>
      </div>
      <p className="mt-6 text-xs leading-4 text-gray-500">
        Balance at the end of each day, last 30 days
      </p>
      {series ? (
        <>
          <BalanceChart
            series={series}
            ariaLabel={chartLabel(series)}
            tip={(point) => ({
              head: `End of ${dayMonth(point.day)}`,
              rows: [
                {
                  key: "line",
                  value: `${formatUsdc(point.units)} USDC`,
                  label: "Balance",
                },
              ],
              foot: kesFoot(point.units, rate),
            })}
          />
          <TableToggle>
            <MiniTable
              caption="Balance at the end of each day"
              head={["End of day", "USDC", "About KES"]}
            >
              {TABLE_DAYS.flatMap((index) => {
                const point = series[index];
                return point
                  ? [
                      <tr key={point.day}>
                        <th scope="row">{dayMonth(point.day)}</th>
                        <td>{formatUsdc(point.units)}</td>
                        <td>{approxKes(point.units, rate) ?? "Unavailable"}</td>
                      </tr>,
                    ]
                  : [];
              })}
            </MiniTable>
          </TableToggle>
        </>
      ) : (
        <Skel width="100%" height={180} className="mt-2" />
      )}
    </section>
  );
}

function kesFoot(units: string, rate: string | null): string | null {
  const kes = approxKes(units, rate);
  return kes === null ? null : `≈ KES ${kes}`;
}

function chartLabel(series: readonly { day: string; units: string }[]): string {
  const lowest = series.reduce((low, point) =>
    BigInt(point.units) < BigInt(low.units) ? point : low,
  );
  const today = series.at(-1);
  return `Balance at the end of each day for the last 30 days. Lowest ${formatUsdc(lowest.units)} USDC on ${dayMonth(lowest.day)}; ${formatUsdc(today?.units ?? "0")} USDC today. Use the arrow keys to read each day.`;
}

function Flow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs leading-4 font-(--w-ui) text-gray-500">{label}</dt>
      <dd className="mt-0.5 text-base leading-6 font-(--w-amount)">
        {children}
      </dd>
    </div>
  );
}

/** A small "i" whose note shows on hover and focus. */
export function InfoTip({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  const id = useId();
  return (
    <span className="group/tip relative inline-flex">
      <button
        type="button"
        aria-label={label}
        aria-describedby={id}
        className="rounded-[4px] border-0 bg-transparent p-0.5 text-gray-400 hover:text-gray-600"
      >
        <InfoIcon aria-hidden="true" className="size-4" />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-60 mt-1.5 hidden w-max max-w-64 rounded-control border border-gray-200 bg-surface px-2.5 py-2 text-xs leading-4 font-normal text-gray-700 shadow-[0_12px_32px_-12px_rgb(16_24_40/0.22)] group-focus-within/tip:block group-hover/tip:block"
      >
        {children}
      </span>
    </span>
  );
}
