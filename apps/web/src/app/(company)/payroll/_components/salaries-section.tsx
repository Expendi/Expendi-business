"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { Salary } from "@expendi-business/shared";

import {
  cellClass,
  headCellClass,
  primaryButton,
  tableClass,
} from "~/components/styles";
import { StatusBadge } from "~/features/payment-ui";
import { useSalaries } from "~/features/payroll/payroll-api";
import {
  payDayInWords,
  SALARY_STATE_LABELS,
} from "~/features/payroll/payroll-display";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { QueryError } from "./query-error";
import { AddSalaryForm } from "./salary-form";
import { SalaryPanel } from "./salary-panel";

type Opened = { kind: "salary"; salaryId: string } | { kind: "new" };

/** Everyone on payroll and their monthly net pay (spec §6.21). */
export function SalariesSection({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const salaries = useSalaries(organizationId);
  const [opened, setOpened] = useState<Opened | null>(null);
  const openedSalary =
    opened?.kind === "salary"
      ? salaries.data?.find((salary) => salary.id === opened.salaryId)
      : undefined;

  return (
    <section aria-label="Salaries" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Salaries</h2>
          <p className="text-sm text-stone-600">
            Monthly net pay. Expendi pays what’s entered and doesn’t calculate
            tax.
          </p>
        </div>
        {canAct ? (
          <button
            type="button"
            onClick={() => setOpened({ kind: "new" })}
            disabled={opened?.kind === "new"}
            className={primaryButton}
          >
            Add salary
          </button>
        ) : null}
      </div>

      {salaries.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : salaries.isError ? (
        <QueryError
          error={salaries.error}
          onRetry={() => void salaries.refetch()}
        />
      ) : (
        <div
          className={`grid gap-6 ${opened ? "xl:grid-cols-2" : ""} xl:items-start`}
        >
          {salaries.data.length === 0 ? (
            <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
              Nobody is on payroll yet.
            </p>
          ) : (
            <SalaryTable
              salaries={salaries.data}
              openedId={openedSalary?.id ?? null}
              onOpen={(salaryId) => setOpened({ kind: "salary", salaryId })}
            />
          )}
          {opened?.kind === "new" ? (
            <AddSalaryForm
              organizationId={organizationId}
              salaries={salaries.data}
              onClose={() => setOpened(null)}
              onAdded={(salary) =>
                setOpened({ kind: "salary", salaryId: salary.id })
              }
            />
          ) : openedSalary ? (
            <SalaryPanel
              key={openedSalary.id}
              organizationId={organizationId}
              salary={openedSalary}
              canAct={canAct}
              onClose={() => setOpened(null)}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function SalaryTable({
  salaries,
  openedId,
  onOpen,
}: {
  salaries: readonly Salary[];
  openedId: string | null;
  onOpen: (salaryId: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Person
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              Net pay, KES
            </th>
            <th scope="col" className={headCellClass}>
              Pay day
            </th>
            <th scope="col" className={headCellClass}>
              Next pay date
            </th>
            <th scope="col" className={headCellClass}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {salaries.map((salary) => {
            const state = SALARY_STATE_LABELS[salary.state];
            return (
              <tr
                key={salary.id}
                className={`border-t border-stone-200 align-top ${salary.id === openedId ? "bg-brand-50" : ""}`}
              >
                <td className={cellClass}>
                  <button
                    type="button"
                    onClick={() => onOpen(salary.id)}
                    aria-pressed={salary.id === openedId}
                    className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
                  >
                    {salary.payee.name}
                  </button>
                  <span className="block text-xs text-stone-500">
                    {salary.category.name}
                  </span>
                  {salary.payee.payoutPhoneConfirmed === false ? (
                    <span className="block text-xs text-amber-800">
                      Hasn’t confirmed their M-Pesa number yet.
                    </span>
                  ) : null}
                </td>
                <td
                  className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
                >
                  {formatKesCents(salary.amountKes)}
                </td>
                <td className={cellClass}>{payDayInWords(salary.payDay)}</td>
                <td className={`${cellClass} whitespace-nowrap`}>
                  {salary.nextPayDate ? formatIsoDate(salary.nextPayDate) : "—"}
                </td>
                <td className={cellClass}>
                  <StatusBadge label={state.label} tone={state.tone} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
