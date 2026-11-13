"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  IntentQuoteEvidence,
  IntentQuoteResolution,
  IntentQuoteResolvePrepared,
  QuoteTransfer,
} from "@expendi-business/shared";
import {
  PAYEE_CHAIN_NAMES,
  STAFF_REASON_MIN_LENGTH,
} from "@expendi-business/shared";

import { PageError } from "~/components/page-state";
import { SecondConfirmation } from "~/components/second-confirmation";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/format";

const OUTCOMES: {
  value: IntentQuoteResolution;
  label: string;
  hint: string;
}[] = [
  {
    value: "delivered",
    label: "Delivered",
    hint: "The recipient got the USDC. Needs the destination chain to show it in a transaction 1Click lists (for Solana, 1Click's transaction).",
  },
  {
    value: "refunded",
    label: "Refunded",
    hint: "The deposit came back to the wallet that paid it. Needs the origin chain to show the refund in a transaction 1Click lists.",
  },
  {
    value: "never_deposited",
    label: "Never deposited",
    hint: "The deposit never left the paying wallet. Needs the chain to show no deposit and a company wallet send that can no longer run.",
  },
];

export const RESOLUTION_LABELS: Record<IntentQuoteResolution, string> = {
  delivered: "delivered",
  refunded: "refunded",
  never_deposited: "never deposited",
};

/**
 * Resolves a NEAR Intents quote under review (spec §6.8, §6.15): the
 * outcome and a reason, then the evidence and consequences the API found,
 * then a second confirmation. Nothing is ever sent.
 */
export function ResolveQuoteFlow({
  quoteId,
  paidByMessage = false,
}: {
  quoteId: string;
  paidByMessage?: boolean;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [outcome, setOutcome] = useState<IntentQuoteResolution>("delivered");
  const [reason, setReason] = useState("");
  const [prepared, setPrepared] = useState<IntentQuoteResolvePrepared | null>(
    null,
  );

  const prepare = useMutation({
    mutationFn: () =>
      api.intentQuotes.prepareResolution(quoteId, { outcome, reason }),
    onSuccess: setPrepared,
  });

  const confirm = useMutation({
    mutationFn: (token: string) =>
      api.intentQuotes.confirmResolution(quoteId, token),
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
    const label = RESOLUTION_LABELS[prepared.outcome];
    return (
      <SecondConfirmation
        title={`Resolve as ${label}`}
        consequences={prepared.consequences}
        reason={prepared.reason}
        expiresAt={prepared.expiresAt}
        confirmLabel={`Confirm: resolve as ${label}`}
        pending={confirm.isPending}
        error={confirm.isError ? describeApiError(confirm.error) : null}
        onConfirm={() => confirm.mutate(prepared.token)}
        onBack={() => {
          setPrepared(null);
          confirm.reset();
        }}
      >
        <QuoteEvidenceSummary
          evidence={prepared.evidence}
          paidByMessage={paidByMessage}
        />
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
        {OUTCOMES.map((option) => (
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
          {prepare.isPending ? "Checking 1Click and the chains…" : "Review"}
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

function Transfers({
  transfers,
  none,
}: {
  transfers: readonly QuoteTransfer[];
  none: string;
}) {
  if (transfers.length === 0) return <>{none}</>;
  return (
    <>
      {transfers.map((transfer) => (
        <span key={`${transfer.txHash}:${transfer.to}`} className="block">
          {formatUsdc(transfer.usdcAmount)} on{" "}
          {PAYEE_CHAIN_NAMES[transfer.chain]} in{" "}
          <span className="font-mono text-xs break-all">{transfer.txHash}</span>
        </span>
      ))}
    </>
  );
}

/** What 1Click and the chains show of a quote, as the API read it. */
export function QuoteEvidenceSummary({
  evidence,
  paidByMessage = false,
}: {
  evidence: IntentQuoteEvidence;
  /** Paid out of a confidential account: no chain shows its deposit or refund. */
  paidByMessage?: boolean;
}) {
  return (
    <dl className="mt-4 grid grid-cols-1 gap-x-4 gap-y-3 text-sm sm:grid-cols-[12rem_minmax(0,1fr)]">
      <dt className="text-muted-foreground">1Click says</dt>
      <dd>
        {evidence.oneClickStatus ?? "— (not asked yet)"}
        {evidence.depositedAmount
          ? `, ${formatUsdc(evidence.depositedAmount)} deposited`
          : ""}
      </dd>
      <dt className="text-muted-foreground">Deposit</dt>
      <dd>
        {paidByMessage ? (
          "Paid by a signed message, so no chain shows it"
        ) : (
          <Transfers transfers={evidence.deposits} none="None found on chain" />
        )}
      </dd>
      <dt className="text-muted-foreground">Delivered to the recipient</dt>
      <dd>
        {evidence.unreadDeliveries.length > 0 ? (
          evidence.unreadDeliveries.map((txHash) => (
            <span key={txHash} className="block">
              1Click lists{" "}
              <span className="font-mono text-xs break-all">{txHash}</span>{" "}
              (Solana, not read here)
            </span>
          ))
        ) : (
          <Transfers
            transfers={evidence.deliveries}
            none="None in the transactions 1Click lists"
          />
        )}
      </dd>
      <dt className="text-muted-foreground">Back to the refund address</dt>
      <dd>
        {paidByMessage ? (
          "Back into the company's account, which isn't visible here"
        ) : (
          <Transfers
            transfers={evidence.refunds}
            none="None in the transactions 1Click lists"
          />
        )}
      </dd>
      {paidByMessage ? null : (
        <>
          <dt className="text-muted-foreground">Company wallet sends</dt>
          <dd>
            {evidence.companyWalletSends.length === 0
              ? "None"
              : evidence.companyWalletSends.map((send) => (
                  <span key={send.id} className="block">
                    {send.status}, {formatUsdc(send.usdcAmount)}, until block{" "}
                    {send.maxBlockHeight}
                    {send.txHash ? (
                      <>
                        {" "}
                        in{" "}
                        <span className="font-mono text-xs break-all">
                          {send.txHash}
                        </span>
                      </>
                    ) : null}
                  </span>
                ))}
          </dd>
        </>
      )}
      <dt className="text-muted-foreground">Payouts</dt>
      <dd>
        {evidence.payouts.length === 0
          ? "None"
          : evidence.payouts.map((payout) => (
              <span key={payout.id} className="block">
                <span className="font-mono text-xs">{payout.id}</span>{" "}
                {payout.status.replace("_", " ")}
                {payout.ledger.length > 0
                  ? `, ledger ${payout.ledger.map((row) => formatUsdc(row.usdcAmount)).join(", ")}`
                  : ""}
              </span>
            ))}
      </dd>
    </dl>
  );
}
