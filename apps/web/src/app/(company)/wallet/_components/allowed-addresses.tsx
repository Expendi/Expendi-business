"use client";

import type { FormEvent, JSX } from "react";
import { KeyRoundIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { useId, useState } from "react";

import type { AllowlistChange } from "@expendi-business/shared";
import {
  allowlistChangeSchema,
  WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH,
} from "@expendi-business/shared";

import {
  Callout,
  DetailSheet,
  ReadOnlyNote,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { RailCard, RailRow, RailTitle } from "./rail-cards";
import { shortAddress } from "./usdc-amount";
import { useChangeAllowlist, useWithdrawalAddresses } from "./wallet-api";
import { dayMonth, nairobiDay } from "./wallet-display";

/**
 * The company's allowlist (spec §6.9): the only addresses withdrawals can
 * go to. Admins with an approval passkey add and remove them; the passkey
 * prompt confirms each change.
 */
export function AllowedAddresses({
  organizationId,
  canAct,
  onAdd,
}: {
  organizationId: string;
  canAct: boolean;
  onAdd: () => void;
}): JSX.Element {
  const addresses = useWithdrawalAddresses(organizationId);
  const passkey = useApprovalPasskeyStatus(canAct);
  const canChange = canAct && passkey.data?.enrolled === true;
  const change = useChangeAllowlist(organizationId);
  const [removing, setRemoving] = useState<string | null>(null);

  function remove(addressId: string) {
    setRemoving(addressId);
    change.mutate(
      { action: "remove", addressId },
      { onSettled: () => setRemoving(null) },
    );
  }

  return (
    <RailCard titleId="addresses-title">
      <RailTitle id="addresses-title">
        Allowed addresses
        {addresses.data ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 text-xs font-(--w-ui) text-secondary-foreground tabular-nums">
            {addresses.data.length}
          </span>
        ) : null}
      </RailTitle>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Withdrawals can only go to these Base addresses.
      </p>
      {addresses.isPending ? (
        <div className="mt-3 flex flex-col gap-3" aria-busy="true">
          <Skel width="70%" height={14} />
          <Skel width="55%" height={14} />
        </div>
      ) : addresses.isError ? (
        <div className="mt-3">
          <Callout
            tone="error"
            action={
              <Button
                variant="outline"
                size="md"
                onClick={() => void addresses.refetch()}
              >
                Try again
              </Button>
            }
          >
            {describeApiError(addresses.error)}
          </Callout>
        </div>
      ) : addresses.data.length === 0 ? (
        <p className="mt-3 rounded-control border border-dashed border-input p-4 text-center text-sm text-muted-foreground">
          No addresses yet.{canChange ? " Add one to withdraw." : ""}
        </p>
      ) : (
        <ul className="m-0 mt-2 list-none p-0">
          {addresses.data.map((address) => (
            <RailRow
              key={address.id}
              title={address.label}
              detail={`${shortAddress(address.address)} · Added ${dayMonth(nairobiDay(address.confirmedAt))}`}
              action={
                canChange ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={change.isPending}
                    aria-label={
                      removing === address.id
                        ? undefined
                        : `Remove ${address.label}`
                    }
                    onClick={() => remove(address.id)}
                  >
                    {removing === address.id
                      ? "Waiting for your passkey…"
                      : "Remove"}
                  </Button>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}
      {change.data?.status === "cancelled" ? (
        <p role="status" className="mt-2 text-sm text-muted-foreground">
          Cancelled. Nothing changed.
        </p>
      ) : null}
      {change.isError ? (
        <div className="mt-2">
          <Callout tone="error">{describeApprovalError(change.error)}</Callout>
        </div>
      ) : null}
      {canChange ? (
        <Button
          variant="outline"
          size="md"
          className="mt-3 w-full"
          onClick={onAdd}
        >
          <PlusIcon aria-hidden="true" />
          Add address
        </Button>
      ) : null}
      {canAct && !canChange && passkey.data ? (
        <p className="mt-3 text-sm text-muted-foreground">
          Set up your approval passkey in the Expendi Business app to change
          this list.
        </p>
      ) : null}
      {canAct ? (
        <p className="mt-3.5 flex items-start gap-2 text-xs leading-4 text-muted-foreground">
          <ShieldCheckIcon
            aria-hidden="true"
            className="mt-px size-3.5 shrink-0 text-success-700"
          />
          Only admins withdraw or change this list, each confirming with their
          passkey.
        </p>
      ) : (
        <div className="mt-3.5">
          <ReadOnlyNote wide>
            View only. Only admins withdraw or change this list.
          </ReadOnlyNote>
        </div>
      )}
    </RailCard>
  );
}

interface FieldErrors {
  readonly label?: string;
  readonly address?: string;
}

/** Adds an address to the allowlist, confirmed with the admin's passkey. */
export function AddAddressSheet({
  open,
  organizationId,
  onClose,
}: {
  open: boolean;
  organizationId: string;
  onClose: () => void;
}): JSX.Element {
  const change = useChangeAllowlist(organizationId);
  const formId = useId();
  const nameId = useId();
  const addressId = useId();
  const [errors, setErrors] = useState<FieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const parsed = allowlistChangeSchema.safeParse({
      action: "add",
      label: values.get("label"),
      address: values.get("address"),
    });
    if (!parsed.success) {
      const next: { label?: string; address?: string } = {};
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (field === "label" && !next.label) next.label = issue.message;
        if (field === "address" && !next.address) next.address = issue.message;
      }
      setErrors(next);
      return;
    }
    setErrors({});
    const request: AllowlistChange = parsed.data;
    change.mutate(request, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") onClose();
      },
    });
  }

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      dismissible={!change.isPending}
      eyebrow="Allowed addresses"
      title="Add an address"
      footer={
        <SheetActions kind="primary">
          <Button type="submit" form={formId} disabled={change.isPending}>
            {change.isPending ? (
              "Waiting for your passkey…"
            ) : (
              <>
                <KeyRoundIcon aria-hidden="true" />
                Add with passkey
              </>
            )}
          </Button>
          <Button
            variant="outline"
            disabled={change.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
        </SheetActions>
      }
    >
      <form
        id={formId}
        noValidate
        onSubmit={onSubmit}
        aria-label="Add an allowed address"
        className="flex flex-col gap-[18px]"
      >
        <Field>
          <FieldLabel htmlFor={nameId}>Name</FieldLabel>
          <Input
            id={nameId}
            name="label"
            maxLength={WITHDRAWAL_ADDRESS_LABEL_MAX_LENGTH}
            placeholder="e.g. Treasury on Coinbase"
            autoComplete="off"
            aria-invalid={errors.label ? true : undefined}
          />
          {errors.label ? <FieldError>{errors.label}</FieldError> : null}
        </Field>
        <Field>
          <FieldLabel htmlFor={addressId}>Base address</FieldLabel>
          <Input
            id={addressId}
            name="address"
            placeholder="0x…"
            autoComplete="off"
            spellCheck={false}
            className="tabular-nums"
            aria-invalid={errors.address ? true : undefined}
          />
          <FieldDescription>
            Check it carefully: USDC sent to a wrong address can&apos;t be
            recovered.
          </FieldDescription>
          {errors.address ? <FieldError>{errors.address}</FieldError> : null}
        </Field>
      </form>
      {change.data?.status === "cancelled" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cancelled. Nothing changed.
        </p>
      ) : null}
      {change.isError ? (
        <Callout tone="error">{describeApprovalError(change.error)}</Callout>
      ) : null}
    </DetailSheet>
  );
}
