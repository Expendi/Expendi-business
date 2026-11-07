"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode, Ref } from "react";
import { cn } from "cn";
import {
  BanknoteIcon,
  CreditCardIcon,
  LandmarkIcon,
  SmartphoneIcon,
  TriangleAlertIcon,
  WalletIcon,
} from "lucide-react";
import Link from "next/link";

import type { PaidFromAccountKind } from "@expendi-business/shared";

import { textLinkClass } from "~/components/data/actions";
import { Skel } from "~/components/data/states";
import { usePaidFromAccounts } from "~/features/bills/bills-api";
import { describeApiError } from "~/lib/api";
import { CopyButton } from "./copy-button";
import { GroupedAddress } from "./tx-sheet";
import { PAID_FROM_KIND_LABELS } from "./wallet-display";

export const railCardClass =
  "min-w-0 rounded-panel border border-gray-200 bg-surface px-5 pt-[18px] pb-5";

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
        className="flex items-center gap-2 text-lg leading-[26px] font-(--w-title) text-gray-900"
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
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t border-hairline py-3 first:border-t-0">
      <span
        aria-hidden="true"
        className="inline-flex size-8 items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-600"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm leading-5 font-(--w-name) text-gray-900">
          {title}
        </p>
        <p className="truncate text-xs leading-4 text-gray-500 tabular-nums">
          {detail}
        </p>
      </div>
      {action ?? <span />}
    </li>
  );
}

/** Where to send USDC, with a warning that only Base works. */
export function DepositCard({
  address,
  highlighted,
  copyRef,
}: {
  address: string;
  highlighted: boolean;
  copyRef: Ref<HTMLButtonElement>;
}): JSX.Element {
  return (
    <section
      id="deposit"
      aria-labelledby="deposit-title"
      className={cn(
        railCardClass,
        "scroll-mt-6 transition-shadow duration-300",
        highlighted && "shadow-[0_0_0_2px_var(--color-brand-500)]",
      )}
    >
      <RailTitle id="deposit-title">Deposit address</RailTitle>
      <p className="mt-0.5 text-sm text-gray-600">
        Send USDC here from an exchange or another wallet.
      </p>
      <p className="mt-4 text-xs leading-4 font-(--w-ui) text-gray-500">
        Base address
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
        Send USDC on Base only. Anything else sent here can be lost.
      </p>
    </section>
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
    <section aria-labelledby="paid-from-title" className={railCardClass}>
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
      <p className="mt-0.5 text-sm text-gray-600">
        Company spending paid outside Expendi says which of these it came from.
      </p>
      {accounts.isPending ? (
        <div className="mt-3 flex flex-col gap-3" aria-busy="true">
          <Skel width="70%" height={14} />
          <Skel width="55%" height={14} />
        </div>
      ) : accounts.isError ? (
        <p role="alert" className="mt-3 text-sm text-error-700">
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
        <p className="mt-3 rounded-control border border-dashed border-control-border p-4 text-center text-sm text-gray-600">
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
    </section>
  );
}
