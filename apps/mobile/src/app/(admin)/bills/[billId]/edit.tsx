import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";

import type { BillDetail } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { draftFromBill } from "~/features/bills/bill-draft";
import { BillForm } from "~/features/bills/bill-form";
import { useBill, useUpdateBill } from "~/features/bills/use-bills";
import { RequireAdmin } from "~/features/company/require-admin";
import { describeApiError } from "~/lib/api";

export default function EditBillRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <EditBillScreen company={company} />}
    </RequireAdmin>
  );
}

function EditBillScreen({ company }: { company: Company }): JSX.Element {
  const { billId } = useLocalSearchParams<{ billId: string }>();
  const bill = useBill(company.organizationId, billId);

  if (bill.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the bill" />
      </Screen>
    );
  }
  if (bill.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(bill.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={bill.isFetching}
          onPress={() => void bill.refetch()}
        />
      </Screen>
    );
  }
  return <EditBillForm company={company} bill={bill.data} />;
}

function EditBillForm({
  company,
  bill,
}: {
  company: Company;
  bill: BillDetail;
}): JSX.Element {
  const router = useRouter();
  const update = useUpdateBill(company.organizationId, bill.id);

  return (
    <Screen belowHeader>
      <BillForm
        organizationId={company.organizationId}
        bill={bill}
        initialDraft={draftFromBill(bill)}
        submitLabel="Save changes"
        submitting={update.isPending}
        submitError={update.error}
        onSubmit={(changes) =>
          update.mutate(changes, { onSuccess: () => router.back() })
        }
      />
    </Screen>
  );
}
