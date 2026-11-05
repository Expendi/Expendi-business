import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, Switch, View } from "react-native";

import type {
  PaidFromAccount,
  PaidFromAccountKind,
} from "@expendi-business/shared";
import { PAID_FROM_ACCOUNT_NAME_MAX_LENGTH } from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { RequireAdmin } from "~/features/company/require-admin";
import { FilterChips } from "~/features/payees/filter-chips";
import {
  ACCOUNT_KIND_OPTIONS,
  AddAccount,
} from "~/features/spending/paid-from-account-picker";
import { ACCOUNT_KIND_LABELS } from "~/features/spending/spending-draft";
import {
  useArchivePaidFromAccount,
  usePaidFromAccounts,
  useUpdatePaidFromAccount,
} from "~/features/spending/use-spending";
import { describeApiError } from "~/lib/api";

export default function PaidFromAccountsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PaidFromAccountsScreen company={company} />}
    </RequireAdmin>
  );
}

/**
 * The accounts the company pays from outside Expendi (spec §6.23). The
 * accountant maps each one to a Zoho Books account.
 */
function PaidFromAccountsScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const [archived, setArchived] = useState(false);
  const [adding, setAdding] = useState(false);
  const accounts = usePaidFromAccounts(company.organizationId, { archived });

  return (
    <Screen
      belowHeader
      refreshing={accounts.isRefetching}
      onRefresh={() => void accounts.refetch()}
    >
      <Text className="text-base text-gray-600">
        Company spending says which of these it was paid from, e.g. the bank
        account or the founder’s card.
      </Text>
      {adding ? (
        <AddAccount
          organizationId={company.organizationId}
          onAdded={() => setAdding(false)}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button label="Add an account" onPress={() => setAdding(true)} />
      )}
      <View className="min-h-14 flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-base text-gray-900">
          Show archived accounts
        </Text>
        <Switch
          accessibilityLabel="Show archived accounts"
          value={archived}
          onValueChange={setArchived}
        />
      </View>

      {accounts.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading accounts" />
      ) : accounts.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(accounts.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={accounts.isFetching}
            onPress={() => void accounts.refetch()}
          />
        </View>
      ) : accounts.data.length === 0 ? (
        <Text className="text-base text-gray-600">
          {archived ? "No archived accounts." : "No accounts yet."}
        </Text>
      ) : (
        <View className="gap-3">
          {accounts.data.map((account) => (
            <AccountRow
              key={account.id}
              organizationId={company.organizationId}
              account={account}
            />
          ))}
        </View>
      )}
    </Screen>
  );
}

function AccountRow({
  organizationId,
  account,
}: {
  organizationId: string;
  account: PaidFromAccount;
}): JSX.Element {
  const update = useUpdatePaidFromAccount(organizationId);
  const archive = useArchivePaidFromAccount(organizationId);
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [name, setName] = useState(account.name);
  const [kind, setKind] = useState<PaidFromAccountKind>(account.kind);

  function closeArchive(): void {
    setArchiving(false);
    archive.reset();
  }

  if (editing) {
    return (
      <View className="gap-3 rounded-xl border border-gray-200 p-3">
        <TextField
          label="Account name"
          value={name}
          onChangeText={setName}
          autoCapitalize="words"
          maxLength={PAID_FROM_ACCOUNT_NAME_MAX_LENGTH}
        />
        <FilterChips
          label="Kind"
          options={ACCOUNT_KIND_OPTIONS}
          value={kind}
          onChange={setKind}
        />
        <ErrorMessage
          message={update.isError ? describeApiError(update.error) : null}
        />
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              label="Save"
              loading={update.isPending}
              disabled={name.trim() === ""}
              onPress={() =>
                update.mutate(
                  { accountId: account.id, changes: { name, kind } },
                  { onSuccess: () => setEditing(false) },
                )
              }
            />
          </View>
          <View className="flex-1">
            <Button
              label="Cancel"
              variant="ghost"
              disabled={update.isPending}
              onPress={() => {
                setEditing(false);
                setName(account.name);
                setKind(account.kind);
                update.reset();
              }}
            />
          </View>
        </View>
      </View>
    );
  }

  return (
    <View className="gap-3 rounded-xl border border-gray-200 px-4 py-3">
      <View className="gap-0.5">
        <Text className="text-base font-semibold text-gray-900">
          {account.name}
        </Text>
        <Text className="text-sm text-gray-600">
          {ACCOUNT_KIND_LABELS[account.kind]}
          {account.archived ? " · Archived" : ""}
        </Text>
      </View>
      {account.archived ? null : (
        <View className="flex-row gap-3">
          <View className="flex-1">
            <Button
              label="Rename"
              variant="secondary"
              onPress={() => setEditing(true)}
            />
          </View>
          <View className="flex-1">
            <Button
              label="Archive"
              variant="ghost"
              onPress={() => setArchiving(true)}
            />
          </View>
        </View>
      )}
      <ConfirmSheet
        visible={archiving}
        title="Archive this account?"
        message={`${account.name} can’t be picked for new spending. Spending already recorded keeps it.`}
        confirmLabel="Archive"
        dismissLabel="Keep it"
        busy={archive.isPending}
        error={archive.isError ? describeApiError(archive.error) : null}
        onConfirm={() =>
          archive.mutate(account.id, { onSuccess: () => closeArchive() })
        }
        onCancel={closeArchive}
      />
    </View>
  );
}
