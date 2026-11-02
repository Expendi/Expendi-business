"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { Claim } from "@expendi-business/shared";
import {
  rejectClaimRequestSchema,
  REJECTION_REASON_MAX_LENGTH,
} from "@expendi-business/shared";

import { ETIMS_STATUS_LABELS, WarningList } from "~/components/expense-status";
import { ReceiptViewer } from "~/components/receipt-viewer";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";

export interface ClaimSelection {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

/**
 * One claim in the queue with its receipt beside it (spec §6.7 step 1):
 * the fields, any warnings, and for a failed payment why it failed.
 * `selection` and `actions` are for admins only.
 */
export function ClaimCard({
  organizationId,
  claim,
  blockedReason,
  selection,
  actions,
}: {
  organizationId: string;
  claim: Claim;
  blockedReason: string | null;
  selection: ClaimSelection | null;
  actions: ReactNode;
}): JSX.Element {
  const { api } = useAuth();
  const detail = useQuery({
    queryKey: queryKeys.claim(organizationId, claim.id),
    queryFn: () => api.getClaim(organizationId, claim.id),
  });
  const person = claim.submittedBy.name ?? claim.submittedBy.email;

  return (
    <article
      aria-label={`${claim.merchant}, ${person}`}
      className={`rounded-lg border bg-white p-4 ${selection?.checked ? "border-brand-500" : "border-stone-200"}`}
    >
      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            {selection ? (
              <input
                type="checkbox"
                aria-label={`Select ${claim.merchant}, ${person}`}
                checked={selection.checked}
                disabled={selection.disabled}
                onChange={selection.onToggle}
                className="mt-1 size-4 accent-brand-700"
              />
            ) : null}
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-semibold break-words">
                {claim.merchant}
              </h3>
              <p className="text-sm text-stone-600">
                {person} · {formatIsoDate(claim.spentOn)} ·{" "}
                {claim.category.name}
              </p>
            </div>
            <p className="text-lg font-semibold whitespace-nowrap tabular-nums">
              KES {formatKesCents(claim.amountKes)}
            </p>
          </div>

          <WarningList warnings={claim.warnings} />
          {blockedReason ? (
            <p className="rounded-md bg-stone-100 px-3 py-2 text-sm text-stone-700">
              {blockedReason}
            </p>
          ) : null}
          {detail.data?.payout?.failureReason ? (
            <p className="rounded-md bg-error-50 px-3 py-2 text-sm text-error-700">
              Payment failed: {detail.data.payout.failureReason}
            </p>
          ) : null}

          {claim.description ? (
            <p className="text-sm whitespace-pre-wrap text-stone-700">
              {claim.description}
            </p>
          ) : null}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-stone-500">M-Pesa code</dt>
              <dd className="font-mono">{claim.mpesaCode ?? "None"}</dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">eTIMS</dt>
              <dd>
                {ETIMS_STATUS_LABELS[claim.etimsStatus]}
                {claim.etimsInvoiceNumber ? (
                  <span className="block text-xs text-stone-600">
                    Invoice {claim.etimsInvoiceNumber}
                  </span>
                ) : null}
              </dd>
            </div>
          </dl>
          {actions}
        </div>

        <div>
          {detail.isPending ? (
            <p className="text-sm text-stone-500">Loading the receipt…</p>
          ) : detail.isError ? (
            <div className="text-sm text-error-700" role="alert">
              <p>{describeApiError(detail.error)}</p>
              <button
                type="button"
                onClick={() => void detail.refetch()}
                className={`mt-2 ${secondaryButton}`}
              >
                Try again
              </button>
            </div>
          ) : (
            <ReceiptViewer receipts={detail.data.receipts} />
          )}
        </div>
      </div>
    </article>
  );
}

/** Rejecting needs a reason the employee sees, so they know what to fix (spec §5). */
export function RejectClaim({
  organizationId,
  claimId,
  disabled,
  onRejected,
}: {
  organizationId: string;
  claimId: string;
  disabled: boolean;
  onRejected: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const reject = useMutation({
    mutationFn: (valid: string) =>
      api.rejectClaim(organizationId, claimId, valid),
    onSuccess: async () => {
      onRejected();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.claims(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.expenses(organizationId),
        }),
      ]);
    },
  });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={disabled}
        className={secondaryButton}
      >
        Reject
      </button>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = rejectClaimRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Say why it's rejected.");
      return;
    }
    setInvalid(null);
    reject.mutate(parsed.data.reason);
  }

  const reasonId = `reject-${claimId}`;
  return (
    <form onSubmit={onSubmit} className="space-y-2">
      <label htmlFor={reasonId} className="block text-sm">
        Why are you rejecting it? They&apos;ll see this.
      </label>
      <textarea
        id={reasonId}
        value={reason}
        onChange={(event) => setReason(event.target.value)}
        maxLength={REJECTION_REASON_MAX_LENGTH}
        rows={3}
        className={inputClass}
      />
      {invalid ? <p className="text-sm text-error-700">{invalid}</p> : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={disabled || reject.isPending}
          className={primaryButton}
        >
          {reject.isPending ? "Rejecting…" : "Reject claim"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={reject.isPending}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
      {reject.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(reject.error)}
        </p>
      ) : null}
    </form>
  );
}
