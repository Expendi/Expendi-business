"use client";

import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { Payee, PayeeKind } from "@expendi-business/shared";
import {
  PAYEE_KINDS,
  PAYEE_NAME_MAX_LENGTH,
  updatePayeeRequestSchema,
} from "@expendi-business/shared";

import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import {
  detailRows,
  KIND_LABELS,
  RECENTLY_CHANGED_LABEL,
} from "~/features/payees/payee-display";
import {
  useArchivePayee,
  useBankName,
  usePayee,
  useUpdatePayee,
} from "~/features/payees/payees-api";
import { Field, PreviewRows, StatusBadge } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { queryKeys } from "~/lib/query-keys";
import { ChangeDetailsForm, memberName } from "./payee-forms";

const OTHER_KINDS = PAYEE_KINDS.filter((kind) => kind !== "employee");

/** One payee's details; admins also change and archive them here. */
export function PayeeDetailPanel({
  organizationId,
  payeeId,
  canAct,
  onClose,
}: {
  organizationId: string;
  payeeId: string;
  canAct: boolean;
  onClose: () => void;
}): JSX.Element {
  const payee = usePayee(organizationId, payeeId);

  return (
    <section
      aria-label="Payee"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="mb-3 flex justify-end">
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      {payee.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : payee.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(payee.error)}</p>
          <button
            type="button"
            onClick={() => void payee.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <PayeeDetails
          organizationId={organizationId}
          payee={payee.data}
          canAct={canAct}
        />
      )}
    </section>
  );
}

type Mode = "view" | "details" | "edit" | "archive";

function PayeeDetails({
  organizationId,
  payee,
  canAct,
}: {
  organizationId: string;
  payee: Payee;
  canAct: boolean;
}): JSX.Element {
  const [mode, setMode] = useState<Mode>("view");
  const [savedDetails, setSavedDetails] = useState(false);
  const bankName = useBankName(organizationId, payee.details);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-stone-500">{KIND_LABELS[payee.kind]}</p>
        <h2 className="mt-1 text-lg font-semibold break-words">{payee.name}</h2>
        <div className="mt-2 flex flex-wrap gap-2">
          {payee.archived ? (
            <StatusBadge label="Archived" tone="neutral" />
          ) : null}
          {payee.secondConfirmationUntil ? (
            <StatusBadge label={RECENTLY_CHANGED_LABEL} tone="warning" />
          ) : null}
        </div>
      </div>

      {payee.membershipId ? (
        <LinkedMember
          organizationId={organizationId}
          membershipId={payee.membershipId}
        />
      ) : null}

      <div>
        <h3 className="text-sm font-semibold">Payment details</h3>
        {payee.details ? (
          <div className="mt-2 rounded-md border border-stone-200 p-3">
            <PreviewRows
              rows={detailRows(payee.details, {
                bankName,
                payoutPhoneConfirmed: payee.payoutPhoneConfirmed,
              })}
            />
          </div>
        ) : (
          <p className="mt-2 text-sm text-stone-600">
            No payment details yet. Add them before paying this payee.
          </p>
        )}
        {payee.detailsChangedAt ? (
          <p className="mt-2 text-xs text-stone-500">
            Last changed {formatNairobiDateTime(payee.detailsChangedAt)}.
          </p>
        ) : null}
        {payee.secondConfirmationUntil ? (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Paying them before{" "}
            {formatNairobiDateTime(payee.secondConfirmationUntil)} needs a
            second confirmation.
          </p>
        ) : null}
      </div>

      {savedDetails ? (
        <p
          role="status"
          className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
        >
          Payment details saved. Every admin was emailed. Paying {payee.name} in
          the next 24 hours needs a second confirmation.
        </p>
      ) : null}

      {payee.archived ? (
        <p className="text-sm text-stone-600">
          This payee is archived. It can’t be paid or changed, and its history
          stays.
        </p>
      ) : canAct ? (
        <PayeeActions
          organizationId={organizationId}
          payee={payee}
          mode={mode}
          onMode={(next) => {
            setSavedDetails(false);
            setMode(next);
          }}
          onDetailsSaved={() => {
            setMode("view");
            setSavedDetails(true);
          }}
        />
      ) : null}
    </div>
  );
}

function LinkedMember({
  organizationId,
  membershipId,
}: {
  organizationId: string;
  membershipId: string;
}): JSX.Element {
  const { api } = useAuth();
  const members = useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
  });
  const member = members.data?.find(
    (candidate) => candidate.id === membershipId,
  );
  return (
    <dl>
      <Field label="Team member">
        {members.isPending
          ? "Loading…"
          : member
            ? `${memberName(member)}${member.name ? ` · ${member.email}` : ""}`
            : members.isError
              ? describeApiError(members.error)
              : "No longer in the team."}
      </Field>
    </dl>
  );
}

function PayeeActions({
  organizationId,
  payee,
  mode,
  onMode,
  onDetailsSaved,
}: {
  organizationId: string;
  payee: Payee;
  mode: Mode;
  onMode: (mode: Mode) => void;
  onDetailsSaved: () => void;
}): JSX.Element {
  if (mode === "details") {
    return (
      <ApprovalPasskeyGate>
        <ChangeDetailsForm
          organizationId={organizationId}
          payee={payee}
          onDone={onDetailsSaved}
          onCancel={() => onMode("view")}
        />
      </ApprovalPasskeyGate>
    );
  }
  if (mode === "edit") {
    return (
      <EditPayee
        organizationId={organizationId}
        payee={payee}
        onDone={() => onMode("view")}
      />
    );
  }
  if (mode === "archive") {
    return (
      <ArchivePayee
        organizationId={organizationId}
        payee={payee}
        onCancel={() => onMode("view")}
      />
    );
  }
  return (
    <div className="flex flex-wrap gap-3 border-t border-stone-200 pt-4">
      <button
        type="button"
        onClick={() => onMode("details")}
        className={primaryButton}
      >
        {payee.details ? "Change payment details" : "Add payment details"}
      </button>
      <button
        type="button"
        onClick={() => onMode("edit")}
        className={secondaryButton}
      >
        Rename or change kind
      </button>
      <button
        type="button"
        onClick={() => onMode("archive")}
        className={secondaryButton}
      >
        Archive payee
      </button>
    </div>
  );
}

/**
 * Name and kind change without a passkey. An employee payee stays linked
 * to its person, so its kind is fixed.
 */
function EditPayee({
  organizationId,
  payee,
  onDone,
}: {
  organizationId: string;
  payee: Payee;
  onDone: () => void;
}): JSX.Element {
  const update = useUpdatePayee(organizationId, payee.id);
  const [name, setName] = useState(payee.name);
  const [kind, setKind] = useState<PayeeKind>(payee.kind);
  const [error, setError] = useState<string | null>(null);
  const nameChanged = name.trim() !== payee.name;
  const kindChanged = kind !== payee.kind;

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsed = updatePayeeRequestSchema.safeParse({
      ...(nameChanged ? { name } : {}),
      ...(kindChanged ? { kind } : {}),
    });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Check the name and kind.");
      return;
    }
    setError(null);
    update.mutate(parsed.data, { onSuccess: onDone });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Name and kind"
      className="space-y-4 rounded-lg border border-stone-200 p-4"
    >
      <h3 className="text-sm font-semibold">Name and kind</h3>
      <label className="block text-sm">
        Payee name
        <input
          type="text"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            update.reset();
          }}
          maxLength={PAYEE_NAME_MAX_LENGTH}
          disabled={update.isPending}
          className={inputClass}
        />
      </label>
      {payee.kind === "employee" ? (
        <p className="text-sm text-stone-600">
          An employee payee stays an employee. To pay someone else, archive this
          payee and add a new one.
        </p>
      ) : (
        <label className="block text-sm">
          Kind
          <select
            value={kind}
            onChange={(event) => {
              const next = OTHER_KINDS.find(
                (candidate) => candidate === event.target.value,
              );
              if (next) setKind(next);
              update.reset();
            }}
            disabled={update.isPending}
            className={inputClass}
          >
            {OTHER_KINDS.map((candidate) => (
              <option key={candidate} value={candidate}>
                {KIND_LABELS[candidate]}
              </option>
            ))}
          </select>
        </label>
      )}
      {error || update.isError ? (
        <p className={alertClass} role="alert">
          {error ?? describeApiError(update.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={update.isPending || (!nameChanged && !kindChanged)}
          className={primaryButton}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onDone}
          disabled={update.isPending}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

function ArchivePayee({
  organizationId,
  payee,
  onCancel,
}: {
  organizationId: string;
  payee: Payee;
  onCancel: () => void;
}): JSX.Element {
  const archive = useArchivePayee(organizationId, payee.id);
  return (
    <section
      aria-label="Archive payee"
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <h3 className="font-semibold">Archive {payee.name}?</h3>
      <p className="mt-1">
        They won’t appear for new bills or payments. Payments already made to
        them stay in the history.
      </p>
      {archive.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(archive.error)}
        </p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={() => archive.mutate()}
          disabled={archive.isPending}
          className={primaryButton}
        >
          {archive.isPending ? "Archiving…" : "Archive"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={archive.isPending}
          className={secondaryButton}
        >
          Keep it
        </button>
      </div>
    </section>
  );
}
