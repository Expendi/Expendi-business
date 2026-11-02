import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";

import type { Company } from "~/features/company/company-provider";
import { Screen } from "~/components/screen";
import { localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  BLANK_EXTRAS,
  blankSpendingDraft,
} from "~/features/spending/spending-draft";
import { SpendingEditor } from "~/features/spending/spending-editor";
import { useRecordCompanySpending } from "~/features/spending/use-spending";

export default function RecordSpendingRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <RecordSpendingScreen company={company} />}
    </RequireAdmin>
  );
}

function RecordSpendingScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const record = useRecordCompanySpending(company.organizationId);
  const [today] = useState(() => localIsoDate(new Date()));

  return (
    <Screen belowHeader>
      <SpendingEditor
        organizationId={company.organizationId}
        mode={{
          kind: "record",
          onSubmit: (request) =>
            record.mutate(request, {
              onSuccess: (spending) =>
                router.replace({
                  pathname: "/spending/[spendingId]",
                  params: { spendingId: spending.id },
                }),
            }),
        }}
        initialDraft={blankSpendingDraft(today)}
        initialExtras={BLANK_EXTRAS}
        submitLabel="Save spending"
        submitting={record.isPending}
        submitError={record.error}
      />
    </Screen>
  );
}
