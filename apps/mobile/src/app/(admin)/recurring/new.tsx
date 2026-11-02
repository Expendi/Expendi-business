import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";

import type { Company } from "~/features/company/company-provider";
import { Screen } from "~/components/screen";
import { localIsoDate } from "~/features/claims/dates";
import { RequireAdmin } from "~/features/company/require-admin";
import { blankDraft } from "~/features/recurring/recurring-draft";
import { RecurringForm } from "~/features/recurring/recurring-form";
import { useCreateRecurringItem } from "~/features/recurring/use-recurring";

export default function NewRecurringItemRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <NewRecurringItemScreen company={company} />}
    </RequireAdmin>
  );
}

function NewRecurringItemScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const router = useRouter();
  const create = useCreateRecurringItem(company.organizationId);
  const [today] = useState(() => localIsoDate(new Date()));

  return (
    <Screen belowHeader>
      <RecurringForm
        organizationId={company.organizationId}
        initialDraft={blankDraft(today)}
        submitLabel="Set up payment"
        submitting={create.isPending}
        submitError={create.error}
        onSubmit={(request) =>
          create.mutate(request, {
            onSuccess: (item) =>
              router.replace({
                pathname: "/recurring/[itemId]",
                params: { itemId: item.id },
              }),
          })
        }
      />
    </Screen>
  );
}
