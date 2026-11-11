"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { CheckIcon, InfoIcon, SendIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useId } from "react";

import type {
  FloatsResponse,
  SpendingOverview,
} from "@expendi-business/shared";
import {
  cashFootnote,
  cashHeadline,
  cashOutsideLine,
} from "@expendi-business/shared";

import { textLinkClass } from "~/components/data/actions";
import { EntityMark } from "~/components/data/cells";
import { Money } from "~/components/data/money";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { formatKes, formatUsdc } from "~/lib/money";
import {
  cashLedger,
  comingUp,
  dayMonth,
  floatRows,
  obligationHref,
  obligationWhat,
} from "./overview-display";

const COMING_UP_ROWS = 3;
const FLOAT_ROWS = 3;

const railTitleClass =
  "flex items-center gap-1.5 text-lg leading-[26px] font-(--w-title) text-foreground";

function RailLink({
  href,
  children,
}: {
  href: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Link href={href} className={cn("ml-auto text-sm", textLinkClass)}>
      {children}
    </Link>
  );
}

/** A note that shows on hover and keyboard focus, like the mocks' info tips. */
function InfoTip({
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
        className="rounded-[4px] p-0.5 text-muted-foreground/70 hover:text-muted-foreground"
      >
        <InfoIcon aria-hidden="true" className="size-4" />
      </button>
      <span
        id={id}
        role="tooltip"
        className="pointer-events-none absolute top-full left-0 z-60 mt-1.5 hidden w-64 rounded-control border border-border bg-card px-2.5 py-2 text-xs leading-4 font-normal text-secondary-foreground shadow-[0_12px_32px_-12px_rgb(16_24_40/0.22)] group-focus-within/tip:block group-hover/tip:block"
      >
        {children}
      </span>
    </span>
  );
}

function BigUsdc({ baseUnits }: { baseUnits: string }): JSX.Element {
  const [whole = "0", cents = "00"] = formatUsdc(baseUnits).split(".");
  return (
    <p className="mt-2 flex items-baseline gap-1.5 tabular-nums">
      <span className="text-[32px] leading-10 font-(--w-display) tracking-[-0.025em]">
        {whole}
        <span className="text-muted-foreground/70">.{cents}</span>
      </span>
      <span className="text-sm font-(--w-ui) tracking-[0.04em] text-muted-foreground">
        USDC
      </span>
    </p>
  );
}

function LedgerRow({
  label,
  children,
  total = false,
}: {
  label: string;
  children: ReactNode;
  total?: boolean;
}): JSX.Element {
  return (
    <div
      className={cn(
        "flex justify-between gap-3",
        total && "border-t border-border pt-2.5 font-(--w-amount)",
      )}
    >
      <dt className={total ? "text-foreground" : "text-muted-foreground"}>
        {label}
      </dt>
      <dd className="whitespace-nowrap tabular-nums">{children}</dd>
    </div>
  );
}

function CashPill({ cash }: { cash: SpendingOverview["cash"] }): JSX.Element {
  const tone =
    cash.status === "covered"
      ? "bg-success-50 text-success-700"
      : cash.status === "short"
        ? "bg-error-50 text-error-700"
        : "bg-warn-50 text-warn-700";
  const Icon = cash.status === "covered" ? CheckIcon : TriangleAlertIcon;
  return (
    <p
      className={cn(
        "mt-3 inline-flex h-[22px] items-center gap-1 rounded-full pr-2 pl-1.5 text-xs font-(--w-ui) whitespace-nowrap",
        tone,
      )}
    >
      <Icon aria-hidden="true" className="size-[13px]" />
      {cash.status === "covered"
        ? "Covered for the next 30 days"
        : cash.status === "short" && cash.shortKes !== null
          ? `Short by KES ${formatKes(cash.shortKes)} in the next 30 days`
          : cashHeadline(cash)}
    </p>
  );
}

/** The wallet, what's already leaving it, what's due in 30 days and what's left. */
export function WalletCard({
  cash,
  canAct,
}: {
  cash: SpendingOverview["cash"];
  canAct: boolean;
}): JSX.Element {
  const { inProgressKes, leftOverKes } = cashLedger(cash);
  const outside = cashOutsideLine(cash);
  return (
    <Card
      role="region"
      aria-labelledby="overview-wallet"
      className="gap-0 px-5 py-5 shadow-xs [animation-delay:140ms] motion-safe:animate-rise"
    >
      <h2 id="overview-wallet" className={railTitleClass}>
        USDC wallet
        <InfoTip label="Exchange rate">
          {cash.rate === null
            ? "Paycrest's KES rate is unavailable right now."
            : `Paycrest rate today: KES ${cash.rate} per USDC.`}{" "}
          {cashFootnote(cash)}
        </InfoTip>
        <RailLink href="/wallet">View account</RailLink>
      </h2>
      <BigUsdc baseUnits={cash.balanceUsdc} />
      <p className="text-muted-foreground tabular-nums">
        {cash.balanceKes === null ? (
          "KES rate unavailable"
        ) : (
          <>
            ≈ <Money amount={cash.balanceKes} currency="KES" />
          </>
        )}
      </p>
      <dl className="mt-4 flex flex-col gap-2 text-sm">
        {inProgressKes !== null ? (
          <LedgerRow label="Payments in progress">
            − <Money amount={inProgressKes} currency="KES" />
          </LedgerRow>
        ) : null}
        <LedgerRow label={`Due through ${dayMonth(cash.through)}`}>
          − <Money amount={cash.totalKes} currency="KES" />
        </LedgerRow>
        {cash.status === "short" && cash.shortKes !== null ? (
          <LedgerRow label="Short by" total>
            <span className="text-destructive">
              <Money amount={cash.shortKes} currency="KES" />
            </span>
          </LedgerRow>
        ) : leftOverKes !== null ? (
          <LedgerRow label="Left over" total>
            <Money amount={leftOverKes} currency="KES" />
          </LedgerRow>
        ) : null}
      </dl>
      <CashPill cash={cash} />
      {cash.unknownAmounts > 0 || outside ? (
        <p className="mt-2 text-xs leading-4 text-muted-foreground">
          {cash.unknownAmounts > 0
            ? `${String(cash.unknownAmounts)} ${cash.unknownAmounts === 1 ? "payment has" : "payments have"} no amount yet. `
            : null}
          {outside ? `${outside}.` : null}
        </p>
      ) : null}
      {canAct ? (
        <div className="mt-[18px] grid grid-cols-2 gap-2">
          <Button asChild className="col-span-2">
            <Link href="/payees">
              <SendIcon aria-hidden="true" />
              Pay someone
            </Link>
          </Button>
          <Button asChild variant="outline" size="md">
            <Link href="/bills?new=1">Add a bill</Link>
          </Button>
          <Button asChild variant="outline" size="md">
            <Link href="/expenses?kind=petty_cash">Top up float</Link>
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

const cardClass =
  "gap-0 px-5 pt-[18px] pb-1.5 shadow-xs motion-safe:animate-rise";

/** Each open float: what's left of what was issued, low ones first. */
export function FloatsCard({
  floats,
}: {
  floats: UseQueryResult<FloatsResponse>;
}): JSX.Element {
  return (
    <Card
      role="region"
      aria-labelledby="overview-floats"
      className={cn(cardClass, "[animation-delay:210ms]")}
    >
      <h2 id="overview-floats" className={railTitleClass}>
        Petty cash floats
        <RailLink href="/expenses?kind=petty_cash">View all</RailLink>
      </h2>
      {floats.isPending ? (
        <div className="flex flex-col gap-4 py-3" aria-busy="true">
          {[0, 1, 2].map((key) => (
            <Skel key={key} width="100%" height={36} />
          ))}
        </div>
      ) : floats.isError ? (
        <p className="py-3 text-sm text-muted-foreground" role="alert">
          Floats didn&apos;t load.{" "}
          <button
            type="button"
            onClick={() => void floats.refetch()}
            className={cn("border-0 bg-transparent", textLinkClass)}
          >
            Try again
          </button>
        </p>
      ) : (
        <FloatList floats={floats.data} />
      )}
    </Card>
  );
}

function FloatList({ floats }: { floats: FloatsResponse }): JSX.Element {
  const rows = floatRows(floats.floats).slice(0, FLOAT_ROWS);
  if (rows.length === 0) {
    return (
      <p className="py-3 text-sm text-muted-foreground">No open floats.</p>
    );
  }
  return (
    <ul className="m-0 mt-1.5 list-none p-0">
      {rows.map(({ float, share, low }) => {
        const name = float.holder.name ?? float.holder.email;
        return (
          <li
            key={float.id}
            className="grid grid-cols-[32px_minmax(0,1fr)] items-start gap-3 py-3 not-first:border-t not-first:border-border"
          >
            <EntityMark name={name} kind="person" />
            <div className="min-w-0">
              <div className="flex justify-between gap-3 text-sm leading-5">
                <span className="truncate font-(--w-name)">{name}</span>
                <span className="whitespace-nowrap text-muted-foreground">
                  <Money amount={float.leftKes} currency="KES" /> left
                </span>
              </div>
              <div
                role="meter"
                aria-label={`${name}'s float left`}
                aria-valuemin={0}
                aria-valuemax={Number(BigInt(float.issuedKes) / 100n)}
                aria-valuenow={Math.max(
                  0,
                  Number(BigInt(float.leftKes) / 100n),
                )}
                className="mt-2 h-1 overflow-hidden rounded-full bg-muted"
              >
                <span
                  style={{ width: `${(Math.min(1, share) * 100).toFixed(1)}%` }}
                  className={cn(
                    "block h-full rounded-full",
                    low ? "bg-warn-600" : "bg-secondary-foreground",
                  )}
                />
              </div>
              <p className="mt-1.5 flex justify-between gap-2 text-xs leading-4 text-muted-foreground tabular-nums">
                <span>
                  {low ? (
                    <span className="inline-flex items-center gap-[3px] font-(--w-ui) text-warn-700">
                      <TriangleAlertIcon
                        aria-hidden="true"
                        className="size-3"
                      />
                      Low
                    </span>
                  ) : float.noReceiptCount > 0 ? (
                    `${String(float.noReceiptCount)} without a receipt`
                  ) : (
                    `${String(float.spendingCount)} ${float.spendingCount === 1 ? "payment" : "payments"}`
                  )}
                </span>
                <span>of {formatKes(float.issuedKes)}</span>
              </p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** The next bills and payroll runs, each linking to where it's paid. */
export function ComingUpCard({
  cash,
}: {
  cash: SpendingOverview["cash"];
}): JSX.Element {
  const rows = comingUp(cash);
  const shown = rows.slice(0, COMING_UP_ROWS);
  return (
    <Card
      role="region"
      aria-labelledby="overview-coming-up"
      className={cn(cardClass, "[animation-delay:280ms]")}
    >
      <h2 id="overview-coming-up" className={railTitleClass}>
        Coming up
        {rows.length > shown.length ? (
          <RailLink href="/bills">View all {rows.length}</RailLink>
        ) : null}
      </h2>
      {shown.length === 0 ? (
        <p className="py-3 text-sm text-muted-foreground">
          Nothing else due in the next 30 days.
        </p>
      ) : (
        <ul className="m-0 mt-1.5 list-none p-0">
          {shown.map((row) => {
            const [day, monthOfDay] = dayMonth(row.dueOn).split(" ");
            return (
              <li
                key={`${row.kind}:${row.id}:${row.dueOn}`}
                className="not-first:border-t not-first:border-border"
              >
                <Link
                  href={obligationHref(row)}
                  className="-mx-2 grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-3 rounded-control px-2 py-3 text-inherit no-underline hover:bg-muted/60"
                >
                  <span
                    aria-label={dayMonth(row.dueOn)}
                    className="flex size-10 flex-col items-center justify-center rounded-control border border-border bg-muted/40 tabular-nums"
                  >
                    <span
                      aria-hidden="true"
                      className="text-base leading-[18px] font-(--w-name)"
                    >
                      {day}
                    </span>
                    <span
                      aria-hidden="true"
                      className="text-[11px] leading-3 font-(--w-ui) tracking-[0.06em] text-muted-foreground uppercase"
                    >
                      {monthOfDay}
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm leading-5 font-(--w-name)">
                      {row.name}
                    </span>
                    <span className="block truncate text-xs leading-4 text-muted-foreground">
                      {obligationWhat(row)}
                    </span>
                  </span>
                  <span className="text-sm font-(--w-amount)">
                    {row.amountKes === null ? (
                      <span className="font-normal text-muted-foreground">
                        Not entered
                      </span>
                    ) : (
                      <Money amount={row.amountKes} currency="KES" />
                    )}
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
