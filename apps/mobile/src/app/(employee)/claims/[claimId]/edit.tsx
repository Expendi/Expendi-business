import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";

import type { ClaimDetail } from "@expendi-business/shared";

import type { DraftField } from "~/features/claims/draft";
import type { AttachedSms } from "~/features/claims/sms-evidence";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { ClaimEditor } from "~/features/claims/claim-editor";
import { RejectionNotice } from "~/features/claims/rejection-notice";
import { RequireCompany } from "~/features/claims/require-company";
import { useClaim, useUpdateClaim } from "~/features/claims/use-claims";
import { describeApiError } from "~/lib/api";
import { formatKesCents } from "~/lib/money";

export default function EditClaimRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <EditClaimScreen company={company} />}
    </RequireCompany>
  );
}

function EditClaimScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { claimId } = useLocalSearchParams<{ claimId: string }>();
  const claim = useClaim(company.organizationId, claimId);

  if (claim.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the claim" />
      </Screen>
    );
  }
  if (claim.isError || !claim.data.canEdit) {
    return (
      <Screen belowHeader>
        <ErrorMessage
          message={
            claim.isError
              ? describeApiError(claim.error)
              : "This claim can’t be changed after it’s approved."
          }
        />
        <Button label="Back to the claim" onPress={() => router.back()} />
      </Screen>
    );
  }
  return (
    <Screen belowHeader>
      <ClaimEdit
        organizationId={company.organizationId}
        claim={claim.data}
        onSaved={() => router.back()}
      />
    </Screen>
  );
}

/** An edit starts from the person's own values; a new receipt doesn't replace them. */
const EDIT_TYPED: readonly DraftField[] = [
  "merchant",
  "amount",
  "spentOn",
  "categoryId",
  "description",
  "mpesaCode",
  "etimsInvoiceNumber",
  "etimsSupplierPin",
  "etimsQrPayload",
];

function smsOf(claim: ClaimDetail): AttachedSms | null {
  const sms = claim.receipts.find((receipt) => receipt.kind === "sms_text");
  return sms?.kind === "sms_text"
    ? { receiptFileId: sms.id, text: sms.text }
    : null;
}

function ClaimEdit({
  organizationId,
  claim,
  onSaved,
}: {
  organizationId: string;
  claim: ClaimDetail;
  onSaved: () => void;
}): JSX.Element {
  const update = useUpdateClaim(organizationId, claim.id);
  const resubmitting = claim.status === "rejected";

  return (
    <ClaimEditor
      organizationId={organizationId}
      initialDraft={{
        merchant: claim.merchant,
        amount: formatKesCents(claim.amountKes),
        spentOn: claim.spentOn,
        categoryId: claim.category.id,
        description: claim.description ?? "",
        mpesaCode: claim.mpesaCode ?? "",
        etimsInvoiceNumber: claim.etimsInvoiceNumber ?? "",
        etimsSupplierPin: claim.etimsSupplierPin ?? "",
        etimsQrPayload: claim.etimsQrPayload,
      }}
      initialReceipts={claim.receipts.flatMap((receipt) =>
        receipt.kind === "sms_text"
          ? []
          : [
              {
                key: receipt.id,
                status: "ready" as const,
                previewUri: receipt.url,
                receiptFileId: receipt.id,
              },
            ],
      )}
      initialSms={smsOf(claim)}
      initialTyped={EDIT_TYPED}
      currentCategory={claim.category}
      intro={
        resubmitting && claim.rejectedReason ? (
          <RejectionNotice reason={claim.rejectedReason} />
        ) : undefined
      }
      submitLabel={resubmitting ? "Resubmit claim" : "Save changes"}
      submitting={update.isPending}
      submitError={update.error}
      onSubmit={(request) => update.mutate(request, { onSuccess: onSaved })}
    />
  );
}
