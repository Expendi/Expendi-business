import type { JSX } from "react";
import type { TextInputProps } from "react-native";
import { useRouter } from "expo-router";
import { useState } from "react";
import { ActivityIndicator, View } from "react-native";

import type {
  PayeeChain,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  PAYBILL_ACCOUNT_REFERENCE_MAX_LENGTH,
  PAYEE_ACCOUNT_NAME_MAX_LENGTH,
  PAYEE_CHAIN_NAMES,
  PAYEE_CHAINS,
} from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
  DetailValues,
} from "./payee-fields";
import type { PickerOption } from "~/components/option-picker";
import { Badge } from "~/components/badge";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import { OptionPicker } from "~/components/option-picker";
import { Text } from "~/components/text";
import { TextField } from "~/components/text-field";
import { shortAddress } from "~/features/wallet/chain-display";
import { useWithdrawalAddresses } from "~/features/wallet/use-withdrawal-addresses";
import { describeApiError } from "~/lib/api";
import {
  matchesSearch,
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
} from "./payee-display";
import { detailFields, fieldLabel, methodsForKind } from "./payee-fields";
import { usePayeeBanks } from "./use-payees";

const INPUT_PROPS: Partial<Record<DetailField, TextInputProps>> = {
  phone: {
    keyboardType: "phone-pad",
    placeholder: "0712 345 678",
    autoComplete: "off",
  },
  tillNumber: { keyboardType: "number-pad", placeholder: "e.g. 123456" },
  paybillNumber: { keyboardType: "number-pad", placeholder: "e.g. 400200" },
  accountReference: {
    autoCapitalize: "characters",
    autoCorrect: false,
    maxLength: PAYBILL_ACCOUNT_REFERENCE_MAX_LENGTH,
  },
  accountNumber: { autoCapitalize: "characters", autoCorrect: false },
  accountName: {
    autoCapitalize: "words",
    maxLength: PAYEE_ACCOUNT_NAME_MAX_LENGTH,
  },
};

interface PayeeDetailsFieldsProps {
  organizationId: string;
  kind: PayeeKind;
  method: PayeeMethod;
  onMethodChange: (method: PayeeMethod) => void;
  values: DetailValues;
  onValueChange: (field: DetailField, value: string) => void;
  errors: DetailFieldErrors;
  disabled: boolean;
  /** Employee payees only: whether they've confirmed an M-Pesa number. */
  payoutPhoneConfirmed: boolean | null;
}

/** How a payee is paid, and the fields that method needs (spec §6.19). */
export function PayeeDetailsFields({
  organizationId,
  kind,
  method,
  onMethodChange,
  values,
  onValueChange,
  errors,
  disabled,
  payoutPhoneConfirmed,
}: PayeeDetailsFieldsProps): JSX.Element {
  const methodOptions: PickerOption<PayeeMethod>[] = methodsForKind(kind).map(
    (option) => ({
      value: option,
      label: METHOD_LABELS[option],
      description: METHOD_DESCRIPTIONS[option],
    }),
  );

  return (
    <View className="gap-6">
      <OptionPicker
        label="How they're paid"
        options={methodOptions}
        value={method}
        onChange={onMethodChange}
        disabled={disabled}
      />

      {kind === "employee" && method === "mpesa_phone" ? (
        <ConfirmedNumberNote confirmed={payoutPhoneConfirmed} />
      ) : null}
      {method === "outside" ? (
        <Text className="text-base text-gray-600">
          Expendi won’t pay them. You’ll get reminders when a bill is due, and
          mark it paid yourself.
        </Text>
      ) : null}

      {detailFields(method, kind).map((field) => {
        const label = fieldLabel(method, field);
        const error = errors[field] ?? null;
        const onChange = (value: string) => onValueChange(field, value);
        if (field === "bankCode") {
          return (
            <BankPicker
              key={field}
              organizationId={organizationId}
              value={values.bankCode}
              onChange={onChange}
              error={error}
              disabled={disabled}
            />
          );
        }
        if (field === "chain") {
          return (
            <View key={field} className="gap-2">
              <OptionPicker
                label={label}
                options={CHAIN_OPTIONS}
                value={payeeChain(values.chain)}
                onChange={onChange}
                disabled={disabled}
              />
              <ErrorMessage message={error} />
            </View>
          );
        }
        if (field === "address") {
          return (
            <AllowlistedAddressPicker
              key={field}
              organizationId={organizationId}
              chain={payeeChain(values.chain)}
              value={values.address}
              onChange={onChange}
              error={error}
              disabled={disabled}
            />
          );
        }
        return (
          <View key={field} className="gap-2">
            <TextField
              label={label}
              value={values[field]}
              onChangeText={onChange}
              editable={!disabled}
              {...INPUT_PROPS[field]}
            />
            <ErrorMessage message={error} />
          </View>
        );
      })}

      <ErrorMessage message={errors.form ?? null} />
    </View>
  );
}

const CHAIN_OPTIONS: PickerOption<PayeeChain>[] = PAYEE_CHAINS.map((chain) => ({
  value: chain,
  label: PAYEE_CHAIN_NAMES[chain],
}));

/** The chosen payee chain; NEAR until one is chosen. */
function payeeChain(value: string): PayeeChain {
  return PAYEE_CHAINS.find((candidate) => candidate === value) ?? "near";
}

function ConfirmedNumberNote({
  confirmed,
}: {
  confirmed: boolean | null;
}): JSX.Element {
  return (
    <View className="gap-2">
      <Text className="text-base text-gray-600">
        Employees are paid only to the M-Pesa number they confirmed in the app
        by SMS.
      </Text>
      {confirmed ? (
        <Badge label="M-Pesa number confirmed" tone="success" />
      ) : (
        <Badge label="No M-Pesa number yet" tone="warning" />
      )}
      {confirmed ? null : (
        <Text className="text-sm text-gray-600">
          They can’t be paid until they confirm one in the app.
        </Text>
      )}
    </View>
  );
}

interface PickerFieldProps {
  organizationId: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  disabled: boolean;
}

/** Paycrest's Kenyan banks, searchable, collapsed once one is chosen. */
function BankPicker({
  organizationId,
  value,
  onChange,
  error,
  disabled,
}: PickerFieldProps): JSX.Element {
  const banks = usePayeeBanks(organizationId);
  const [search, setSearch] = useState("");
  const [browsing, setBrowsing] = useState(value === "");

  if (banks.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the banks" />;
  }
  if (banks.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(banks.error)} />
        <Button
          label="Load the banks again"
          variant="secondary"
          loading={banks.isFetching}
          onPress={() => void banks.refetch()}
        />
      </View>
    );
  }

  const selected = banks.data.find((bank) => bank.code === value);
  if (selected && !browsing) {
    return (
      <View className="gap-2">
        <Text className="text-sm font-medium text-gray-700">Bank</Text>
        <Text className="text-base font-semibold text-gray-900">
          {selected.name}
        </Text>
        <Button
          label="Change bank"
          variant="secondary"
          disabled={disabled}
          onPress={() => setBrowsing(true)}
        />
        <ErrorMessage message={error} />
      </View>
    );
  }

  const options: PickerOption<string>[] = banks.data
    .filter((bank) => matchesSearch(bank.name, search))
    .map((bank) => ({ value: bank.code, label: bank.name }));

  return (
    <View className="gap-3">
      <TextField
        label="Bank"
        value={search}
        onChangeText={setSearch}
        placeholder="Search banks"
        autoCorrect={false}
        editable={!disabled}
      />
      {options.length === 0 ? (
        <Text className="text-sm text-gray-600">
          No bank matches “{search.trim()}”. Expendi can pay only the banks
          listed here.
        </Text>
      ) : (
        <OptionPicker
          label="Choose the bank"
          options={options}
          value={value}
          disabled={disabled}
          onChange={(code) => {
            onChange(code);
            setSearch("");
            setBrowsing(false);
          }}
        />
      )}
      <ErrorMessage message={error} />
    </View>
  );
}

/**
 * USDC payees are paid only to an address on the company's allowlist (spec
 * §6.19, §7), on the payee chain chosen above. Adding one needs its own
 * passkey step under Wallet.
 */
function AllowlistedAddressPicker({
  organizationId,
  chain,
  value,
  onChange,
  error,
  disabled,
}: PickerFieldProps & { chain: PayeeChain }): JSX.Element {
  const router = useRouter();
  const addresses = useWithdrawalAddresses(organizationId);
  const openAllowlist = () => router.push("/wallet/addresses");

  if (addresses.isPending) {
    return <ActivityIndicator accessibilityLabel="Loading the addresses" />;
  }
  if (addresses.isError) {
    return (
      <View className="gap-3">
        <ErrorMessage message={describeApiError(addresses.error)} />
        <Button
          label="Load the addresses again"
          variant="secondary"
          loading={addresses.isFetching}
          onPress={() => void addresses.refetch()}
        />
      </View>
    );
  }
  const onChain = addresses.data.filter((address) => address.chain === chain);
  if (onChain.length === 0) {
    return (
      <View className="gap-3">
        <Text className="text-base text-gray-600">
          USDC payees are paid only to an address on the company’s allowlist,
          and it has none on {PAYEE_CHAIN_NAMES[chain]} yet. Add one under
          Wallet → Withdrawal addresses first.
        </Text>
        <ErrorMessage message={error} />
        <Button
          label="Add an allowed address"
          variant="secondary"
          onPress={openAllowlist}
        />
      </View>
    );
  }

  const options: PickerOption<string>[] = onChain.map((address) => ({
    value: address.address,
    label: address.label,
    description: shortAddress(address.address),
  }));

  return (
    <View className="gap-3">
      <OptionPicker
        label="Allowed address"
        options={options}
        value={value}
        onChange={onChange}
        disabled={disabled}
      />
      <ErrorMessage message={error} />
      <Button
        label="Add another allowed address"
        variant="ghost"
        onPress={openAllowlist}
      />
    </View>
  );
}
