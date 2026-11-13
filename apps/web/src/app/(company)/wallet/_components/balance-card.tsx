"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { InfoIcon, Table2Icon } from "lucide-react";
import { useId, useState } from "react";

import type { ActiveWallet } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import type { DailyBalance } from "./wallet-display";
import { Skel } from "~/components/data/states";
import { Badge } from "~/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
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

/** "+6,000.00 USDC", the code small and muted; `tint` shows money in green. */
export function SignedUsdc({
  amount,
  tint = false,
}: {
  amount: string;
  tint?: boolean;
}): JSX.Element {
  const moneyIn = tint && BigInt(amount) > 0n;
  return (
    <span
      className={cn(
        "whitespace-nowrap tabular-nums",
        moneyIn && "text-success-700",
      )}
    >
      {signedUsdc(amount)}{" "}
      <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-muted-foreground">
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
    <Card
      role="region"
      aria-labelledby="balance-title"
      className="gap-0 py-5 shadow-xs max-[600px]:py-4"
    >
      <CardHeader className="flex items-center gap-2.5 border-b pb-4">
        <CardTitle className="text-lg">
          <h2 id="balance-title">USDC wallet</h2>
        </CardTitle>
        <Badge variant="secondary">On {PAYEE_CHAIN_NAMES[wallet.chain]}</Badge>
      </CardHeader>
      <CardContent className="pt-4">
        <p className="flex items-center gap-1.5 text-sm font-(--w-ui) text-muted-foreground">
          Balance
          {rate ? (
            <InfoTip label="Exchange rate">
              Rate today: KES {rate} per USDC
            </InfoTip>
          ) : null}
        </p>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div>
            <p className="flex items-baseline gap-1.5">
              <span className="text-[32px] leading-10 font-(--w-display) tracking-[-0.025em] text-foreground">
                {whole}
                <span className="text-muted-foreground/70">{cents}</span>
              </span>
              <span className="text-sm font-(--w-ui) tracking-[0.04em] text-muted-foreground">
                USDC
              </span>
            </p>
            <p className="mt-0.5 text-muted-foreground tabular-nums">
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
        <p className="mt-6 text-xs leading-4 text-muted-foreground">
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
            <BalanceTable series={series} rate={rate} />
          </>
        ) : (
          <Skel width="100%" height={180} className="mt-2" />
        )}
      </CardContent>
    </Card>
  );
}

/** "Show as table" under the chart: the same balances for anyone who can't read it. */
function BalanceTable({
  series,
  rate,
}: {
  series: readonly DailyBalance[];
  rate: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        className="inline-flex items-center gap-1.5 rounded-[4px] border-0 bg-transparent px-0 py-1 text-xs leading-4 text-muted-foreground hover:text-foreground"
      >
        <Table2Icon aria-hidden="true" className="size-3.5" />
        {open ? "Hide table" : "Show as table"}
      </button>
      <div id={id} hidden={!open}>
        <Table aria-label="Balance at the end of each day">
          <TableCaption className="sr-only">
            Balance at the end of each day
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col">End of day</TableHead>
              <TableHead scope="col" className="text-right">
                USDC
              </TableHead>
              <TableHead scope="col" className="text-right">
                About KES
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {TABLE_DAYS.flatMap((index) => {
              const point = series[index];
              return point
                ? [
                    <TableRow key={point.day}>
                      <TableHead scope="row" className="font-normal">
                        {dayMonth(point.day)}
                      </TableHead>
                      <TableCell className="text-right tabular-nums">
                        {formatUsdc(point.units)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {approxKes(point.units, rate) ?? "Unavailable"}
                      </TableCell>
                    </TableRow>,
                  ]
                : [];
            })}
          </TableBody>
        </Table>
      </div>
    </div>
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
      <dt className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
        {label}
      </dt>
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
        className="rounded-[4px] border-0 bg-transparent p-0.5 text-muted-foreground/70 hover:text-muted-foreground"
      >
        <InfoIcon aria-hidden="true" className="size-4" />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-60 mt-1.5 hidden w-max max-w-64 rounded-control border border-border bg-card px-2.5 py-2 text-xs leading-4 font-normal text-secondary-foreground shadow-[0_12px_32px_-12px_rgb(16_24_40/0.22)] group-focus-within/tip:block group-hover/tip:block"
      >
        {children}
      </span>
    </span>
  );
}
