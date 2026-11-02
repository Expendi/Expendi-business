"use client";

import type { FormEvent, JSX } from "react";
import Link from "next/link";
import { useState } from "react";

import type { Salary } from "@expendi-business/shared";
import { createSalaryRequestSchema } from "@expendi-business/shared";

import type { SalaryDraft } from "~/features/payroll/payroll-display";
import {
  alertClass,
  inputClass,
  linkClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import { useCreateSalary } from "~/features/payroll/payroll-api";
import {
  blankSalaryDraft,
  canBePaidSalary,
  salaryPayees,
  toCreateSalaryRequest,
} from "~/features/payroll/payroll-display";
import { describeApiError } from "~/lib/api";
import { QueryError } from "./query-error";
import { useCategories } from "./use-categories";

type FieldErrors = Partial<Record<keyof SalaryDraft | "form", string>>;

function errorsFrom(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): FieldErrors {
  const fields: readonly (keyof SalaryDraft)[] = [
    "payeeId",
    "amount",
    "payDay",
    "startsOn",
    "categoryId",
  ];
  const errors: FieldErrors = {};
  for (const issue of issues) {
    const key = issue.path[0] === "amountKes" ? "amount" : issue.path[0];
    const field = fields.find((name) => name === key) ?? "form";
    errors[field] ??= issue.message;
  }
  return errors;
}

/**
 * Puts an employee or other personnel on payroll (spec §6.21). They need
 * a confirmed M-Pesa number or a bank account as a payee first, and at
 * most one salary each.
 */
export function AddSalaryForm({
  organizationId,
  salaries,
  onClose,
  onAdded,
}: {
  organizationId: string;
  salaries: readonly Salary[];
  onClose: () => void;
  onAdded: (salary: Salary) => void;
}): JSX.Element {
  const payees = usePayees(organizationId, ACTIVE_PAYEES);
  const categories = useCategories(organizationId);
  const create = useCreateSalary(organizationId);
  const [draft, setDraft] = useState<SalaryDraft>(() => blankSalaryDraft(""));
  const [errors, setErrors] = useState<FieldErrors>({});

  const onPayroll = new Set(
    salaries
      .filter((salary) => salary.state !== "ended")
      .map((salary) => salary.payee.id),
  );
  const eligible = salaryPayees(payees.data ?? []).filter(
    (payee) => canBePaidSalary(payee) && !onPayroll.has(payee.id),
  );

  function update(changes: Partial<SalaryDraft>) {
    setDraft((current) => ({ ...current, ...changes }));
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = toCreateSalaryRequest(draft);
    const parsed = createSalaryRequestSchema.safeParse(request);
    if (!parsed.success) {
      setErrors(errorsFrom(parsed.error.issues));
      return;
    }
    setErrors({});
    create.mutate(request, { onSuccess: onAdded });
  }

  return (
    <section
      aria-label="Add salary"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <h3 className="text-base font-semibold">Add salary</h3>
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      {payees.isPending || categories.isPending ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : payees.isError || categories.isError ? (
        <div className="mt-3">
          <QueryError
            error={payees.error ?? categories.error}
            onRetry={() => {
              void payees.refetch();
              void categories.refetch();
            }}
          />
        </div>
      ) : eligible.length === 0 ? (
        <p className="mt-3 text-sm text-stone-600">
          Everyone who can be paid a salary is already on payroll. Add employees
          or other personnel under{" "}
          <Link href="/payees" className={linkClass}>
            Payees
          </Link>
          , paid to their confirmed M-Pesa number or a bank account.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-3 grid gap-4 sm:grid-cols-2">
          <label className="text-sm sm:col-span-2">
            Who
            <select
              value={draft.payeeId ?? ""}
              onChange={(event) =>
                update({ payeeId: event.target.value || null })
              }
              className={inputClass}
            >
              <option value="">Choose a person</option>
              {eligible.map((payee) => (
                <option key={payee.id} value={payee.id}>
                  {payee.name}
                </option>
              ))}
            </select>
            <FieldError message={errors.payeeId} />
          </label>
          <label className="text-sm">
            Monthly net pay (KES)
            <input
              value={draft.amount}
              onChange={(event) => update({ amount: event.target.value })}
              inputMode="decimal"
              placeholder="45,000.00"
              className={inputClass}
            />
            <FieldError message={errors.amount} />
          </label>
          <label className="text-sm">
            Pay day (1 to 31)
            <input
              value={draft.payDay}
              onChange={(event) => update({ payDay: event.target.value })}
              inputMode="numeric"
              maxLength={2}
              className={inputClass}
            />
            <FieldError message={errors.payDay} />
          </label>
          <label className="text-sm">
            Starts on
            <input
              type="date"
              value={draft.startsOn}
              onChange={(event) => update({ startsOn: event.target.value })}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-stone-500">
              Leave blank to start today.
            </span>
            <FieldError message={errors.startsOn} />
          </label>
          <label className="text-sm">
            Category
            <select
              value={draft.categoryId ?? ""}
              onChange={(event) =>
                update({ categoryId: event.target.value || null })
              }
              className={inputClass}
            >
              <option value="">Choose a category</option>
              {categories.data.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
            <FieldError message={errors.categoryId} />
          </label>
          {errors.form ? (
            <p className={`${alertClass} sm:col-span-2`} role="alert">
              {errors.form}
            </p>
          ) : null}
          {create.isError ? (
            <p className={`${alertClass} sm:col-span-2`} role="alert">
              {describeApiError(create.error)}
            </p>
          ) : null}
          <div className="flex gap-3 sm:col-span-2">
            <button
              type="submit"
              disabled={create.isPending}
              className={primaryButton}
            >
              {create.isPending ? "Adding…" : "Add salary"}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={create.isPending}
              className={secondaryButton}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}

export function FieldError({
  message,
}: {
  message: string | undefined;
}): JSX.Element | null {
  return message ? (
    <span className="mt-1 block text-xs text-error-700">{message}</span>
  ) : null;
}
