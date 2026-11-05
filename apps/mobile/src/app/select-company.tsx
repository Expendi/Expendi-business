import type { JSX } from "react";
import { Redirect, useRouter } from "expo-router";
import { View } from "react-native";

import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ListRow } from "~/components/list-row";
import { LoadingScreen } from "~/components/loading-screen";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { AccountErrorScreen } from "~/features/company/account-error-screen";
import { useCompanySession } from "~/features/company/company-provider";
import { ROLE_LABELS } from "~/features/company/roles";

export default function SelectCompanyScreen(): JSX.Element {
  const router = useRouter();
  const { state, selectCompany, retry } = useCompanySession();

  if (state.status === "loading") {
    return <LoadingScreen label="Loading your companies" />;
  }
  if (state.status === "error") {
    return <AccountErrorScreen error={state.error} onRetry={retry} />;
  }
  if (state.status === "no-company") return <Redirect href="/create-company" />;

  const currentId =
    state.status === "ready" ? state.company.organizationId : null;

  function choose(organizationId: string): void {
    selectCompany(organizationId);
    router.dismissTo("/");
  }

  return (
    <Screen belowHeader>
      <Text className="text-base text-gray-600">
        You’re in more than one company. Pick the one to work in; this phone
        remembers your choice.
      </Text>
      <View className="gap-3">
        {state.companies.map((company) => (
          <ListRow
            key={company.organizationId}
            title={company.name}
            subtitle={ROLE_LABELS[company.role]}
            accessory={
              company.organizationId === currentId ? (
                <Badge label="Current" tone="success" />
              ) : undefined
            }
            onPress={() => choose(company.organizationId)}
          />
        ))}
      </View>
      <Button
        label="Create another company"
        variant="ghost"
        onPress={() => router.push("/create-company")}
      />
    </Screen>
  );
}
