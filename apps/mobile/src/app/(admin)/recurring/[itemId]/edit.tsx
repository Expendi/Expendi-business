import type { JSX } from "react";
import { useLocalSearchParams, useRouter } from "expo-router";
import { ActivityIndicator } from "react-native";

import type { RecurringItem } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { RequireAdmin } from "~/features/company/require-admin";
import { draftFromItem } from "~/features/recurring/recurring-draft";
import { RecurringForm } from "~/features/recurring/recurring-form";
import {
  useRecurringItem,
  useUpdateRecurringItem,
} from "~/features/recurring/use-recurring";
import { describeApiError } from "~/lib/api";

export default function EditRecurringItemRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <EditRecurringItemScreen company={company} />}
    </RequireAdmin>
  );
}

function EditRecurringItemScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const { itemId } = useLocalSearchParams<{ itemId: string }>();
  const item = useRecurringItem(company.organizationId, itemId);

  if (item.isPending) {
    return (
      <Screen belowHeader>
        <ActivityIndicator accessibilityLabel="Loading the recurring payment" />
      </Screen>
    );
  }
  if (item.isError) {
    return (
      <Screen belowHeader>
        <ErrorMessage message={describeApiError(item.error)} />
        <Button
          label="Try again"
          variant="secondary"
          loading={item.isFetching}
          onPress={() => void item.refetch()}
        />
      </Screen>
    );
  }
  return <EditRecurringItemForm company={company} item={item.data} />;
}

function EditRecurringItemForm({
  company,
  item,
}: {
  company: Company;
  item: RecurringItem;
}): JSX.Element {
  const router = useRouter();
  const update = useUpdateRecurringItem(company.organizationId, item.id);

  return (
    <Screen belowHeader>
      <RecurringForm
        organizationId={company.organizationId}
        item={item}
        initialDraft={draftFromItem(item)}
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
