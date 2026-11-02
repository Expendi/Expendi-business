import type { JSX } from "react";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";

import type { Payee, PayeeKind, PayeeMethod } from "@expendi-business/shared";
import { PAYEE_KINDS, PAYEE_METHODS } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import type { ChipOption } from "~/features/payees/filter-chips";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { FilterChips } from "~/features/payees/filter-chips";
import {
  changedRecently,
  KIND_LABELS,
  listSummary,
  matchesSearch,
  METHOD_LABELS,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import { usePayeeBanks, usePayees } from "~/features/payees/use-payees";
import { describeApiError } from "~/lib/api";

const ALL = "all";

const KIND_FILTERS: ChipOption<PayeeKind | typeof ALL>[] = [
  { value: ALL, label: "All" },
  ...PAYEE_KINDS.map((kind) => ({ value: kind, label: KIND_LABELS[kind] })),
];

const METHOD_FILTERS: ChipOption<PayeeMethod | typeof ALL>[] = [
  { value: ALL, label: "All" },
  ...PAYEE_METHODS.map((method) => ({
    value: method,
    label: METHOD_LABELS[method],
  })),
];

export default function PayeesRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PayeesScreen company={company} />}
    </RequireAdmin>
  );
}

function PayeesScreen({ company }: { company: Company }): JSX.Element {
  const router = useRouter();
  const [kind, setKind] = useState<PayeeKind | typeof ALL>(ALL);
  const [method, setMethod] = useState<PayeeMethod | typeof ALL>(ALL);
  const [archived, setArchived] = useState(false);
  const [search, setSearch] = useState("");
  const payees = usePayees(company.organizationId, {
    kind: kind === ALL ? null : kind,
    method: method === ALL ? null : method,
    archived,
  });
  const hasBankPayee =
    payees.data?.some((payee) => payee.details?.method === "bank") ?? false;
  const banks = usePayeeBanks(company.organizationId, {
    enabled: hasBankPayee,
  });
  const bankNames = new Map(banks.data?.map((bank) => [bank.code, bank.name]));
  const filtered = kind !== ALL || method !== ALL || archived;
  const shown =
    payees.data?.filter((payee) => matchesSearch(payee.name, search)) ?? [];

  return (
    <Screen
      belowHeader
      refreshing={payees.isRefetching}
      onRefresh={() => void payees.refetch()}
    >
      <Button label="Add a payee" onPress={() => router.push("/payees/new")} />

      <View className="gap-4">
        <TextField
          label="Search"
          value={search}
          onChangeText={setSearch}
          placeholder="Search by name"
          autoCorrect={false}
          returnKeyType="search"
        />
        <FilterChips
          label="Kind"
          options={KIND_FILTERS}
          value={kind}
          onChange={setKind}
        />
        <FilterChips
          label="Paid by"
          options={METHOD_FILTERS}
          value={method}
          onChange={setMethod}
        />
        <View className="min-h-14 flex-row items-center justify-between gap-3">
          <Text className="flex-1 text-base text-gray-900">
            Show archived payees
          </Text>
          <Switch
            accessibilityLabel="Show archived payees"
            value={archived}
            onValueChange={setArchived}
          />
        </View>
      </View>

      {payees.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading payees" />
      ) : payees.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(payees.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={payees.isFetching}
            onPress={() => void payees.refetch()}
          />
        </View>
      ) : shown.length === 0 ? (
        <Text className="text-base text-gray-600">
          {filtered || search.trim() !== ""
            ? "No payees match. Try other filters or another search."
            : "No payees yet. Add the suppliers, subscriptions, statutory bodies and people the company pays."}
        </Text>
      ) : (
        <View className="gap-3">
          {shown.map((payee) => (
            <PayeeRow
              key={payee.id}
              payee={payee}
              bankName={
                payee.details?.method === "bank"
                  ? (bankNames.get(payee.details.bankCode) ?? null)
                  : null
              }
              recentlyChanged={changedRecently(
                payee.detailsChangedAt,
                payees.dataUpdatedAt,
              )}
              onPress={() =>
                router.push({
                  pathname: "/payees/[payeeId]",
                  params: { payeeId: payee.id },
                })
              }
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function PayeeRow({
  payee,
  bankName,
  recentlyChanged,
  onPress,
}: {
  payee: Payee;
  bankName: string | null;
  recentlyChanged: boolean;
  onPress: () => void;
}): JSX.Element {
  const kind = KIND_LABELS[payee.kind];
  const summary = listSummary(payee, bankName);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={[
        payee.name,
        kind,
        summary,
        recentlyChanged ? RECENTLY_CHANGED_LABEL : null,
      ]
        .filter(Boolean)
        .join(", ")}
      onPress={onPress}
      className="gap-2 rounded-xl border border-gray-200 px-4 py-3 active:bg-gray-50"
    >
      <View className="flex-row items-start justify-between gap-3">
        <Text className="flex-1 text-base font-semibold text-gray-900">
          {payee.name}
        </Text>
        <Text className="text-sm font-medium text-gray-700">{kind}</Text>
      </View>
      <Text className="text-sm text-gray-600">{summary}</Text>
      {recentlyChanged ? (
        <Badge label={RECENTLY_CHANGED_LABEL} tone="warning" />
      ) : null}
    </Pressable>
  );
}
