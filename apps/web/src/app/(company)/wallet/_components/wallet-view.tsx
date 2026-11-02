"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";

import type { ActiveWallet, WalletResponse } from "@expendi-business/shared";

import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatKesCents, formatUsdc } from "~/lib/money";
import { AllowedAddresses } from "./allowed-addresses";
import { CopyButton } from "./copy-button";
import { useCompanyWallet, useFinishWalletSetup } from "./wallet-api";
import { WalletHistory } from "./wallet-history";
import { WithdrawPanel } from "./withdraw-panel";

/**
 * The company wallet (spec §6.9, §6.14): its balance, where to deposit,
 * the allowlist and the history, for admins and accountants. Only admins
 * withdraw or change the allowlist, each with their approval passkey.
 */
export function WalletView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyWallet
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyWallet({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const wallet = useCompanyWallet(organizationId);
  const active = wallet.data?.status === "active" ? wallet.data : null;

  return (
    <section className="space-y-8">
      <div>
        <h1 className="text-xl font-semibold">Wallet</h1>
        <p className="mt-1 text-sm text-stone-600">
          {canAct
            ? "The company's USDC on Base. Withdrawals go only to allowed addresses, confirmed with your approval passkey."
            : "The company's USDC on Base, its allowed addresses and every movement. Only admins withdraw."}
        </p>
      </div>

      <WalletSummary
        organizationId={organizationId}
        canAct={canAct}
        wallet={wallet}
      />

      {active && canAct ? (
        <section aria-labelledby="withdraw-heading" className="space-y-3">
          <h2 id="withdraw-heading" className="text-base font-semibold">
            Withdraw
          </h2>
          <ApprovalPasskeyGate>
            <WithdrawPanel organizationId={organizationId} wallet={active} />
          </ApprovalPasskeyGate>
        </section>
      ) : null}

      {active ? (
        <>
          <AllowedAddresses organizationId={organizationId} canAct={canAct} />
          <WalletHistory organizationId={organizationId} />
        </>
      ) : null}
    </section>
  );
}

function WalletSummary({
  organizationId,
  canAct,
  wallet,
}: {
  organizationId: string;
  canAct: boolean;
  wallet: UseQueryResult<WalletResponse>;
}): JSX.Element {
  if (wallet.isPending) {
    return <p className="text-sm text-stone-500">Loading the wallet…</p>;
  }
  if (wallet.isError) {
    return (
      <div className={alertClass} role="alert">
        <p>{describeApiError(wallet.error)}</p>
        <button
          type="button"
          onClick={() => void wallet.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }
  if (wallet.data.status === "creating") {
    return (
      <WalletStillCreating organizationId={organizationId} canAct={canAct} />
    );
  }
  return <ActiveWalletCards wallet={wallet.data} />;
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
    <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-700">
      <p className="font-medium text-stone-900">
        The wallet is still being set up
      </p>
      <p className="mt-1">
        {canAct
          ? "Its deposit address appears here once it's ready."
          : "An admin can finish setting it up."}
      </p>
      {canAct ? (
        <button
          type="button"
          onClick={() => finish.mutate()}
          disabled={finish.isPending}
          className={`mt-3 ${primaryButton}`}
        >
          {finish.isPending ? "Setting it up…" : "Finish setting up wallet"}
        </button>
      ) : null}
      {finish.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(finish.error)}
        </p>
      ) : null}
    </div>
  );
}

function ActiveWalletCards({ wallet }: { wallet: ActiveWallet }): JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="text-sm text-stone-600">Balance</h2>
        <p className="mt-1 text-2xl font-semibold tabular-nums">
          {formatUsdc(wallet.usdcBalance)} USDC
        </p>
        <p className="mt-1 text-sm text-stone-600">
          {wallet.kesEquivalent
            ? `About KES ${formatKesCents(wallet.kesEquivalent.kesCents)} at Paycrest's rate of ${wallet.kesEquivalent.rate} KES per USDC`
            : "The KES value isn't available right now."}
        </p>
      </div>
      <div className="rounded-lg border border-stone-200 bg-white p-4">
        <h2 className="text-sm text-stone-600">Deposit address</h2>
        <p className="mt-1 font-mono text-sm break-all select-all">
          {wallet.address}
        </p>
        <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900">
          Send USDC on Base only. Anything else sent here can be lost.
        </p>
        <div className="mt-3">
          <CopyButton value={wallet.address} label="Copy address" />
        </div>
      </div>
    </div>
  );
}
