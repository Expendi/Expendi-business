"use client";

import type { JSX } from "react";
import {
  KeyRoundIcon,
  MailIcon,
  RotateCcwIcon,
  ShieldAlertIcon,
} from "lucide-react";

import type { Payee, PayeeChangeChallenge } from "@expendi-business/shared";

import type { DetailRow } from "~/features/payees/payee-display";
import {
  Callout,
  DetailItem,
  DetailList,
} from "~/components/data/detail-sheet";
import {
  CHANGE_WARNING,
  detailRows,
  KIND_LABELS,
  listSummary,
} from "~/features/payees/payee-display";
import { useBankName } from "~/features/payees/payees-api";
import { PASSKEY_HINT, SheetNote } from "~/features/payment-ui";

/**
 * Exactly the change the API will apply, as it echoed it back, for the
 * admin to sign with their passkey (port of the app's
 * `PayeeChangeReview`). The sheet's footer holds Confirm and Edit.
 */
export function PayeeReview({
  organizationId,
  challenge,
  currentPayee,
  memberName,
  payoutPhoneConfirmed,
  cancelled,
  error,
}: {
  organizationId: string;
  challenge: PayeeChangeChallenge;
  /** The payee being changed; null when adding one. */
  currentPayee: Payee | null;
  /** The linked team member's name, for a new employee payee. */
  memberName: string | null;
  payoutPhoneConfirmed: boolean | null;
  /** The admin backed out of the passkey prompt; nothing was saved. */
  cancelled: boolean;
  error: string | null;
}): JSX.Element {
  const { change } = challenge;
  const creating = change.action === "create";
  const details = creating ? (change.payee.details ?? null) : change.details;
  const bankName = useBankName(organizationId, details);
  const currentDetails = currentPayee?.details ?? null;
  const currentBankName = useBankName(organizationId, currentDetails);

  const summary: DetailRow[] = creating
    ? [
        { label: "Name", value: change.payee.name },
        { label: "Kind", value: KIND_LABELS[change.payee.kind] },
        ...(memberName ? [{ label: "Team member", value: memberName }] : []),
      ]
    : [{ label: "Payee", value: currentPayee?.name ?? "This payee" }];
  const rows = details
    ? [...summary, ...detailRows(details, { bankName, payoutPhoneConfirmed })]
    : summary;

  return (
    <>
      <p className="text-gray-600">
        Check every character. This is exactly what your passkey confirms.
      </p>
      <DetailList>
        {rows.map((row) => (
          <DetailItem key={row.label} label={row.label}>
            {row.value}
          </DetailItem>
        ))}
      </DetailList>
      {currentPayee && currentDetails ? (
        <SheetNote icon={RotateCcwIcon}>
          Replaces: {listSummary(currentPayee, currentBankName)}
        </SheetNote>
      ) : null}
      <Callout tone="warn" icon={creating ? MailIcon : ShieldAlertIcon}>
        <p>
          {creating
            ? "Every admin will get an email about this new payee."
            : CHANGE_WARNING}
        </p>
      </Callout>
      <SheetNote icon={KeyRoundIcon}>{PASSKEY_HINT}</SheetNote>
      {cancelled ? <SheetNote>Cancelled. Nothing was saved.</SheetNote> : null}
      {error ? (
        <div role="alert">
          <Callout tone="error">
            <p>{error}</p>
          </Callout>
        </div>
      ) : null}
    </>
  );
}
