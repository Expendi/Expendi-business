import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";

import type { Payee, PayeeChangeChallenge } from "@expendi-business/shared";

import type { DetailRow } from "./payee-display";
import type { PayeeChangeRequest } from "./use-payees";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Text } from "~/components/text";
import { describeApprovalError } from "~/features/approval";
import { describeApiError } from "~/lib/api";
import { DetailRowList } from "./detail-row-list";
import {
  CHANGE_WARNING,
  detailRows,
  KIND_LABELS,
  listSummary,
} from "./payee-display";
import {
  useBankName,
  useConfirmPayeeChange,
  useRequestPayeeChange,
} from "./use-payees";

interface PayeeChangeReviewProps {
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
}

/**
 * Shows exactly the change the API will apply, as it echoed it back, then
 * signs it with the admin's passkey. Backing out of the passkey prompt
 * stays here and saves nothing. A failed confirmation can't be reused, so
 * the admin starts again with a fresh one.
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
}: PayeeChangeReviewProps): JSX.Element {
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
    ? [
        ...summary,
        ...detailRows(details, {
          mask: false,
          bankName,
          payoutPhoneConfirmed,
        }),
      ]
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
    <View className="gap-6">
      <View className="gap-2">
        <Text
          accessibilityRole="header"
          className="text-2xl font-bold text-gray-900"
        >
          {change.action === "create"
            ? "Review the new payee"
            : "Review the new payment details"}
        </Text>
        <Text className="text-base text-gray-600">
          Check every character. This is exactly what your passkey confirms.
        </Text>
      </View>

      <DetailRowList rows={rows} />

      {currentPayee && currentDetails ? (
        <Text className="text-sm text-gray-600">
          Replaces: {listSummary(currentPayee, currentBankName)}
        </Text>
      ) : null}
      <Text className="text-sm font-medium text-amber-800">
        {change.action === "create"
          ? "Every admin will get an email about this new payee."
          : CHANGE_WARNING}
      </Text>

      {confirm.data?.status === "cancelled" ? (
        <Text className="text-sm text-gray-600">
          Cancelled. Nothing was saved.
        </Text>
      ) : null}
      <ErrorMessage
        message={confirm.isError ? describeApprovalError(confirm.error) : null}
      />
      <ErrorMessage
        message={renew.isError ? describeApiError(renew.error) : null}
      />

      <View className="gap-3">
        {confirm.isError ? (
          <Button
            label="Start again"
            loading={renew.isPending}
            onPress={handleStartAgain}
          />
        ) : (
          <Button
            label="Confirm with passkey"
            loading={confirm.isPending}
            onPress={handleConfirm}
          />
        )}
        <Button label="Edit" variant="ghost" disabled={busy} onPress={onEdit} />
      </View>
    </View>
  );
}
