"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  PayoutEvidence,
  ResolveOutcome,
  ResolvePrepared,
} from "@expendi-business/shared";
import { STAFF_REASON_MIN_LENGTH } from "@expendi-business/shared";

import { SecondConfirmation } from "~/components/second-confirmation";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/format";

const OUTCOMES: { value: ResolveOutcome; label: string; hint: string }[] = [
  {
    value: "paid",
    label: "Paid",
    hint: "The recipient got the money. Needs Paycrest to report the order settled (or, for a USDC payout, the transfer on chain).",
  },
  {
    value: "failed",
    label: "Failed",
    hint: "Nothing reached the recipient: either nothing left the wallet, or the USDC came back as a refund. The company's admin can then retry.",
  },
];

/**
 * Closes a payout under review as paid or failed (spec §6.8, §6.15): the
 * outcome and a reason, then the evidence and consequences the API found,
 * then a second confirmation. Nothing is ever sent.
 */
export function ResolveFlow({ payoutId }: { payoutId: string }) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<ResolveOutcome>("failed");
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<ResolvePrepared | null>(null);

  const prepare = useMutation({
    mutationFn: () => api.ops.prepareResolution(payoutId, { outcome, reason }),
    onSuccess: setPrepared,
  });

  const confirm = useMutation({
    mutationFn: (token: string) => api.ops.confirmResolution(payoutId, token),
    onSuccess: async () => {
      setOpen(false);
      setPrepared(null);
      await queryClient.invalidateQueries({ queryKey: ["internal"] });
    },
  });

  function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    prepare.mutate();
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={primaryButton}
      >
        Resolve…
      </button>
    );
  }

  if (prepared) {
    return (
      <SecondConfirmation
        title={`Resolve as ${prepared.outcome}`}
        consequences={prepared.consequences}
        reason={prepared.reason}
        expiresAt={prepared.expiresAt}
        confirmLabel={`Confirm: resolve as ${prepared.outcome}`}
        pending={confirm.isPending}
        error={confirm.isError ? describeApiError(confirm.error) : null}
        onConfirm={() => confirm.mutate(prepared.token)}
        onBack={() => {
          setPrepared(null);
          confirm.reset();
        }}
      >
        <EvidenceSummary evidence={prepared.evidence} />
      </SecondConfirmation>
    );
  }

  return (
    <form
      onSubmit={onReview}
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <fieldset>
        <legend className="text-sm font-medium">Outcome</legend>
        {OUTCOMES.map((option) => (
          <label key={option.value} className="mt-2 flex gap-2 text-sm">
            <input
              type="radio"
              name="outcome"
              value={option.value}
              checked={outcome === option.value}
              onChange={() => setOutcome(option.value)}
              className="mt-1"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-stone-600">{option.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <label className="mt-4 block text-sm font-medium">
        Reason (at least {STAFF_REASON_MIN_LENGTH} characters, kept in the audit
        log)
        <textarea
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          rows={3}
          required
          minLength={STAFF_REASON_MIN_LENGTH}
          className={inputClass}
        />
      </label>
      {prepare.isError ? (
        <p role="alert" className="mt-2 text-sm text-error-700">
          {describeApiError(prepare.error)}
        </p>
      ) : null}
      <div className="mt-3 flex gap-3">
        <button
          type="submit"
          disabled={prepare.isPending}
          className={primaryButton}
        >
          {prepare.isPending ? "Checking Paycrest and the chain…" : "Review"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            prepare.reset();
          }}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function EvidenceSummary({ evidence }: { evidence: PayoutEvidence }) {
  return (
    <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-[12rem_1fr]">
      <dt className="text-stone-600">Paycrest says</dt>
      <dd>{evidence.paycrestStatus ?? "— (no Paycrest order)"}</dd>
      <dt className="text-stone-600">Transfers to the deposit address</dt>
      <dd>
        {!evidence.fundingStarted
          ? "None: funding never started"
          : evidence.depositTransfers.length === 0
            ? "None found on chain"
            : evidence.depositTransfers.map((transfer) => (
                <span key={transfer.txHash} className="block">
                  {formatUsdc(transfer.usdcAmount)} in{" "}
                  <span className="font-mono text-xs break-all">
                    {transfer.txHash}
                  </span>
                </span>
              ))}
      </dd>
      <dt className="text-stone-600">Ledger debit</dt>
      <dd>
        {evidence.ledgerDebits.length === 0
          ? "None yet"
          : evidence.ledgerDebits
              .map((debit) => formatUsdc(debit.usdcAmount))
              .join(", ")}
      </dd>
      <dt className="text-stone-600">Refunds received</dt>
      <dd>
        {evidence.refunds.length === 0
          ? "None"
          : evidence.refunds
              .map((refund) => formatUsdc(refund.usdcAmount))
              .join(", ")}
      </dd>
    </dl>
  );
}
