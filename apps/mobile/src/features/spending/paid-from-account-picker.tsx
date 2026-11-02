import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  PaidFromAccount,
  PaidFromAccountKind,
} from "@expendi-business/shared";
import {
  PAID_FROM_ACCOUNT_KINDS,
  PAID_FROM_ACCOUNT_NAME_MAX_LENGTH,
} from "@expendi-business/shared";

import type { PickerOption } from "~/components/option-picker";
import type { ChipOption } from "~/features/payees/filter-chips";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { TextField } from "~/components/text-field";
import { FilterChips } from "~/features/payees/filter-chips";
import { describeApiError } from "~/lib/api";
import { ACCOUNT_KIND_LABELS } from "./spending-draft";
import { useCreatePaidFromAccount, usePaidFromAccounts } from "./use-spending";

const NOT_SPECIFIED = "";

export const ACCOUNT_KIND_OPTIONS: ChipOption<PaidFromAccountKind>[] =
  PAID_FROM_ACCOUNT_KINDS.map((kind) => ({
    value: kind,
    label: ACCOUNT_KIND_LABELS[kind],
  }));

/**
 * Which of the company's accounts it was paid from (spec §6.23), with a
 * way to add one on the spot: a new company starts with none. `optional`
 * offers "Not specified", for a bill marked paid.
 */
export function PaidFromAccountPicker({
  organizationId,
  value,
  onChange,
  current,
  optional = false,
  error,
}: {
  organizationId: string;
  value: string | null;
  onChange: (accountId: string | null) => void;
  /** The account on the record now, which stays pickable once archived. */
  current?: Pick<PaidFromAccount, "id" | "name" | "kind"> | null;
  optional?: boolean;
  error?: string | null;
}): JSX.Element {
  const accounts = usePaidFromAccounts(organizationId);
  const [adding, setAdding] = useState(false);

  if (accounts.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading accounts" />;
  }
  if (accounts.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(accounts.error)} />
        <Button
          label="Load accounts again"
          variant="secondary"
          onPress={() => void accounts.refetch()}
        />
      </View>
    );
  }

  const listed =
    current && !accounts.data.some((account) => account.id === current.id)
      ? [...accounts.data, current]
      : accounts.data;
  const options: PickerOption<string>[] = [
    ...(optional
      ? [
          {
            value: NOT_SPECIFIED,
            label: "Not specified",
            description: "Set it later on the company spending record.",
          },
        ]
      : []),
    ...listed.map((account) => ({
      value: account.id,
      label: account.name,
      description: ACCOUNT_KIND_LABELS[account.kind],
    })),
  ];

  return (
    <View className="gap-3">
      {options.length > 0 ? (
        <OptionPicker
          label="Paid from"
          options={options}
          value={value ?? NOT_SPECIFIED}
          onChange={(picked) =>
            onChange(picked === NOT_SPECIFIED ? null : picked)
          }
        />
      ) : null}
      <ErrorMessage message={error ?? null} />
      {adding ? (
        <AddAccount
          organizationId={organizationId}
          onAdded={(account) => {
            onChange(account.id);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button
          label={
            listed.length === 0
              ? "Add the account it was paid from"
              : "Add another account"
          }
          variant="secondary"
          onPress={() => setAdding(true)}
        />
      )}
    </View>
  );
}

export function AddAccount({
  organizationId,
  onAdded,
  onCancel,
}: {
  organizationId: string;
  onAdded: (account: PaidFromAccount) => void;
  onCancel: () => void;
}): JSX.Element {
  const create = useCreatePaidFromAccount(organizationId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<PaidFromAccountKind>("bank");

  return (
    <View className="gap-3 rounded-xl border border-gray-200 p-3">
      <TextField
        label="Account name"
        value={name}
        onChangeText={setName}
        placeholder="KCB current account"
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
        message={create.isError ? describeApiError(create.error) : null}
      />
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Add account"
            loading={create.isPending}
            disabled={name.trim() === ""}
            onPress={() =>
              create.mutate({ name, kind }, { onSuccess: onAdded })
            }
          />
        </View>
        <View className="flex-1">
          <Button
            label="Cancel"
            variant="ghost"
            disabled={create.isPending}
            onPress={onCancel}
          />
        </View>
      </View>
    </View>
  );
}
