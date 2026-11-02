"use client";

import type { JSX } from "react";
import Link from "next/link";

import type { PayeeKind, PayeeMethod } from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
  DetailValues,
} from "~/features/payees/payee-fields";
import { inputClass, linkClass, secondaryButton } from "~/components/styles";
import {
  METHOD_DESCRIPTIONS,
  METHOD_LABELS,
  shortAddress,
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
import { describeApiError } from "~/lib/api";

const PLACEHOLDERS: Partial<Record<DetailField, string>> = {
  phone: "0712 345 678",
  tillNumber: "123456",
  paybillNumber: "888880",
  accountReference: "e.g. A-17",
  accountNumber: "e.g. 0123456789",
  accountName: "As the bank or M-Pesa shows it",
};

function FieldError({ message }: { message: string | undefined }) {
  return message ? (
    <span className="mt-1 block text-xs text-error-700">{message}</span>
  ) : null;
}

/**
 * The payment method and its details (spec §6.19). Banks come from
 * Paycrest's list; a USDC payee can only be an address already on the
 * company's allowlist.
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
  const fields = detailFields(method, kind);
  return (
    <div className="space-y-4">
      <label className="block text-sm">
        Paid by
        <select
          value={method}
          onChange={(event) => {
            const next = methodsForKind(kind).find(
              (candidate) => candidate === event.target.value,
            );
            if (next) onMethodChange(next);
          }}
          disabled={disabled}
          className={inputClass}
        >
          {methodsForKind(kind).map((candidate) => (
            <option key={candidate} value={candidate}>
              {METHOD_LABELS[candidate]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-stone-500">
          {METHOD_DESCRIPTIONS[method]}
        </span>
      </label>

      {kind === "employee" && method === "mpesa_phone" ? (
        <p className="text-sm text-stone-600">
          Paid to the number they confirmed in the app.
        </p>
      ) : null}

      {fields.map((field) => {
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
        if (field === "address") {
          return (
            <AllowlistedAddressPicker
              key={field}
              organizationId={organizationId}
              value={values.address}
              onChange={(address) => onValueChange("address", address)}
              error={errors.address}
              disabled={disabled}
            />
          );
        }
        return (
          <label key={field} className="block text-sm">
            {fieldLabel(method, field)}
            <input
              type="text"
              value={values[field]}
              onChange={(event) => onValueChange(field, event.target.value)}
              placeholder={PLACEHOLDERS[field]}
              disabled={disabled}
              autoComplete="off"
              className={inputClass}
            />
            <FieldError message={errors[field]} />
          </label>
        );
      })}

      {errors.form ? (
        <p className="text-sm text-error-700">{errors.form}</p>
      ) : null}
    </div>
  );
}

/** Paycrest's Kenyan banks, A to Z. */
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
  if (banks.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(banks.error)}</p>
        <button
          type="button"
          onClick={() => void banks.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Load the banks again
        </button>
      </div>
    );
  }
  const sorted = [...(banks.data ?? [])].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return (
    <label className="block text-sm">
      Bank
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        disabled={disabled || banks.isPending}
        className={inputClass}
      >
        <option value="">
          {banks.isPending ? "Loading the banks…" : "Choose the bank"}
        </option>
        {sorted.map((bank) => (
          <option key={bank.code} value={bank.code}>
            {bank.name}
          </option>
        ))}
      </select>
      <FieldError message={error} />
    </label>
  );
}

/** USDC payees are paid only to an address on the company's allowlist (spec §6.19). */
function AllowlistedAddressPicker({
  organizationId,
  value,
  onChange,
  error,
  disabled,
}: {
  organizationId: string;
  value: string;
  onChange: (address: string) => void;
  error: string | undefined;
  disabled: boolean;
}): JSX.Element {
  const addresses = useAllowlistedAddresses(organizationId);
  if (addresses.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(addresses.error)}</p>
        <button
          type="button"
          onClick={() => void addresses.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Load the allowlist again
        </button>
      </div>
    );
  }
  const options = addresses.data ?? [];
  const current = value.toLowerCase();
  return (
    <div className="space-y-1 text-sm">
      <label className="block">
        Base address
        <select
          value={current}
          onChange={(event) => onChange(event.target.value)}
          disabled={disabled || addresses.isPending}
          className={inputClass}
        >
          <option value="">
            {addresses.isPending
              ? "Loading the allowlist…"
              : options.length === 0
                ? "No addresses on the allowlist yet"
                : "Choose an allowlisted address"}
          </option>
          {current !== "" &&
          !options.some((option) => option.address === current) ? (
            <option value={current}>{shortAddress(current)}</option>
          ) : null}
          {options.map((option) => (
            <option key={option.id} value={option.address}>
              {option.label} · {option.address}
            </option>
          ))}
        </select>
      </label>
      <FieldError message={error} />
      <p className="text-xs text-stone-500">
        USDC payees are paid only to an address on the company’s allowlist.{" "}
        <Link href="/wallet" className={linkClass}>
          Add one under Wallet
        </Link>
        .
      </p>
    </div>
  );
}
