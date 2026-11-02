"use client";

import type { FormEvent, JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type {
  CreatePayeeRequest,
  Member,
  Payee,
  PayeeChangeChallenge,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  createPayeeRequestSchema,
  PAYEE_KINDS,
  PAYEE_NAME_MAX_LENGTH,
} from "@expendi-business/shared";

import type {
  DetailField,
  DetailFieldErrors,
} from "~/features/payees/payee-fields";
import type { PayeeChangeRequest } from "~/features/payees/payees-api";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import {
  CHANGE_WARNING,
  KIND_DESCRIPTIONS,
  KIND_LABELS,
} from "~/features/payees/payee-display";
import {
  detailsToValues,
  EMPTY_DETAIL_VALUES,
  methodsForKind,
  validateDetails,
} from "~/features/payees/payee-fields";
import { usePayees, useRequestPayeeChange } from "~/features/payees/payees-api";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { PayeeChangeReview } from "./payee-change-review";
import { PayeeDetailsFields } from "./payee-details-fields";

interface PendingReview {
  readonly request: PayeeChangeRequest;
  readonly challenge: PayeeChangeChallenge;
}

interface CreateErrors {
  name?: string;
  membershipId?: string;
  details: DetailFieldErrors;
}

export function memberName(member: Pick<Member, "name" | "email">): string {
  return member.name ?? member.email;
}

/** The method a payee's form starts on: theirs, or the first one their kind allows. */
function startingMethod(
  kind: PayeeKind,
  current: PayeeMethod | null,
): PayeeMethod {
  const allowed = methodsForKind(kind);
  return current && allowed.includes(current)
    ? current
    : (allowed[0] ?? "outside");
}

/**
 * Adds a payee (spec §6.19). Paid outside Expendi it's added at once;
 * with payment details, the admin reviews exactly what the API will save
 * and confirms it with their passkey.
 */
export function NewPayeeForm({
  organizationId,
  onCreated,
  onCancel,
}: {
  organizationId: string;
  onCreated: (payee: Payee) => void;
  onCancel: () => void;
}): JSX.Element {
  const request = useRequestPayeeChange(organizationId);
  const [kind, setKind] = useState<PayeeKind>("supplier");
  const [membershipId, setMembershipId] = useState("");
  const [name, setName] = useState("");
  const [method, setMethod] = useState<PayeeMethod>("mpesa_phone");
  const [values, setValues] = useState(EMPTY_DETAIL_VALUES);
  const [errors, setErrors] = useState<CreateErrors>({ details: {} });
  const [review, setReview] = useState<PendingReview | null>(null);
  const { api } = useAuth();
  const members = useQuery({
    queryKey: queryKeys.members(organizationId),
    queryFn: () => api.listMembers(organizationId),
    enabled: kind === "employee",
  });
  const member = members.data?.find(
    (candidate) => candidate.id === membershipId,
  );
  const employee = kind === "employee";
  const busy = request.isPending;

  if (review) {
    return (
      <PayeeChangeReview
        organizationId={organizationId}
        request={review.request}
        challenge={review.challenge}
        currentPayee={null}
        memberName={member ? memberName(member) : null}
        payoutPhoneConfirmed={member?.payoutPhoneConfirmed ?? null}
        onEdit={() => setReview(null)}
        onConfirmed={onCreated}
      />
    );
  }

  function changeKind(next: PayeeKind): void {
    setKind(next);
    request.reset();
    if (next !== "employee") setMembershipId("");
    setMethod(startingMethod(next, method));
  }

  function chooseMember(chosen: Member): void {
    setMembershipId(chosen.id);
    request.reset();
    if (name.trim() === "" && chosen.name) setName(chosen.name);
    if (values.accountName.trim() === "" && chosen.name) {
      setValues({ ...values, accountName: chosen.name });
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const parsedName = createPayeeRequestSchema.shape.name.safeParse(name);
    const details = validateDetails(method, kind, values);
    const memberError =
      employee && membershipId === "" ? "Choose the employee." : undefined;
    if (!parsedName.success || !details.ok || memberError) {
      setErrors({
        name: parsedName.error?.issues[0]?.message,
        membershipId: memberError,
        details: details.ok ? {} : details.errors,
      });
      return;
    }
    setErrors({ details: {} });

    const payee: CreatePayeeRequest = employee
      ? { kind, name: parsedName.data, membershipId, details: details.details }
      : { kind, name: parsedName.data, details: details.details };
    const change: PayeeChangeRequest = { action: "create", payee };
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "created") onCreated(response.payee);
        else setReview({ request: change, challenge: response });
      },
    });
  }

  return (
    <form onSubmit={onSubmit} aria-label="Add a payee" className="space-y-4">
      <h2 className="text-base font-semibold">Add a payee</h2>
      <label className="block text-sm">
        Who is this payee?
        <select
          value={kind}
          onChange={(event) => {
            const next = PAYEE_KINDS.find(
              (candidate) => candidate === event.target.value,
            );
            if (next) changeKind(next);
          }}
          disabled={busy}
          className={inputClass}
        >
          {PAYEE_KINDS.map((candidate) => (
            <option key={candidate} value={candidate}>
              {KIND_LABELS[candidate]}
            </option>
          ))}
        </select>
        <span className="mt-1 block text-xs text-stone-500">
          {KIND_DESCRIPTIONS[kind]}
        </span>
      </label>

      {employee ? (
        <EmployeePicker
          organizationId={organizationId}
          members={members.data ?? null}
          membersError={members.isError ? members.error : null}
          membershipId={membershipId}
          onChoose={chooseMember}
          error={errors.membershipId}
          disabled={busy}
        />
      ) : null}

      <label className="block text-sm">
        Payee name
        <input
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={employee ? "Their full name" : "e.g. Kenya Power"}
          maxLength={PAYEE_NAME_MAX_LENGTH}
          disabled={busy}
          className={inputClass}
        />
        {errors.name ? (
          <span className="mt-1 block text-xs text-error-700">
            {errors.name}
          </span>
        ) : null}
      </label>

      <PayeeDetailsFields
        organizationId={organizationId}
        kind={kind}
        method={method}
        onMethodChange={(next) => {
          setMethod(next);
          request.reset();
        }}
        values={values}
        onValueChange={(field: DetailField, value: string) =>
          setValues({ ...values, [field]: value })
        }
        errors={errors.details}
        disabled={busy}
      />

      {request.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(request.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className={primaryButton}>
          {busy ? "Checking…" : method === "outside" ? "Add payee" : "Review"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

/**
 * Anyone in the team who can log in; accountants can't be paid, and each
 * person has at most one active payee.
 */
function EmployeePicker({
  organizationId,
  members,
  membersError,
  membershipId,
  onChoose,
  error,
  disabled,
}: {
  organizationId: string;
  members: readonly Member[] | null;
  membersError: Error | null;
  membershipId: string;
  onChoose: (member: Member) => void;
  error: string | undefined;
  disabled: boolean;
}): JSX.Element {
  const employeePayees = usePayees(organizationId, {
    kind: "employee",
    method: null,
    archived: false,
  });
  const loadError = membersError ?? employeePayees.error;
  if (loadError) {
    return (
      <p className="text-sm text-error-700" role="alert">
        {describeApiError(loadError)}
      </p>
    );
  }
  if (!members || !employeePayees.data) {
    return <p className="text-sm text-stone-500">Loading the team…</p>;
  }

  const alreadyPayees = new Set(
    employeePayees.data.map((payee) => payee.membershipId),
  );
  const eligible = members.filter(
    (candidate) =>
      candidate.role !== "accountant" &&
      candidate.status !== "removed" &&
      !alreadyPayees.has(candidate.id),
  );
  if (eligible.length === 0) {
    return (
      <p className="text-sm text-stone-600">
        Everyone in the team is already a payee. Invite someone under Team to
        add them.
      </p>
    );
  }

  return (
    <label className="block text-sm">
      Team member
      <select
        value={membershipId}
        onChange={(event) => {
          const chosen = eligible.find(
            (candidate) => candidate.id === event.target.value,
          );
          if (chosen) onChoose(chosen);
        }}
        disabled={disabled}
        className={inputClass}
      >
        <option value="">Choose the employee</option>
        {eligible.map((candidate) => (
          <option key={candidate.id} value={candidate.id}>
            {memberName(candidate)} · {candidate.email} ·{" "}
            {candidate.payoutPhoneConfirmed
              ? "M-Pesa number confirmed"
              : "No M-Pesa number yet"}
          </option>
        ))}
      </select>
      {error ? (
        <span className="mt-1 block text-xs text-error-700">{error}</span>
      ) : null}
    </label>
  );
}

/**
 * New payment details for an existing payee: reviewed, then confirmed
 * with the admin's passkey. Paying them in the next 24 hours needs a
 * second confirmation.
 */
export function ChangeDetailsForm({
  organizationId,
  payee,
  onDone,
  onCancel,
}: {
  organizationId: string;
  payee: Payee;
  onDone: () => void;
  onCancel: () => void;
}): JSX.Element {
  const request = useRequestPayeeChange(organizationId);
  const [method, setMethod] = useState<PayeeMethod>(() =>
    startingMethod(payee.kind, payee.details?.method ?? null),
  );
  const [values, setValues] = useState(() => detailsToValues(payee.details));
  const [errors, setErrors] = useState<DetailFieldErrors>({});
  const [review, setReview] = useState<PendingReview | null>(null);

  if (review) {
    return (
      <PayeeChangeReview
        organizationId={organizationId}
        request={review.request}
        challenge={review.challenge}
        currentPayee={payee}
        memberName={null}
        payoutPhoneConfirmed={payee.payoutPhoneConfirmed}
        onEdit={() => setReview(null)}
        onConfirmed={onDone}
      />
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const details = validateDetails(method, payee.kind, values);
    if (!details.ok) {
      setErrors(details.errors);
      return;
    }
    setErrors({});
    const change: PayeeChangeRequest = {
      action: "change_details",
      payeeId: payee.id,
      details: details.details,
    };
    request.mutate(change, {
      onSuccess: (response) => {
        if (response.status === "confirmation_required") {
          setReview({ request: change, challenge: response });
        }
      },
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Payment details"
      className="space-y-4 rounded-lg border border-stone-200 p-4"
    >
      <h3 className="text-sm font-semibold">
        {payee.details ? "Change payment details" : "Add payment details"}
      </h3>
      <p className="text-sm font-medium text-amber-800">{CHANGE_WARNING}</p>
      <PayeeDetailsFields
        organizationId={organizationId}
        kind={payee.kind}
        method={method}
        onMethodChange={(next) => {
          setMethod(next);
          request.reset();
        }}
        values={values}
        onValueChange={(field, value) =>
          setValues({ ...values, [field]: value })
        }
        errors={errors}
        disabled={request.isPending}
      />
      {request.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(request.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="submit"
          disabled={request.isPending}
          className={primaryButton}
        >
          {request.isPending ? "Checking…" : "Review"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={request.isPending}
          className={secondaryButton}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
