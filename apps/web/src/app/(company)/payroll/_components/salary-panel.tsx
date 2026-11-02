"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import type { Salary } from "@expendi-business/shared";
import {
  changeSalaryAmountRequestSchema,
  updateSalaryRequestSchema,
} from "@expendi-business/shared";

import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  inputClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { Field, StatusBadge } from "~/features/payment-ui";
import {
  useChangeSalaryAmount,
  useEndSalary,
  useUpdateSalary,
} from "~/features/payroll/payroll-api";
import {
  draftFromSalary,
  payDayInWords,
  SALARY_STATE_LABELS,
  toUpdateSalaryRequest,
} from "~/features/payroll/payroll-display";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { FieldError } from "./salary-form";
import { useCategories } from "./use-categories";

/** One salary; admins change net pay with their passkey, or end it. */
export function SalaryPanel({
  organizationId,
  salary,
  canAct,
  onClose,
}: {
  organizationId: string;
  salary: Salary;
  canAct: boolean;
  onClose: () => void;
}): JSX.Element {
  const state = SALARY_STATE_LABELS[salary.state];
  const editable = canAct && salary.state !== "ended";
  return (
    <section
      aria-label="Salary"
      className="space-y-5 rounded-lg border border-stone-200 bg-white p-4 xl:sticky xl:top-8"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold break-words">
            {salary.payee.name}
          </h3>
          <p className="mt-1 text-xl font-semibold tabular-nums">
            KES {formatKesCents(salary.amountKes)}{" "}
            <span className="text-sm font-normal text-stone-500">a month</span>
          </p>
          <div className="mt-2">
            <StatusBadge label={state.label} tone={state.tone} />
          </div>
        </div>
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="Pay day">{payDayInWords(salary.payDay)}</Field>
        <Field label="Next pay date">
          {salary.nextPayDate ? formatIsoDate(salary.nextPayDate) : "—"}
        </Field>
        <Field label="Started">{formatIsoDate(salary.startsOn)}</Field>
        {salary.endsOn ? (
          <Field label="Ends">{formatIsoDate(salary.endsOn)}</Field>
        ) : null}
        <Field label="Category">{salary.category.name}</Field>
        <Field label="Paid by">
          {salary.payee.method
            ? METHOD_LABELS[salary.payee.method]
            : "No payment details yet"}
          {salary.payee.payoutPhoneConfirmed === false ? (
            <span className="block text-xs text-amber-800">
              Hasn’t confirmed their M-Pesa number yet.
            </span>
          ) : null}
        </Field>
      </dl>
      {editable ? (
        <>
          <ApprovalPasskeyGate>
            <ChangeNetPay organizationId={organizationId} salary={salary} />
          </ApprovalPasskeyGate>
          <ChangePayDay organizationId={organizationId} salary={salary} />
          <EndSalary organizationId={organizationId} salary={salary} />
        </>
      ) : null}
    </section>
  );
}

function ChangeNetPay({
  organizationId,
  salary,
}: {
  organizationId: string;
  salary: Salary;
}): JSX.Element {
  const change = useChangeSalaryAmount(organizationId, salary.id);
  const [amount, setAmount] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = changeSalaryAmountRequestSchema.safeParse({
      amountKes: amount,
    });
    if (!parsed.success) {
      setTypedError(parsed.error.issues[0]?.message ?? "Enter the new pay.");
      return;
    }
    if (parsed.data.amountKes.toString() === salary.amountKes) {
      setTypedError("That’s already their net pay.");
      return;
    }
    setTypedError(null);
    change.mutate(amount.trim(), {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") setAmount("");
      },
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Change net pay"
      className="space-y-3 border-t border-stone-200 pt-4"
    >
      <h4 className="text-sm font-semibold">Change net pay</h4>
      <label className="block max-w-xs text-sm">
        New monthly net pay (KES)
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          placeholder={formatKesCents(salary.amountKes)}
          disabled={change.isPending}
          className={inputClass}
        />
      </label>
      <p className="text-sm text-stone-600">
        You confirm it with your passkey, and every admin gets an email. It
        applies from the next payroll run.
      </p>
      {typedError ? (
        <p className={alertClass} role="alert">
          {typedError}
        </p>
      ) : null}
      {change.data?.status === "approved" ? (
        <p className="text-sm text-stone-700" role="status">
          Saved. Net pay is now KES{" "}
          {formatKesCents(change.data.result.amountKes)}.
        </p>
      ) : null}
      {change.data?.status === "cancelled" ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing changed.</p>
      ) : null}
      {change.isError ? (
        <p className={alertClass} role="alert">
          {describeApprovalError(change.error)}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={change.isPending}
        className={primaryButton}
      >
        {change.isPending ? "Waiting for your passkey…" : "Change with passkey"}
      </button>
    </form>
  );
}

function ChangePayDay({
  organizationId,
  salary,
}: {
  organizationId: string;
  salary: Salary;
}): JSX.Element {
  const categories = useCategories(organizationId);
  const update = useUpdateSalary(organizationId, salary.id);
  const [draft, setDraft] = useState(() => draftFromSalary(salary));
  const [typedError, setTypedError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = toUpdateSalaryRequest(salary, draft);
    const parsed = updateSalaryRequestSchema.safeParse(request);
    if (!parsed.success) {
      setTypedError(parsed.error.issues[0]?.message ?? "Nothing changed.");
      return;
    }
    setTypedError(null);
    update.mutate(request);
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Change pay day or category"
      className="grid gap-3 border-t border-stone-200 pt-4 sm:grid-cols-2"
    >
      <h4 className="text-sm font-semibold sm:col-span-2">
        Pay day and category
      </h4>
      <label className="text-sm">
        Pay day (1 to 31)
        <input
          value={draft.payDay}
          onChange={(event) =>
            setDraft({ ...draft, payDay: event.target.value })
          }
          inputMode="numeric"
          maxLength={2}
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        Category
        <select
          value={draft.categoryId ?? ""}
          onChange={(event) =>
            setDraft({ ...draft, categoryId: event.target.value || null })
          }
          className={inputClass}
        >
          {categories.data?.some(
            (category) => category.id === salary.category.id,
          ) ? null : (
            <option value={salary.category.id}>{salary.category.name}</option>
          )}
          {categories.data?.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
        <FieldError
          message={
            categories.isError ? describeApiError(categories.error) : undefined
          }
        />
      </label>
      <p className="text-sm text-stone-600 sm:col-span-2">
        A new pay day applies from the next pay date not yet drafted.
      </p>
      {typedError ? (
        <p className={`${alertClass} sm:col-span-2`} role="alert">
          {typedError}
        </p>
      ) : null}
      {update.isError ? (
        <p className={`${alertClass} sm:col-span-2`} role="alert">
          {describeApiError(update.error)}
        </p>
      ) : null}
      {update.isSuccess ? (
        <p className="text-sm text-stone-700 sm:col-span-2" role="status">
          Saved.
        </p>
      ) : null}
      <div className="sm:col-span-2">
        <button
          type="submit"
          disabled={update.isPending}
          className={secondaryButton}
        >
          {update.isPending ? "Saving…" : "Save"}
        </button>
      </div>
    </form>
  );
}

function EndSalary({
  organizationId,
  salary,
}: {
  organizationId: string;
  salary: Salary;
}): JSX.Element {
  const end = useEndSalary(organizationId, salary.id);
  const [confirming, setConfirming] = useState(false);

  if (!confirming) {
    return (
      <div className="border-t border-stone-200 pt-4">
        <button
          type="button"
          onClick={() => {
            end.reset();
            setConfirming(true);
          }}
          className={secondaryButton}
        >
          End salary
        </button>
      </div>
    );
  }
  return (
    <div className="space-y-3 border-t border-stone-200 pt-4 text-sm">
      <p className="font-medium">End {salary.payee.name}’s salary?</p>
      <p className="text-stone-600">
        They won’t be in payroll runs drafted from now on. Payments already made
        stay in the history. Ending is final.
      </p>
      {end.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(end.error)}
        </p>
      ) : null}
      <div className="flex gap-3">
        <button
          type="button"
          disabled={end.isPending}
          onClick={() =>
            end.mutate(undefined, { onSuccess: () => setConfirming(false) })
          }
          className={primaryButton}
        >
          {end.isPending ? "Ending…" : "End salary"}
        </button>
        <button
          type="button"
          disabled={end.isPending}
          onClick={() => setConfirming(false)}
          className={secondaryButton}
        >
          Keep it
        </button>
      </div>
    </div>
  );
}
