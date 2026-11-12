"use client";

import type { FormEvent, ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  PayoutEvidence,
  PretiumEvidence,
  ResolveOutcome,
  ResolvePrepared,
  StaffPayoutSummary,
} from "@expendi-business/shared";
import {
  PAYEE_CHAIN_NAMES,
  STAFF_REASON_MIN_LENGTH,
} from "@expendi-business/shared";

import { PageError } from "~/components/page-state";
import { providerName } from "~/components/payout-columns";
import { SecondConfirmation } from "~/components/second-confirmation";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime, formatUsdc } from "~/lib/format";

type Provider = StaffPayoutSummary["provider"];

/** What the API needs before it allows each outcome, for this payout's provider. */
const PAID_HINTS: Record<Provider, string> = {
  paycrest:
    "The recipient got the money. Needs Paycrest to report the order settled.",
  pretium:
    "The recipient got the money. Needs Pretium to report this payout's transaction COMPLETE.",
  onchain: "The recipient got the money. Needs the transfer on chain.",
};

const FAILED_HINTS: Record<Provider, string> = {
  paycrest:
    "Nothing reached the recipient: either nothing left the wallet, or the USDC came back as a refund. The company's admin can then retry.",
  pretium:
    "Nothing reached the recipient: either nothing was sent to Pretium, or Pretium's refund of all of it is back in the ledger. The company's admin can then retry.",
  onchain:
    "Nothing reached the recipient: nothing left the wallet. The company's admin can then retry.",
};

function checkingLabel(provider: Provider): string {
  const name = providerName(provider);
  return name ? `Checking ${name} and the chain…` : "Checking the chain…";
}

function outcomes(
  provider: Provider,
): { value: ResolveOutcome; label: string; hint: string }[] {
  return [
    { value: "paid", label: "Paid", hint: PAID_HINTS[provider] },
    { value: "failed", label: "Failed", hint: FAILED_HINTS[provider] },
  ];
}

/**
 * Closes a payout under review as paid or failed (spec §6.8, §6.15): the
 * outcome and a reason, then the evidence and consequences the API found,
 * then a second confirmation. Nothing is ever sent.
 */
export function ResolveFlow({
  payoutId,
  provider,
}: {
  payoutId: string;
  provider: Provider;
}) {
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
      className="rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <fieldset>
        <legend className="text-sm font-medium">Outcome</legend>
        {outcomes(provider).map((option) => (
          <label
            key={option.value}
            className="mt-3 flex gap-3 rounded-lg border border-border p-3 text-sm has-checked:border-primary has-checked:bg-accent/40"
          >
            <input
              type="radio"
              name="outcome"
              value={option.value}
              checked={outcome === option.value}
              onChange={() => setOutcome(option.value)}
              className="mt-1 size-4 shrink-0 accent-primary"
            />
            <span>
              <span className="font-medium">{option.label}</span>
              <span className="block text-muted-foreground">{option.hint}</span>
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
        <PageError>{describeApiError(prepare.error)}</PageError>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={prepare.isPending}
          className={primaryButton}
        >
          {prepare.isPending ? checkingLabel(provider) : "Review"}
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

/** Pretium's answer, so "couldn't be read" is never shown as "not found". */
function pretiumSays(pretium: PretiumEvidence): ReactNode {
  const { transaction } = pretium;
  switch (transaction.state) {
    case "found":
      return (
        <>
          {transaction.status} for transaction{" "}
          <span className="font-mono text-xs break-all">
            {transaction.transactionCode}
          </span>
          {transaction.receiptNumber
            ? `, receipt ${transaction.receiptNumber}`
            : ""}
          {transaction.isThisPayouts ? null : (
            <span className="block text-destructive">
              It pays against{" "}
              <span className="font-mono text-xs break-all">
                {transaction.transactionHash ?? "an unknown transfer"}
              </span>
              , not this payout&rsquo;s transfer.
            </span>
          )}
        </>
      );
    case "not_found":
      return "No transaction for this payout's transfer";
    case "unreadable":
      return (
        <span className="text-destructive">
          Couldn&rsquo;t be read ({transaction.message}). This doesn&rsquo;t
          mean Pretium has no transaction.
        </span>
      );
    case "not_asked":
      return "Not asked: Pretium gave no transaction code and nothing was sent to look one up by";
  }
}

function PretiumEvidenceRows({ pretium }: { pretium: PretiumEvidence }) {
  return (
    <>
      <dt className="text-muted-foreground">Pretium says</dt>
      <dd>{pretiumSays(pretium)}</dd>
      <dt className="text-muted-foreground">Sent to</dt>
      <dd>
        {pretium.depositAddressIsSettlement ? (
          "Pretium's pinned settlement address"
        ) : (
          <span className="text-destructive">
            Not Pretium&rsquo;s pinned settlement address (
            <span className="font-mono text-xs break-all">
              {pretium.settlementAddress}
            </span>
            )
          </span>
        )}
      </dd>
      <dt className="text-muted-foreground">Refund from Pretium</dt>
      <dd>
        {pretium.refundRequestedAt
          ? `Asked for ${formatNairobiTime(pretium.refundRequestedAt)}`
          : "Not asked for"}
        {pretium.refundTxHash ? (
          <span className="block font-mono text-xs break-all">
            {pretium.refundTxHash}
          </span>
        ) : null}
        <span className="block">
          {pretium.refundCreditedUsdc
            ? `${formatUsdc(pretium.refundCreditedUsdc)} credited to the ledger`
            : "Nothing credited to the ledger yet"}
        </span>
      </dd>
    </>
  );
}

function EvidenceSummary({ evidence }: { evidence: PayoutEvidence }) {
  return (
    <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
      {evidence.pretium ? (
        <PretiumEvidenceRows pretium={evidence.pretium} />
      ) : (
        <>
          <dt className="text-muted-foreground">Paycrest says</dt>
          <dd>{evidence.paycrestStatus ?? "— (no Paycrest order)"}</dd>
        </>
      )}
      <dt className="text-muted-foreground">
        Transfers to the deposit address
      </dt>
      <dd>
        {!evidence.fundingStarted
          ? "None: funding never started"
          : evidence.depositTransfers.length === 0
            ? "None found on chain"
            : evidence.depositTransfers.map((transfer) => (
                <span key={transfer.txHash} className="block">
                  {formatUsdc(transfer.usdcAmount)} on{" "}
                  {PAYEE_CHAIN_NAMES[transfer.chain]} in{" "}
                  <span className="font-mono text-xs break-all">
                    {transfer.txHash}
                  </span>
                </span>
              ))}
      </dd>
      <dt className="text-muted-foreground">Ledger debit</dt>
      <dd>
        {evidence.ledgerDebits.length === 0
          ? "None yet"
          : evidence.ledgerDebits
              .map((debit) => formatUsdc(debit.usdcAmount))
              .join(", ")}
      </dd>
      <dt className="text-muted-foreground">Refunds received</dt>
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
