import type { JSX } from "react";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type { WithdrawalAddress } from "@expendi-business/shared";
import {
  allowlistChangeSchema,
  WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH,
} from "@expendi-business/shared";

import type { Company } from "~/features/company/company-provider";
import { Button } from "~/components/button";
import { ConfirmSheet } from "~/components/confirm-sheet";
import { ErrorMessage } from "~/components/error-message";
import { Screen } from "~/components/screen";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import {
  ApprovalPasskeyGate,
  describeApprovalError,
  useApprovalPasskeyStatus,
} from "~/features/approval";
import { RequireAdmin } from "~/features/company/require-admin";
import {
  useChangeAllowlist,
  useWithdrawalAddresses,
} from "~/features/wallet/use-withdrawal-addresses";
import { describeApiError } from "~/lib/api";

export default function WithdrawalAddressesRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <WithdrawalAddressesScreen company={company} />}
    </RequireAdmin>
  );
}

function WithdrawalAddressesScreen({
  company,
}: {
  company: Company;
}): JSX.Element {
  const addresses = useWithdrawalAddresses(company.organizationId);
  const passkey = useApprovalPasskeyStatus();
  const canChange = passkey.data?.enrolled === true;
  const [removing, setRemoving] = useState<WithdrawalAddress | null>(null);
  const remove = useChangeAllowlist(company.organizationId);

  function confirmRemoval(): void {
    if (!removing) return;
    remove.mutate(
      { action: "remove", addressId: removing.id },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "approved") setRemoving(null);
        },
      },
    );
  }

  return (
    <Screen
      belowHeader
      refreshing={addresses.isRefetching}
      onRefresh={() => void addresses.refetch()}
    >
      <Text className="text-base text-gray-600">
        Withdrawals and USDC payments can only go to these Base addresses.
        Adding or removing one needs your passkey.
      </Text>

      <ApprovalPasskeyGate>
        <AddAddressForm organizationId={company.organizationId} />
      </ApprovalPasskeyGate>

      {addresses.isPending ? (
        <ActivityIndicator accessibilityLabel="Loading the addresses" />
      ) : addresses.isError ? (
        <View className="gap-4">
          <ErrorMessage message={describeApiError(addresses.error)} />
          <Button
            label="Try again"
            variant="secondary"
            loading={addresses.isFetching}
            onPress={() => void addresses.refetch()}
          />
        </View>
      ) : addresses.data.length === 0 ? (
        <Text className="text-base text-gray-600">No addresses yet.</Text>
      ) : (
        <View className="gap-3">
          {addresses.data.map((address) => (
            <AddressRow
              key={address.id}
              address={address}
              onRemove={
                canChange
                  ? () => {
                      remove.reset();
                      setRemoving(address);
                    }
                  : null
              }
            />
          ))}
        </View>
      )}

      <ConfirmSheet
        visible={removing !== null}
        title={`Remove ${removing?.label ?? "this address"}?`}
        message="Withdrawals and USDC payments to it will stop, including any not sent yet. You'll confirm with your passkey."
        confirmLabel="Remove with passkey"
        busy={remove.isPending}
        error={remove.isError ? describeApprovalError(remove.error) : null}
        onConfirm={confirmRemoval}
        onCancel={() => setRemoving(null)}
      />
    </Screen>
  );
}

function AddressRow({
  address,
  onRemove,
}: {
  address: WithdrawalAddress;
  onRemove: (() => void) | null;
}): JSX.Element {
  return (
    <View className="gap-3 rounded-xl border border-gray-200 px-4 py-3">
      <View className="gap-1">
        <Text className="text-base font-semibold text-gray-900">
          {address.label}
        </Text>
        <Text selectable className="font-mono text-sm text-gray-700">
          {address.address}
        </Text>
      </View>
      {onRemove ? (
        <Button
          label={`Remove ${address.label}`}
          variant="secondary"
          onPress={onRemove}
        />
      ) : null}
    </View>
  );
}

interface FieldErrors {
  address?: string;
  label?: string;
}

function AddAddressForm({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const add = useChangeAllowlist(organizationId);
  const [address, setAddress] = useState("");
  const [label, setLabel] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const added = add.data?.status === "approved" ? add.data.result : null;

  function handleAdd(): void {
    const parsed = allowlistChangeSchema.safeParse({
      action: "add",
      address,
      label,
    });
    if (!parsed.success) {
      const errors: FieldErrors = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if ((field === "address" || field === "label") && !errors[field]) {
          errors[field] = issue.message;
        }
      }
      setFieldErrors(errors);
      return;
    }
    setFieldErrors({});
    add.mutate(parsed.data, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") {
          setAddress("");
          setLabel("");
        }
      },
    });
  }

  return (
    <View className="gap-4">
      <Text className="text-sm font-semibold uppercase tracking-wide text-gray-500">
        Add an address
      </Text>
      <TextField
        label="Base address"
        value={address}
        onChangeText={setAddress}
        placeholder="0x…"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!add.isPending}
      />
      <ErrorMessage message={fieldErrors.address ?? null} />
      <TextField
        label="Name"
        value={label}
        onChangeText={setLabel}
        placeholder="e.g. Company treasury"
        maxLength={WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH}
        editable={!add.isPending}
      />
      <ErrorMessage message={fieldErrors.label ?? null} />
      <Text className="text-sm text-gray-600">
        Check the address character by character. USDC sent to a wrong address
        can’t be recovered.
      </Text>
      <ErrorMessage
        message={add.isError ? describeApprovalError(add.error) : null}
      />
      {added ? (
        <Text accessibilityRole="alert" className="text-sm text-green-800">
          {added.label} was added.
        </Text>
      ) : null}
      <Button
        label="Add with passkey"
        loading={add.isPending}
        onPress={handleAdd}
      />
    </View>
  );
}
