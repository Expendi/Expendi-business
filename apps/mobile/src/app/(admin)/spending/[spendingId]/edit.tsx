import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";

import type { CompanySpendingDetail } from "@expendi-business/shared";

import type { DraftField } from "~/features/claims/draft";
import type { AttachedSms } from "~/features/claims/sms-evidence";
import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  draftFromSpending,
  extrasFromSpending,
} from "~/features/spending/spending-draft";
import { SpendingEditor } from "~/features/spending/spending-editor";
import {
  useCompanySpending,
  useUpdateCompanySpending,
} from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";

export default function EditSpendingRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <EditSpendingScreen company={company} />}
    </RequireAdmin>
  );
}

function EditSpendingScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const { spendingId } = useLocalSearchParams<{ spendingId: string }>();
  const spending = useCompanySpending(company.organizationId, spendingId);

  if (spending.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the spending" />
      </Screen>
    );
  }
  if (spending.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(spending.error)} />
        <Button label="Back" onPress={() => router.back()} />
      </Screen>
    );
  }
  return (
    <Screen belowHeader>
      <SpendingEdit
        organizationId={company.organizationId}
        spending={spending.data}
        onSaved={() => router.back()}
      />
    </Screen>
  );
}

/** An edit starts from the admin's own values; a new receipt doesn't replace them. */
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

function smsOf(spending: CompanySpendingDetail): AttachedSms | null {
  const sms = spending.receipts.find((receipt) => receipt.kind === "sms_text");
  return sms?.kind === "sms_text"
    ? { receiptFileId: sms.id, text: sms.text }
    : null;
}

function SpendingEdit({
  organizationId,
  spending,
  onSaved,
}: {
  organizationId: string;
  spending: CompanySpendingDetail;
  onSaved: () => void;
}): JSX.Element {
  const update = useUpdateCompanySpending(organizationId, spending.id);
  return (
    <SpendingEditor
      organizationId={organizationId}
      mode={{
        kind: "edit",
        spending,
        onSubmit: (request) => update.mutate(request, { onSuccess: onSaved }),
      }}
      initialDraft={draftFromSpending(spending)}
      initialExtras={extrasFromSpending(spending)}
      initialReceipts={spending.receipts.flatMap((receipt) =>
        receipt.kind === "sms_text" || receipt.billRole !== null
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
      initialSms={smsOf(spending)}
      initialTyped={EDIT_TYPED}
      currentCategory={spending.category}
      submitLabel="Save changes"
      submitting={update.isPending}
      submitError={update.error}
    />
  );
}
