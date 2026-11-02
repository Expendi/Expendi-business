import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator } from "react-native";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { CompanyPinCard } from "~/features/claims/company-pin-card";
import { localIsoDate } from "~/features/claims/dates";
import { RequireCompany } from "~/features/claims/require-company";
import {
  blankFloatSpendingDraft,
  FloatSpendingEditor,
} from "~/features/petty-cash/float-spending-editor";
import {
  useFloat,
  useRecordFloatSpending,
} from "~/features/petty-cash/use-floats";
import { describeApiError } from "~/lib/api";

export default function PaidFromPettyCashRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <PaidFromPettyCashScreen company={company} />}
    </RequireCompany>
  );
}

function PaidFromPettyCashScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const router = useRouter();
  const { floatId } = useLocalSearchParams<{ floatId: string }>();
  const float = useFloat(company.organizationId, floatId);
  const record = useRecordFloatSpending(company.organizationId, floatId);
  const [today] = useState(() => localIsoDate(new Date()));

  if (float.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading your float" />
      </Screen>
    );
  }
  if (float.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(float.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={float.isFetching}
          onPress={() => void float.refetch()}
        />
      </Screen>
    );
  }
  return (
    <Screen belowHeader>
      <CompanyPinCard organizationId={company.organizationId} />
      <FloatSpendingEditor
        organizationId={company.organizationId}
        float={float.data}
        initialDraft={blankFloatSpendingDraft(today)}
        submitting={record.isPending}
        submitError={record.error}
        onSubmit={(request) =>
          record.mutate(request, {
            onSuccess: (result) => {
              const claim = result.overspendClaim;
              if (claim) {
                router.replace({
                  pathname: "/claims/[claimId]",
                  params: { claimId: claim.id },
                });
              } else {
                router.back();
              }
            },
          })
        }
      />
    </Screen>
  );
}
