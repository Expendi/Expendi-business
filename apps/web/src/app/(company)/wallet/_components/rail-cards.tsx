"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode, Ref } from "react";
import { cn } from "cn";
import {
  ArrowDownLeftIcon,
  BanknoteIcon,
  CreditCardIcon,
  LandmarkIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";

import type {
  PaidFromAccountKind,
  WalletChain,
} from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import { textLinkClass } from "~/components/data/actions";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { usePaidFromAccounts } from "~/features/bills/bills-api";
import { describeApiError } from "~/lib/api";
import { CopyButton } from "./copy-button";
import { GroupedAddress } from "./tx-sheet";
import { PAID_FROM_KIND_LABELS } from "./wallet-display";

const railCardClass = "gap-0 px-5 pt-[18px] pb-5";

export function RailCard({
  id,
  titleId,
  className,
  children,
}: {
  id?: string;
  titleId: string;
  className?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Card
      id={id}
      role="region"
      aria-labelledby={titleId}
      className={cn(railCardClass, className)}
    >
      {children}
    </Card>
  );
}

export function RailTitle({
  id,
  children,
  aside,
}: {
  id: string;
  children: ReactNode;
  aside?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <h2
        id={id}
        className="flex items-center gap-2 text-lg leading-[26px] font-(--w-title) text-foreground"
      >
        {children}
      </h2>
      {aside ? <div className="ml-auto text-sm">{aside}</div> : null}
    </div>
  );
}

/** A tile and two lines, as the rail's lists show an address or an account. */
export function RailRow({
  icon: Icon = LandmarkIcon,
  title,
  detail,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  detail: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-border py-3 first:border-t-0">
      <span
        aria-hidden="true"
        className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm leading-5 font-(--w-name) text-foreground">
          {title}
        </p>
        <p className="truncate text-xs leading-4 text-muted-foreground tabular-nums">
          {detail}
        </p>
      </div>
      {action ?? <span />}
    </li>
  );
}

/**
 * Where to send USDC on the company wallet's own chain, with a warning that
 * nothing else works, and the way in from another chain.
 */
export function DepositCard({
  address,
  chain,
  highlighted,
  copyRef,
  onFundIn,
}: {
  address: string;
  chain: WalletChain;
  highlighted: boolean;
  copyRef: Ref<HTMLButtonElement>;
  /** Opens the fund-in from another chain; null for someone who can't. */
  onFundIn: (() => void) | null;
}): JSX.Element {
  const chainName = PAYEE_CHAIN_NAMES[chain];
  return (
    <RailCard
      id="deposit"
      titleId="deposit-title"
      className={cn(
        "scroll-mt-6 transition-shadow duration-300",
        highlighted && "shadow-[0_0_0_2px_var(--primary)]",
      )}
    >
      <RailTitle id="deposit-title">Fund in</RailTitle>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Send USDC on {chainName} to the company wallet from an exchange or
        another wallet.
      </p>
      <p className="mt-4 text-xs leading-4 font-(--w-ui) text-muted-foreground">
        {chain === "near" ? "NEAR account" : `${chainName} address`}
      </p>
      <p className="mt-1 text-sm leading-5 select-all">
        <GroupedAddress address={address} />
      </p>
      <div className="mt-3.5">
        <CopyButton ref={copyRef} value={address} label="Copy address" />
      </div>
      <p className="mt-3.5 flex items-start gap-2 rounded-control bg-warn-50 px-3 py-2.5 text-sm leading-5 text-warn-700">
        <TriangleAlertIcon
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0"
        />
        Send USDC on {chainName} only. Anything else sent here can be lost.
      </p>
      {onFundIn ? (
        <>
          <p className="mt-3.5 text-sm text-muted-foreground">
            USDC on Base, Ethereum, Arbitrum or Solana needs its own one-time
            address.
          </p>
          <Button
            variant="outline"
            size="md"
            className="mt-3 w-full"
            onClick={onFundIn}
          >
            <ArrowDownLeftIcon aria-hidden="true" />
            Fund in from another chain
          </Button>
        </>
      ) : null}
    </RailCard>
  );
}

const KIND_ICONS: Record<PaidFromAccountKind, LucideIcon> = {
  bank: LandmarkIcon,
  card: CreditCardIcon,
  mobile_money: SmartphoneIcon,
  cash: BanknoteIcon,
  other: WalletIcon,
};

/**
 * The accounts company spending is paid from outside Expendi (spec
 * §6.23), read-only here; Settings is where they're added and changed.
 */
export function PaidFromAccounts({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const accounts = usePaidFromAccounts(organizationId);
  return (
    <RailCard titleId="paid-from-title">
      <RailTitle
        id="paid-from-title"
        aside={
          <Link href="/settings?section=accounts" className={textLinkClass}>
            Manage in Settings
          </Link>
        }
      >
        Paid-from accounts
      </RailTitle>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Company spending paid outside Expendi says which of these it came from.
      </p>
      {accounts.isPending ? (
        <div className="mt-3 flex flex-col gap-3" aria-busy="true">
          <Skel width="70%" height={14} />
          <Skel width="55%" height={14} />
        </div>
      ) : accounts.isError ? (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {describeApiError(accounts.error)}{" "}
          <button
            type="button"
            onClick={() => void accounts.refetch()}
            className={`border-0 bg-transparent ${textLinkClass}`}
          >
            Try again
          </button>
        </p>
      ) : accounts.data.length === 0 ? (
        <p className="mt-3 rounded-control border border-dashed border-input p-4 text-center text-sm text-muted-foreground">
          No accounts yet. Add them in Settings.
        </p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {accounts.data.map((account) => (
            <RailRow
              key={account.id}
              icon={KIND_ICONS[account.kind]}
              title={account.name}
              detail={PAID_FROM_KIND_LABELS[account.kind]}
            />
          ))}
        </ul>
      )}
    </RailCard>
  );
}
