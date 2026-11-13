"use client";

import type { JSX } from "react";
import Link from "next/link";

import type {
  PayeeChain,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES, PAYEE_CHAINS } from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
  DetailValues,
} from "~/features/payees/payee-fields";
import { textLinkClass } from "~/components/data/actions";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { ADDRESS_LABELS, shortAddress } from "~/features/chain-display";
import {
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
} from "~/features/payees/payee-display";
import {
  detailFields,
  fieldLabel,
  methodsForKind,
} from "~/features/payees/payee-fields";
import {
  useAllowlistedAddresses,
  usePayeeBanks,
} from "~/features/payees/payees-api";
import { FormField, SheetNote } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";

const PLACEHOLDERS: Partial<Record<DetailField, string>> = {
  phone: "0712 345 678",
  tillNumber: "123456",
  paybillNumber: "888880",
  accountReference: "e.g. A-17",
  accountNumber: "e.g. 0123456789",
  accountName: "As the bank or M-Pesa shows it",
};

const NUMERIC: readonly DetailField[] = [
  "phone",
  "tillNumber",
  "paybillNumber",
  "accountNumber",
];

/** The id of a details field, so a failed check can focus it. */
export const detailFieldId = (field: DetailField | "method"): string =>
  `payee-${field}`;

/**
 * The payment method and its details (spec §6.19). Banks come from
 * Expendi's list; a USDC payee has a payee chain and can only be an
 * address already on the company's allowlist for that chain.
 */
export function PayeeDetailsFields({
  organizationId,
  kind,
  method,
  onMethodChange,
  values,
  onValueChange,
  errors,
  disabled,
}: {
  organizationId: string;
  kind: PayeeKind;
  method: PayeeMethod;
  onMethodChange: (method: PayeeMethod) => void;
  values: DetailValues;
  onValueChange: (field: DetailField, value: string) => void;
  errors: DetailFieldErrors;
  disabled: boolean;
}): JSX.Element {
  return (
    <>
      <FormField
        id={detailFieldId("method")}
        label="Paid by"
        help={METHOD_DESCRIPTIONS[method]}
      >
        <NativeSelect
          id={detailFieldId("method")}
          className="w-full"
          value={method}
          disabled={disabled}
          onChange={(event) => {
            const next = methodsForKind(kind).find(
              (candidate) => candidate === event.target.value,
            );
            if (next) onMethodChange(next);
          }}
        >
          {methodsForKind(kind).map((candidate) => (
            <NativeSelectOption key={candidate} value={candidate}>
              {METHOD_LABELS[candidate]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </FormField>

      {kind === "employee" && method === "mpesa_phone" ? (
        <SheetNote>Paid to the number they confirmed in the app.</SheetNote>
      ) : null}

      {detailFields(method, kind).map((field) => {
        if (field === "bankCode") {
          return (
            <BankPicker
              key={field}
              organizationId={organizationId}
              value={values.bankCode}
              onChange={(code) => onValueChange("bankCode", code)}
              error={errors.bankCode}
              disabled={disabled}
            />
          );
        }
        if (field === "chain") {
          return (
            <FormField
              key={field}
              id={detailFieldId(field)}
              label={fieldLabel(method, field)}
              help="The chain they receive USDC on."
              error={errors.chain}
            >
              <NativeSelect
                id={detailFieldId(field)}
                className="w-full"
                value={payeeChain(values.chain)}
                disabled={disabled}
                onChange={(event) => onValueChange("chain", event.target.value)}
              >
                {PAYEE_CHAINS.map((candidate) => (
                  <NativeSelectOption key={candidate} value={candidate}>
                    {PAYEE_CHAIN_NAMES[candidate]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </FormField>
          );
        }
        if (field === "address") {
          return (
            <AllowlistedAddressPicker
              key={field}
              organizationId={organizationId}
              chain={payeeChain(values.chain)}
              value={values.address}
              onChange={(address) => onValueChange("address", address)}
              error={errors.address}
              disabled={disabled}
            />
          );
        }
        return (
          <FormField
            key={field}
            id={detailFieldId(field)}
            label={fieldLabel(method, field)}
            error={errors[field]}
          >
            <Input
              id={detailFieldId(field)}
              type="text"
              value={values[field]}
              onChange={(event) => onValueChange(field, event.target.value)}
              placeholder={PLACEHOLDERS[field]}
              disabled={disabled}
              autoComplete="off"
              aria-invalid={errors[field] ? true : undefined}
              className={NUMERIC.includes(field) ? "tabular-nums" : undefined}
            />
          </FormField>
        );
      })}

      {errors.form ? (
        <div role="alert">
          <Callout tone="error">
            <p>{errors.form}</p>
          </Callout>
        </div>
      ) : null}
    </>
  );
}

/** The chosen payee chain; NEAR until one is chosen. */
function payeeChain(value: string): PayeeChain {
  return PAYEE_CHAINS.find((candidate) => candidate === value) ?? "near";
}

/** The Kenyan banks we can pay, A to Z. */
function BankPicker({
  organizationId,
  value,
  onChange,
  error,
  disabled,
}: {
  organizationId: string;
  value: string;
  onChange: (code: string) => void;
  error: string | undefined;
  disabled: boolean;
}): JSX.Element {
  const banks = usePayeeBanks(organizationId);
  const id = detailFieldId("bankCode");
  if (banks.isError) {
    return (
      <FormField label="Bank">
        <div role="alert">
          <Callout
            tone="error"
            action={
              <Button
                variant="outline"
                size="md"
                disabled={banks.isFetching}
                onClick={() => void banks.refetch()}
              >
                {banks.isFetching
                  ? "Loading the banks…"
                  : "Load the banks again"}
              </Button>
            }
          >
            <p>{describeApiError(banks.error)}</p>
          </Callout>
        </div>
      </FormField>
    );
  }
  const sorted = [...(banks.data ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <FormField id={id} label="Bank" error={error}>
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || banks.isPending}
        aria-invalid={error ? true : undefined}
      >
        <NativeSelectOption value="">
          {banks.isPending ? "Loading the banks…" : "Choose the bank"}
        </NativeSelectOption>
        {sorted.map((bank) => (
          <NativeSelectOption key={bank.code} value={bank.code}>
            {bank.name}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FormField>
  );
}

/**
 * USDC payees are paid only to an address on the company's allowlist (spec
 * §6.19), on the payee chain chosen above. Addresses are kept as written.
 */
function AllowlistedAddressPicker({
  organizationId,
  chain,
  value,
  onChange,
  error,
  disabled,
}: {
  organizationId: string;
  chain: PayeeChain;
  value: string;
  onChange: (address: string) => void;
  error: string | undefined;
  disabled: boolean;
}): JSX.Element {
  const addresses = useAllowlistedAddresses(organizationId);
  const id = detailFieldId("address");
  if (addresses.isError) {
    return (
      <FormField label={ADDRESS_LABELS[chain]}>
        <div role="alert">
          <Callout
            tone="error"
            action={
              <Button
                variant="outline"
                size="md"
                onClick={() => void addresses.refetch()}
              >
                Load the allowlist again
              </Button>
            }
          >
            <p>{describeApiError(addresses.error)}</p>
          </Callout>
        </div>
      </FormField>
    );
  }
  const options = (addresses.data ?? []).filter(
    (option) => option.chain === chain,
  );
  return (
    <FormField
      id={id}
      label={ADDRESS_LABELS[chain]}
      error={error}
      help={
        <>
          USDC payees are paid only to an address on the company’s allowlist.{" "}
          <Link href="/wallet" className={textLinkClass}>
            Add one under Accounts
          </Link>
          .
        </>
      }
    >
      <NativeSelect
        id={id}
        className="w-full"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || addresses.isPending}
        aria-invalid={error ? true : undefined}
      >
        <NativeSelectOption value="">
          {addresses.isPending
            ? "Loading the allowlist…"
            : options.length === 0
              ? `No ${PAYEE_CHAIN_NAMES[chain]} addresses on the allowlist yet`
              : "Choose an allowlisted address"}
        </NativeSelectOption>
        {value !== "" && !options.some((option) => option.address === value) ? (
          <NativeSelectOption value={value}>
            {shortAddress(value)}
          </NativeSelectOption>
        ) : null}
        {options.map((option) => (
          <NativeSelectOption key={option.id} value={option.address}>
            {option.label} · {option.address}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </FormField>
  );
}
