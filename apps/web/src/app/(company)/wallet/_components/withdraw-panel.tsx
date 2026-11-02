"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type {
  ActiveWallet,
  Withdrawal,
  WithdrawalAddress,
} from "@expendi-business/shared";

import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatUsdc } from "~/lib/money";
import { parseUsdcAmount, shortAddress } from "./usdc-amount";
import {
  useWithdraw,
  useWithdrawalAddresses,
  WithdrawalMismatchError,
} from "./wallet-api";

interface Draft {
  /** New for each review, so retrying the same review is the same withdrawal. */
  readonly requestId: string;
  readonly address: WithdrawalAddress;
  readonly amountUsdc: string;
}

/** Withdraws to an allowlisted address (spec §6.9), as the app does. */
export function WithdrawPanel({
  organizationId,
  wallet,
}: {
  organizationId: string;
  wallet: ActiveWallet;
}): JSX.Element {
  const addresses = useWithdrawalAddresses(organizationId);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [reviewing, setReviewing] = useState(false);

  if (addresses.isPending) {
    return <p className="text-sm text-stone-500">Loading…</p>;
  }
  if (addresses.isError) {
    return (
      <p className={alertClass} role="alert">
        {describeApiError(addresses.error)}
      </p>
    );
  }
  if (addresses.data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
        Withdrawals go only to addresses on the company&apos;s allowlist. Add
        one under Allowed addresses first.
      </p>
    );
  }

  return draft && reviewing ? (
    <WithdrawalReview
      key={draft.requestId}
      organizationId={organizationId}
      draft={draft}
      onEdit={() => setReviewing(false)}
      onDone={() => {
        setDraft(null);
        setReviewing(false);
      }}
    />
  ) : (
    <WithdrawForm
      addresses={addresses.data}
      balance={wallet.usdcBalance}
      previous={draft}
      onReview={(address, amountUsdc) => {
        setDraft({ requestId: crypto.randomUUID(), address, amountUsdc });
        setReviewing(true);
      }}
    />
  );
}

function WithdrawForm({
  addresses,
  balance,
  previous,
  onReview,
}: {
  addresses: WithdrawalAddress[];
  balance: string;
  /** What the admin entered before going back from the review. */
  previous: Draft | null;
  onReview: (address: WithdrawalAddress, amountUsdc: string) => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const address = addresses.find(
      (candidate) => candidate.id === form.get("addressId"),
    );
    if (!address) {
      setError("Choose where to send the USDC.");
      return;
    }
    const amount = form.get("amount");
    const parsed = parseUsdcAmount(
      typeof amount === "string" ? amount : "",
      balance,
    );
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    onReview(address, parsed.baseUnits);
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Withdraw USDC"
      className="grid max-w-2xl gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2"
    >
      <label className="text-sm">
        Send to
        <select
          name="addressId"
          defaultValue={previous?.address.id ?? addresses[0]?.id}
          className={inputClass}
        >
          {addresses.map((address) => (
            <option key={address.id} value={address.id}>
              {address.label} · {shortAddress(address.address)}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Amount (USDC)
        <input
          name="amount"
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          defaultValue={
            previous ? formatUsdc(previous.amountUsdc).replaceAll(",", "") : ""
          }
          className={inputClass}
        />
        <span className="mt-1 block text-stone-600">
          Available: {formatUsdc(balance)} USDC
        </span>
      </label>
      {error ? (
        <p className={`${alertClass} sm:col-span-2`} role="alert">
          {error}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button type="submit" className={primaryButton}>
          Review
        </button>
      </div>
    </form>
  );
}

function describeWithdrawError(error: unknown): string {
  return error instanceof WithdrawalMismatchError
    ? error.message
    : describeApprovalError(error);
}

function WithdrawalReview({
  organizationId,
  draft,
  onEdit,
  onDone,
}: {
  organizationId: string;
  draft: Draft;
  onEdit: () => void;
  onDone: () => void;
}): JSX.Element {
  const withdraw = useWithdraw(organizationId);
  const outcome = withdraw.data;

  if (outcome?.status === "approved") {
    return <WithdrawalResult withdrawal={outcome.result} onDone={onDone} />;
  }

  return (
    <section
      aria-label="Review the withdrawal"
      className="max-w-2xl rounded-lg border border-brand-500 bg-white p-4"
    >
      <h3 className="text-base font-semibold">Review the withdrawal</h3>
      <dl className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between gap-3">
          <dt className="text-stone-600">Amount</dt>
          <dd className="font-medium tabular-nums">
            {formatUsdc(draft.amountUsdc)} USDC
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-stone-600">To</dt>
          <dd className="text-right font-medium">{draft.address.label}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-stone-600">Address</dt>
          <dd className="text-right font-mono break-all">
            {draft.address.address}
          </dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-stone-600">Network</dt>
          <dd className="font-medium">Base</dd>
        </div>
      </dl>
      <p className="mt-3 text-sm text-stone-600">
        Expendi pays the gas, so exactly this amount arrives. Your browser asks
        for your approval passkey. To use the one on your phone, choose “use a
        phone or tablet”.
      </p>
      {outcome?.status === "cancelled" ? (
        <p className="mt-3 text-sm text-stone-600">
          Cancelled. Nothing was sent.
        </p>
      ) : null}
      {withdraw.isError ? (
        <p className={alertClass} role="alert">
          {describeWithdrawError(withdraw.error)}
        </p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={withdraw.isPending}
          onClick={() =>
            withdraw.mutate({
              requestId: draft.requestId,
              addressId: draft.address.id,
              amountUsdc: draft.amountUsdc,
              address: draft.address.address,
            })
          }
          className={primaryButton}
        >
          {withdraw.isPending
            ? "Waiting for your passkey…"
            : "Withdraw with passkey"}
        </button>
        <button
          type="button"
          disabled={withdraw.isPending}
          onClick={onEdit}
          className={secondaryButton}
        >
          Change
        </button>
      </div>
    </section>
  );
}

const RESULTS = {
  sent: {
    title: "Withdrawal sent",
    body: "It's on its way on Base and shows in the history below.",
    tone: "border-emerald-200 bg-emerald-50 text-emerald-900",
  },
  failed: {
    title: "Withdrawal failed",
    body: "Nothing was sent.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
  review: {
    title: "We're checking this withdrawal",
    body: "Its outcome isn't clear yet, so Expendi is checking it. Don't send it again.",
    tone: "border-amber-300 bg-amber-50 text-amber-900",
  },
} as const;

function WithdrawalResult({
  withdrawal,
  onDone,
}: {
  withdrawal: Withdrawal;
  onDone: () => void;
}): JSX.Element {
  const result =
    withdrawal.status === "failed"
      ? RESULTS.failed
      : withdrawal.status === "needs_review"
        ? RESULTS.review
        : RESULTS.sent;
  return (
    <section
      aria-label="Withdrawal result"
      role="status"
      className={`max-w-2xl rounded-lg border p-4 text-sm ${result.tone}`}
    >
      <p className="font-semibold">{result.title}</p>
      <p className="mt-1">
        {formatUsdc(withdrawal.amountUsdc)} USDC to {withdrawal.label}.{" "}
        {result.body}
      </p>
      {withdrawal.failureReason ? (
        <p className="mt-1">{withdrawal.failureReason}</p>
      ) : null}
      {withdrawal.txHash ? (
        <p className="mt-1 font-mono break-all">{withdrawal.txHash}</p>
      ) : null}
      <button
        type="button"
        onClick={onDone}
        className={`mt-3 ${secondaryButton}`}
      >
        Done
      </button>
    </section>
  );
}
