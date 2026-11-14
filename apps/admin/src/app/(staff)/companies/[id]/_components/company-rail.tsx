"use client";

import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { GaugeIcon, LinkIcon, LockIcon, ReceiptIcon } from "lucide-react";

import type { CompanyDetail } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { CopyButton } from "~/components/copy-button";
import { StatusBadge } from "~/components/data/status-badge";
import { PauseFlow } from "~/components/pause-flow";
import { Card } from "~/components/ui/card";
import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";

type CompanyWallet = NonNullable<CompanyDetail["wallet"]>;

const WALLET_TONES: Record<CompanyWallet["status"], StatusTone> = {
  active: "paid",
  creating: "moving",
};

function RailCard({
  titleId,
  title,
  aside,
  children,
}: {
  titleId: string;
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card
      role="region"
      aria-labelledby={titleId}
      className="gap-0 px-5 pt-[18px] pb-5"
    >
      <div className="flex items-center gap-2">
        <h2 id={titleId} className="text-lg leading-[26px] font-(--w-title)">
          {title}
        </h2>
        {aside ? <div className="ml-auto">{aside}</div> : null}
      </div>
      {children}
    </Card>
  );
}

/** An icon tile and two lines, as the web dashboard's Accounts rail draws a row. */
function RailRow({
  icon: Icon,
  title,
  detail,
  action,
}: {
  icon: LucideIcon;
  title: ReactNode;
  detail: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 border-t py-3 first:border-t-0">
      <span
        aria-hidden="true"
        className="inline-flex size-8 items-center justify-center rounded-control border bg-card text-muted-foreground"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-sm leading-5 font-(--w-name)">{title}</p>
        <p className="text-xs leading-4 text-muted-foreground tabular-nums">
          {detail}
        </p>
      </div>
      {action ?? <span />}
    </li>
  );
}

function shortAddress(address: string): string {
  return address.length > 16
    ? `${address.slice(0, 8)}…${address.slice(-6)}`
    : address;
}

function WalletCard({ wallet }: { wallet: CompanyDetail["wallet"] }) {
  if (wallet === null) {
    return (
      <RailCard titleId="company-wallet-title" title="Company wallet">
        <p className="mt-3 text-sm text-muted-foreground">No wallet yet.</p>
      </RailCard>
    );
  }
  const chain = PAYEE_CHAIN_NAMES[wallet.chain];
  return (
    <RailCard
      titleId="company-wallet-title"
      title="Company wallet"
      aside={
        <StatusBadge tone={WALLET_TONES[wallet.status]}>
          {wallet.status}
        </StatusBadge>
      }
    >
      <p className="mt-4 text-xs text-muted-foreground">Balance (ledger)</p>
      <p className="mt-1 text-2xl leading-8 font-(--w-title) tabular-nums">
        {formatUsdc(wallet.usdcBalance)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground tabular-nums">
        {wallet.kesEquivalent
          ? `≈ ${formatKesCents(wallet.kesEquivalent.kesCents)} at ${wallet.kesEquivalent.rate}`
          : "KES equivalent unavailable"}
      </p>
      <ul className="mt-4 border-t">
        <RailRow
          icon={LinkIcon}
          title={`On ${chain}`}
          detail={
            wallet.address ? (
              <span title={wallet.address} className="font-mono">
                {shortAddress(wallet.address)}
              </span>
            ) : (
              "Address not ready"
            )
          }
          action={
            wallet.address ? (
              <CopyButton
                value={wallet.address}
                wide={false}
                what={`the company wallet address on ${chain}`}
              />
            ) : null
          }
        />
        {wallet.balanceHome === "confidential_account" ? (
          <RailRow
            icon={LockIcon}
            title={
              wallet.confidentialUsdc === null
                ? "Confidential account"
                : formatUsdc(wallet.confidentialUsdc)
            }
            detail={
              wallet.confidentialUsdcReadAt === null
                ? "Confidential account, not read yet"
                : `Confidential, as of ${formatNairobiTime(wallet.confidentialUsdcReadAt)}`
            }
          />
        ) : null}
      </ul>
    </RailCard>
  );
}

function PayoutsCard({
  company,
  canAct,
}: {
  company: CompanyDetail;
  canAct: boolean;
}) {
  const paused = company.payoutsPaused;
  return (
    <RailCard
      titleId="company-payouts-title"
      title="Payouts"
      aside={
        <StatusBadge tone={paused ? "waiting" : "paid"}>
          {paused ? "paused" : "running"}
        </StatusBadge>
      }
    >
      {company.platformPayoutsPaused ? (
        <p className="mt-2 text-sm text-muted-foreground">
          All companies&apos; payouts are paused too (Controls).
        </p>
      ) : null}
      <ul className="mt-3">
        <RailRow
          icon={GaugeIcon}
          title={formatKesCents(company.dailyPayoutCapKesCents)}
          detail="Daily payout cap"
        />
        <RailRow
          icon={ReceiptIcon}
          title={`${String(company.unpaidClaims.count)} unpaid claims`}
          detail={formatKesCents(company.unpaidClaims.totalKesCents)}
        />
      </ul>
      <div className="mt-3 border-t pt-4">
        {canAct ? (
          <PauseFlow
            action={paused ? "unpause" : "pause"}
            organizationId={company.id}
            label={`${paused ? "Unpause" : "Pause"} ${company.name}'s payouts`}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Pausing needs an ops admin.
          </p>
        )}
      </div>
    </RailCard>
  );
}

/** The company page's side rail: its wallet and its payouts, beside the tables. */
export function CompanyRail({
  company,
  canAct,
}: {
  company: CompanyDetail;
  canAct: boolean;
}) {
  return (
    <aside aria-label="Company summary" className="flex flex-col gap-4">
      <WalletCard wallet={company.wallet} />
      <PayoutsCard company={company} canAct={canAct} />
    </aside>
  );
}
