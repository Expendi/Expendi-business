"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type { AllowlistChange } from "@expendi-business/shared";
import {
  allowlistChangeSchema,
  WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH,
} from "@expendi-business/shared";

import {
  alertClass,
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
  textButton,
} from "~/components/styles";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { useChangeAllowlist, useWithdrawalAddresses } from "./wallet-api";

/**
 * The company's allowlist (spec §6.9): the only addresses withdrawals can
 * go to. Admins with an approval passkey add and remove them; the
 * passkey prompt confirms each change.
 */
export function AllowedAddresses({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const addresses = useWithdrawalAddresses(organizationId);
  const passkey = useApprovalPasskeyStatus(canAct);
  const canChange = canAct && passkey.data?.enrolled === true;
  const change = useChangeAllowlist(organizationId);
  const [pending, setPending] = useState<AllowlistChange | null>(null);

  function confirm(next: AllowlistChange, onApproved?: () => void) {
    setPending(next);
    change.mutate(next, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") onApproved?.();
      },
      onSettled: () => setPending(null),
    });
  }

  return (
    <section aria-labelledby="addresses-heading" className="space-y-3">
      <div>
        <h2 id="addresses-heading" className="text-base font-semibold">
          Allowed addresses
        </h2>
        <p className="mt-1 text-sm text-stone-600">
          Withdrawals can only go to these Base addresses.
        </p>
      </div>

      {addresses.isPending ? (
        <p className="text-sm text-stone-500">Loading addresses…</p>
      ) : addresses.isError ? (
        <div className={alertClass} role="alert">
          <p>{describeApiError(addresses.error)}</p>
          <button
            type="button"
            onClick={() => void addresses.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : addresses.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-4 text-sm text-stone-600">
          No addresses yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className={tableClass}>
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th scope="col" className={headCellClass}>
                  Name
                </th>
                <th scope="col" className={headCellClass}>
                  Address
                </th>
                <th scope="col" className={headCellClass}>
                  Added
                </th>
                {canChange ? (
                  <th scope="col" className={headCellClass}>
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {addresses.data.map((address) => (
                <tr key={address.id} className="border-t border-stone-200">
                  <td className={cellClass}>{address.label}</td>
                  <td className={`${cellClass} font-mono break-all`}>
                    {address.address}
                  </td>
                  <td className={`${cellClass} whitespace-nowrap`}>
                    {formatNairobiDateTime(address.confirmedAt)}
                  </td>
                  {canChange ? (
                    <td className={`${cellClass} text-right`}>
                      <button
                        type="button"
                        disabled={change.isPending}
                        onClick={() =>
                          confirm({ action: "remove", addressId: address.id })
                        }
                        className={textButton}
                      >
                        {pending?.action === "remove" &&
                        pending.addressId === address.id
                          ? "Waiting for your passkey…"
                          : "Remove"}
                      </button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canChange ? (
        <AddAddressForm
          busy={change.isPending}
          adding={pending?.action === "add"}
          onAdd={confirm}
        />
      ) : null}

      {change.data?.status === "cancelled" ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing changed.</p>
      ) : null}
      {change.isError ? (
        <p className={alertClass} role="alert">
          {describeApprovalError(change.error)}
        </p>
      ) : null}
    </section>
  );
}

function AddAddressForm({
  busy,
  adding,
  onAdd,
}: {
  busy: boolean;
  adding: boolean;
  onAdd: (change: AllowlistChange, onApproved: () => void) => void;
}): JSX.Element {
  const [error, setError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const values = new FormData(form);
    const parsed = allowlistChangeSchema.safeParse({
      action: "add",
      label: values.get("label"),
      address: values.get("address"),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the address.");
      return;
    }
    setError(null);
    onAdd(parsed.data, () => form.reset());
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Add an allowed address"
      className="grid max-w-3xl gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-[1fr_2fr]"
    >
      <label className="text-sm">
        Name
        <input
          name="label"
          maxLength={WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH}
          placeholder="e.g. Treasury on Coinbase"
          autoComplete="off"
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        Base address
        <input
          name="address"
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          className={`${inputClass} font-mono`}
        />
      </label>
      {error ? (
        <p className={`${alertClass} sm:col-span-2`} role="alert">
          {error}
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button type="submit" disabled={busy} className={primaryButton}>
          {adding ? "Waiting for your passkey…" : "Add with passkey"}
        </button>
        <p className="mt-2 text-sm text-stone-600">
          Check the address carefully: USDC sent to a wrong address can&apos;t
          be recovered.
        </p>
      </div>
    </form>
  );
}
