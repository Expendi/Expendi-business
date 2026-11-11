"use client";

import type { JSX, RefObject } from "react";
import { ArrowDownLeftIcon, ArrowUpRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ActiveWallet } from "@expendi-business/shared";

import { PageHeader } from "~/components/data/page-header";
import { ErrorState, Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { AddAddressSheet, AllowedAddresses } from "./allowed-addresses";
import { BalanceCard, panelClass } from "./balance-card";
import { FundInSheet } from "./fund-in-sheet";
import { DepositCard, PaidFromAccounts } from "./rail-cards";
import { useCompanyWallet, useFinishWalletSetup } from "./wallet-api";
import { nairobiDay } from "./wallet-display";
import { WalletHistory } from "./wallet-history";
import { WithdrawSheet } from "./withdraw-sheet";

/**
 * Accounts (spec §6.9, §6.14): the company wallet's balance, how to fund
 * in, the allowlist, every movement, and the accounts spending outside
 * Expendi is paid from. Admins and accountants see it all; only admins fund
 * in from another chain, and only admins withdraw or change the allowlist,
 * each with their approval passkey.
 */
export function WalletView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyAccounts
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

type OpenSheet = "withdraw" | "add-address" | "fund-in" | null;

function CompanyAccounts({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const wallet = useCompanyWallet(organizationId);
  const active = wallet.data?.status === "active" ? wallet.data : null;
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [highlighted, setHighlighted] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(false), 1600);
    return () => clearTimeout(timer);
  }, [highlighted]);

  function showDeposit() {
    const reduce = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    document.getElementById("deposit")?.scrollIntoView({
      behavior: reduce ? "auto" : "smooth",
      block: "center",
    });
    copyRef.current?.focus({ preventScroll: true });
    setHighlighted(true);
  }

  return (
    <section>
      <PageHeader
        title="Accounts"
        subtitle="Where the company's money is held, and every movement in and out."
        actions={
          active ? (
            <>
              {canAct ? (
                <Button variant="outline" onClick={() => setSheet("withdraw")}>
                  <ArrowUpRightIcon aria-hidden="true" />
                  Withdraw
                </Button>
              ) : null}
              <Button onClick={showDeposit}>
                <ArrowDownLeftIcon aria-hidden="true" />
                Fund in
              </Button>
            </>
          ) : null
        }
      />

      {wallet.isPending ? (
        <AccountsSkeleton />
      ) : wallet.isError ? (
        <div className={`${panelClass} mt-6`}>
          <ErrorState
            title="Accounts didn't load"
            onRetry={() => void wallet.refetch()}
          >
            {describeApiError(wallet.error)}
          </ErrorState>
        </div>
      ) : active ? (
        <ActiveAccounts
          organizationId={organizationId}
          canAct={canAct}
          wallet={active}
          highlighted={highlighted}
          copyRef={copyRef}
          onAddAddress={() => setSheet("add-address")}
          onFundIn={() => setSheet("fund-in")}
        />
      ) : (
        <WalletStillCreating organizationId={organizationId} canAct={canAct} />
      )}

      {active && canAct ? (
        <>
          <WithdrawSheet
            open={sheet === "withdraw"}
            organizationId={organizationId}
            wallet={active}
            onClose={() => setSheet(null)}
            onAddAddress={() => setSheet("add-address")}
          />
          <AddAddressSheet
            key={sheet === "add-address" ? "open" : "closed"}
            open={sheet === "add-address"}
            organizationId={organizationId}
            onClose={() => setSheet(null)}
          />
          <FundInSheet
            key={sheet === "fund-in" ? "open" : "closed"}
            open={sheet === "fund-in"}
            organizationId={organizationId}
            onClose={() => setSheet(null)}
          />
        </>
      ) : null}
    </section>
  );
}

function ActiveAccounts({
  organizationId,
  canAct,
  wallet,
  highlighted,
  copyRef,
  onAddAddress,
  onFundIn,
}: {
  organizationId: string;
  canAct: boolean;
  wallet: ActiveWallet;
  highlighted: boolean;
  copyRef: RefObject<HTMLButtonElement | null>;
  onAddAddress: () => void;
  onFundIn: () => void;
}): JSX.Element {
  const today = nairobiDay(new Date());
  const rate = wallet.kesEquivalent?.rate ?? null;
  return (
    <div className="mt-6 grid grid-cols-[minmax(0,1fr)_352px] items-start gap-4 max-[1120px]:flex max-[1120px]:flex-col max-[1120px]:items-stretch">
      <div className="flex min-w-0 flex-col gap-4 max-[1120px]:contents">
        <div className="min-w-0 motion-safe:animate-rise max-[1120px]:order-1">
          <BalanceCard
            organizationId={organizationId}
            wallet={wallet}
            today={today}
          />
        </div>
        <div className="min-w-0 [animation-delay:210ms] motion-safe:animate-rise max-[1120px]:order-3">
          <WalletHistory
            organizationId={organizationId}
            today={today}
            rate={rate}
          />
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-4 max-[1120px]:contents">
        <div className="min-w-0 [animation-delay:140ms] motion-safe:animate-rise max-[1120px]:order-2">
          <DepositCard
            address={wallet.address}
            chain={wallet.chain}
            highlighted={highlighted}
            copyRef={copyRef}
            onFundIn={canAct ? onFundIn : null}
          />
        </div>
        <div className="min-w-0 [animation-delay:280ms] motion-safe:animate-rise max-[1120px]:order-4">
          <AllowedAddresses
            organizationId={organizationId}
            canAct={canAct}
            onAdd={onAddAddress}
          />
        </div>
        <div className="min-w-0 [animation-delay:350ms] motion-safe:animate-rise max-[1120px]:order-5">
          <PaidFromAccounts organizationId={organizationId} />
        </div>
      </div>
    </div>
  );
}

function AccountsSkeleton(): JSX.Element {
  return (
    <div
      aria-busy="true"
      className="mt-6 grid grid-cols-[minmax(0,1fr)_352px] items-start gap-4 max-[1120px]:grid-cols-1"
    >
      <div className={`${panelClass} flex flex-col gap-3 p-6`}>
        <Skel width="30%" height={18} />
        <Skel width="45%" height={36} style={{ marginTop: 12 }} />
        <Skel width="100%" height={180} style={{ marginTop: 16 }} />
      </div>
      <div className={`${panelClass} flex flex-col gap-3 p-5`}>
        <Skel width="50%" height={18} />
        <Skel width="100%" height={14} />
        <Skel width="100%" height={36} style={{ marginTop: 12 }} />
      </div>
    </div>
  );
}

function WalletStillCreating({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const finish = useFinishWalletSetup(organizationId);
  return (
    <div className={`${panelClass} mt-6 p-5 text-sm text-gray-700`}>
      <p className="text-base leading-6 font-(--w-title) text-gray-900">
        The wallet is still being set up
      </p>
      <p className="mt-1">
        {canAct
          ? "Its address appears here once it's ready."
          : "An admin can finish setting it up."}
      </p>
      {canAct ? (
        <Button
          className="mt-3"
          size="md"
          onClick={() => finish.mutate()}
          disabled={finish.isPending}
        >
          {finish.isPending ? "Setting it up…" : "Finish setting up wallet"}
        </Button>
      ) : null}
      {finish.isError ? (
        <p role="alert" className="mt-3 text-sm text-error-700">
          {describeApiError(finish.error)}
        </p>
      ) : null}
    </div>
  );
}
