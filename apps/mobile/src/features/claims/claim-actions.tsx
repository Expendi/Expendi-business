import type { JSX } from "react";
import { useRouter } from "expo-router";
import { CircleAlert, ScanFace } from "lucide-react-native";
import { useState } from "react";
import { View } from "react-native";

import type { ClaimDetail } from "@expendi-business/shared";
import {
  REJECTION_REASON_MAX_LENGTH,
  REJECTION_REASON_MIN_LENGTH,
} from "@expendi-business/shared";

import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { CappedText, Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { describeApiError } from "~/lib/api";
import { colors } from "~/theme/colors";
import { formatShortDate, localIsoDate } from "./dates";
import { useRejectClaim } from "./use-claim-approval";

const claimantOf = (claim: ClaimDetail): string =>
  claim.submittedBy.name ?? claim.submittedBy.email;

const dayOf = (dateTime: string): string =>
  formatShortDate(
    localIsoDate(new Date(dateTime)),
    localIsoDate(new Date()),
  );

/** What happens to the employee's money once a reimbursement is approved (spec §5). */
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
      className={`rounded-2xl p-4 ${claim.status === "payout_failed" ? "bg-error-50" : "bg-gray-50"}`}
    >
      <Text className="text-[15px] leading-[21px] text-gray-900">{note}</Text>
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
        <View className="self-start rounded-full bg-error-50 px-3 py-1">
          <CappedText
            size={13}
            lineHeight={18}
            maxScale={1.3}
            className="font-semibold text-error-700"
          >
            Self-approved
          </CappedText>
        </View>
      ) : null}
      <Text className="text-[14px] text-gray-600">
        Approved {dayOf(claim.approvedAt)}
        {claim.paidAt ? ` · Paid ${dayOf(claim.paidAt)}` : ""}
      </Text>
    </View>
  );
}

/**
 * What blocks or went wrong with paying, shown in the page above the
 * footer's actions: a failed payment's reason, or a missing payout number.
 */
export function AdminClaimNotice({
  claim,
}: {
  claim: ClaimDetail;
}): JSX.Element | null {
  if (claim.status === "payout_failed") {
    return (
      <View
        accessibilityRole="summary"
        className="flex-row items-start gap-3 rounded-2xl bg-error-50 p-4"
      >
        <CircleAlert
          size={20}
          strokeWidth={1.75}
          color={colors.error}
          accessible={false}
        />
        <View className="min-w-0 flex-1 gap-1">
          <Text className="text-[15px] font-semibold text-gray-900">
            The payment failed
          </Text>
          <Text selectable className="text-[15px] leading-[21px] text-gray-900">
            {claim.payout?.failureReason ??
              "No money reached M-Pesa. You can retry it."}
          </Text>
        </View>
      </View>
    );
  }
  if (claim.status === "submitted" && !claim.submittedBy.payoutPhoneConfirmed) {
    return (
      <View
        accessibilityRole="summary"
        className="flex-row items-start gap-3 rounded-2xl bg-brand-50 p-4"
      >
        <CircleAlert
          size={20}
          strokeWidth={1.75}
          color={colors.brandStrong}
          accessible={false}
        />
        <Text className="min-w-0 flex-1 text-[15px] leading-[21px] text-gray-900">
          {claimantOf(claim)} hasn’t confirmed an M-Pesa number yet. Approve and
          pay is blocked until they do.
        </Text>
      </View>
    );
  }
  return null;
}

/**
 * The admin's actions on a reimbursement (spec §6.7, §6.8): Approve and pay
 * or return one waiting for approval, retry one whose payment failed. Fills
 * the screen's fixed footer.
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
      <ActionFooter>
        <Button
          label="Retry payment"
          onPress={() =>
            router.push({
              pathname: "/approvals/[claimId]/pay",
              params: { claimId: claim.id, retry: "1" },
            })
          }
        />
      </ActionFooter>
    );
  }
  if (claim.status !== "submitted") return null;

  return (
    <ActionFooter>
      <View className="flex-row gap-3">
        <ReturnClaim organizationId={organizationId} claim={claim} />
        <Button
          className="flex-1"
          label="Approve and pay"
          disabled={!claim.submittedBy.payoutPhoneConfirmed}
          onPress={() =>
            router.push({
              pathname: "/approvals/[claimId]/pay",
              params: { claimId: claim.id },
            })
          }
        />
      </View>
    </ActionFooter>
  );
}

function ActionFooter({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <View className="gap-3">
      <View className="flex-row items-center justify-center gap-1.5">
        <ScanFace
          size={16}
          strokeWidth={1.75}
          color={colors.muted}
          accessible={false}
        />
        <Text className="text-[13px] text-gray-600">
          You’ll confirm with your passkey
        </Text>
      </View>
      {children}
    </View>
  );
}

function ReturnClaim({
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

  function handleReturn(): void {
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
        className="w-[116px]"
        label="Return"
        variant="secondary"
        onPress={() => setOpen(true)}
      />
      <ConfirmSheet
        visible={open}
        title="Return this reimbursement?"
        message={`${claimantOf(claim)} sees your reason, and can fix the reimbursement and resubmit it.`}
        confirmLabel="Return reimbursement"
        dismissLabel="Keep it"
        busy={reject.isPending}
        error={
          error ?? (reject.isError ? describeApiError(reject.error) : null)
        }
        onConfirm={handleReturn}
        onCancel={close}
      >
        <TextField
          label="Why are you returning it?"
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
