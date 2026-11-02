import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { Text, View } from "react-native";

import type { ClaimDetail } from "@expendi-business/shared";
import {
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from "@expendi-business/shared";

import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { TextField } from "~/components/text-field";
import { describeApiError } from "~/lib/api";
import { formatIsoDate, localIsoDate } from "./dates";
import { useRejectClaim } from "./use-claim-approval";

const claimantOf = (claim: ClaimDetail): string =>
  claim.submittedBy.name ?? claim.submittedBy.email;

const dayOf = (dateTime: string): string =>
  formatIsoDate(localIsoDate(new Date(dateTime)));

/** What happens to the employee's money once a claim is approved (spec §5). */
const PAYMENT_NOTES: Partial<Record<ClaimDetail["status"], string>> = {
  paying:
    "Approved. The money is on its way to your M-Pesa and usually arrives within a few minutes.",
  paid: "Paid to your M-Pesa.",
  payout_failed:
    "The payment didn’t go through. Your admin can retry it; nothing was taken from you.",
};

/** For the person who claimed: where their payment stands. */
export function PaymentNote({
  claim,
}: {
  claim: ClaimDetail;
}): JSX.Element | null {
  const note = PAYMENT_NOTES[claim.status];
  if (!note) return null;
  return (
    <View
      accessibilityRole="summary"
      className={`rounded-xl px-4 py-3 ${claim.status === "payout_failed" ? "border border-amber-200 bg-amber-50" : "bg-gray-50"}`}
    >
      <Text className="text-base text-gray-900">{note}</Text>
    </View>
  );
}

/** Who approved it and when, and whether they approved their own claim (spec §4). */
export function ApprovalDetails({
  claim,
}: {
  claim: ClaimDetail;
}): JSX.Element | null {
  if (!claim.approvedAt) return null;
  return (
    <View className="gap-2">
      {claim.selfApproved ? (
        <Badge label="Self-approved" tone="warning" />
      ) : null}
      <Text className="text-sm text-gray-600">
        Approved {dayOf(claim.approvedAt)}
        {claim.paidAt ? ` · Paid ${dayOf(claim.paidAt)}` : ""}
      </Text>
    </View>
  );
}

/**
 * The admin's actions on a claim (spec §6.7, §6.8): Approve & pay or reject
 * one waiting for approval, retry one whose payment failed.
 */
export function AdminClaimActions({
  organizationId,
  claim,
}: {
  organizationId: string;
  claim: ClaimDetail;
}): JSX.Element | null {
  const router = useRouter();

  if (claim.status === "payout_failed") {
    return (
      <View className="gap-4">
        <View className="gap-1 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <Text className="text-sm font-semibold text-amber-800">
            The payment failed
          </Text>
          <Text className="text-base text-gray-900">
            {claim.payout?.failureReason ??
              "No money reached M-Pesa. You can retry it."}
          </Text>
        </View>
        <Button
          label="Retry payment"
          onPress={() =>
            router.push({
              pathname: "/approvals/[claimId]/pay",
              params: { claimId: claim.id, retry: "1" },
            })
          }
        />
      </View>
    );
  }
  if (claim.status !== "submitted") return null;

  const canPay = claim.submittedBy.payoutPhoneConfirmed;
  return (
    <View className="gap-3">
      {canPay ? null : (
        <View className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
          <Text className="text-base text-amber-900">
            {claimantOf(claim)} hasn’t confirmed an M-Pesa number yet. Approve &
            pay is blocked until they do.
          </Text>
        </View>
      )}
      <Button
        label="Approve & pay"
        disabled={!canPay}
        onPress={() =>
          router.push({
            pathname: "/approvals/[claimId]/pay",
            params: { claimId: claim.id },
          })
        }
      />
      <RejectClaim organizationId={organizationId} claim={claim} />
    </View>
  );
}

function RejectClaim({
  organizationId,
  claim,
}: {
  organizationId: string;
  claim: ClaimDetail;
}): JSX.Element {
  const reject = useRejectClaim(organizationId, claim.id);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  function close(): void {
    setOpen(false);
    setReason("");
    setError(null);
    reject.reset();
  }

  function handleReject(): void {
    const trimmed = reason.trim();
    if (trimmed.length < REJECTION_REASON_MIN_LENGTH) {
      setError("Say why in a few words, so they know what to fix.");
      return;
    }
    setError(null);
    reject.mutate({ reason: trimmed }, { onSuccess: close });
  }

  return (
    <>
      <Button
        label="Reject"
        variant="secondary"
        onPress={() => setOpen(true)}
      />
      <ConfirmSheet
        visible={open}
        title="Reject this claim?"
        message={`${claimantOf(claim)} sees your reason, and can fix the claim and resubmit it.`}
        confirmLabel="Reject claim"
        dismissLabel="Keep claim"
        busy={reject.isPending}
        error={
          error ?? (reject.isError ? describeApiError(reject.error) : null)
        }
        onConfirm={handleReject}
        onCancel={close}
      >
        <TextField
          label="Why are you rejecting it?"
          value={reason}
          onChangeText={setReason}
          placeholder="The receipt is unreadable"
          maxLength={REJECTION_REASON_MAX_LENGTH}
          multiline
        />
      </ConfirmSheet>
    </>
  );
}
