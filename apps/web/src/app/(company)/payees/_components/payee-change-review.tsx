"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { Payee, PayeeChangeChallenge } from "@expendi-business/shared";

import type { DetailRow } from "~/features/payees/payee-display";
import type { PayeeChangeRequest } from "~/features/payees/payees-api";
import {
  alertClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import {
  CHANGE_WARNING,
  detailRows,
  KIND_LABELS,
  listSummary,
} from "~/features/payees/payee-display";
import {
  useBankName,
  useConfirmPayeeChange,
  useRequestPayeeChange,
} from "~/features/payees/payees-api";
import { PASSKEY_HINT, PreviewRows } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";

/**
 * Shows exactly the change the API will apply, as it echoed it back, then
 * signs it with the admin's passkey (port of the app's
 * `PayeeChangeReview`). Backing out of the passkey prompt saves nothing. A
 * failed confirmation can't be reused, so the admin starts again with a
 * fresh one.
 */
export function PayeeChangeReview({
  organizationId,
  request,
  challenge: firstChallenge,
  currentPayee,
  memberName,
  payoutPhoneConfirmed,
  onEdit,
  onConfirmed,
}: {
  organizationId: string;
  /** What the admin entered, to ask for a fresh challenge if this one fails. */
  request: PayeeChangeRequest;
  challenge: PayeeChangeChallenge;
  /** The payee being changed; null when adding one. */
  currentPayee: Payee | null;
  /** The linked team member's name, for an employee payee. */
  memberName: string | null;
  payoutPhoneConfirmed: boolean | null;
  onEdit: () => void;
  onConfirmed: (payee: Payee) => void;
}): JSX.Element {
  const [challenge, setChallenge] = useState(firstChallenge);
  const confirm = useConfirmPayeeChange(organizationId);
  const renew = useRequestPayeeChange(organizationId);
  const { change } = challenge;
  const details =
    change.action === "create"
      ? (change.payee.details ?? null)
      : change.details;
  const bankName = useBankName(organizationId, details);
  const currentDetails = currentPayee?.details ?? null;
  const currentBankName = useBankName(organizationId, currentDetails);
  const busy = confirm.isPending || renew.isPending;

  const summary: DetailRow[] =
    change.action === "create"
      ? [
          { label: "Name", value: change.payee.name },
          { label: "Kind", value: KIND_LABELS[change.payee.kind] },
          ...(memberName ? [{ label: "Team member", value: memberName }] : []),
        ]
      : [{ label: "Payee", value: currentPayee?.name ?? "This payee" }];
  const rows = details
    ? [...summary, ...detailRows(details, { bankName, payoutPhoneConfirmed })]
    : summary;

  function handleConfirm(): void {
    confirm.mutate(challenge, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") onConfirmed(outcome.result);
      },
    });
  }

  function handleStartAgain(): void {
    renew.mutate(request, {
      onSuccess: (response) => {
        if (response.status === "created") {
          onConfirmed(response.payee);
          return;
        }
        confirm.reset();
        setChallenge(response);
      },
    });
  }

  return (
    <section
      aria-label="Review the change"
      className="rounded-lg border border-brand-500 bg-white p-4"
    >
      <h2 className="text-base font-semibold">
        {change.action === "create"
          ? "Review the new payee"
          : "Review the new payment details"}
      </h2>
      <p className="mt-1 text-sm text-stone-600">
        Check every character. This is exactly what your passkey confirms.
      </p>
      <div className="mt-4 rounded-md border border-stone-200 p-3">
        <PreviewRows rows={rows} />
      </div>
      {currentPayee && currentDetails ? (
        <p className="mt-3 text-sm text-stone-600">
          Replaces: {listSummary(currentPayee, currentBankName)}
        </p>
      ) : null}
      <p className="mt-3 text-sm font-medium text-amber-800">
        {change.action === "create"
          ? "Every admin will get an email about this new payee."
          : CHANGE_WARNING}
      </p>
      <p className="mt-3 text-sm text-stone-600">{PASSKEY_HINT}</p>

      {confirm.data?.status === "cancelled" ? (
        <p className="mt-3 text-sm text-stone-600">
          Cancelled. Nothing was saved.
        </p>
      ) : null}
      {confirm.isError ? (
        <p className={alertClass} role="alert">
          {describeApprovalError(confirm.error)}
        </p>
      ) : null}
      {renew.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(renew.error)}
        </p>
      ) : null}

      <div className="mt-4 flex gap-3">
        {confirm.isError ? (
          <button
            type="button"
            onClick={handleStartAgain}
            disabled={busy}
            className={primaryButton}
          >
            {renew.isPending ? "Starting again…" : "Start again"}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className={primaryButton}
          >
            {confirm.isPending
              ? "Waiting for your passkey…"
              : "Confirm with passkey"}
          </button>
        )}
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className={secondaryButton}
        >
          Edit
        </button>
      </div>
    </section>
  );
}
