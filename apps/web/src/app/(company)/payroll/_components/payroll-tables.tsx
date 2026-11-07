"use client";

import type { JSX } from "react";
import {
  PencilIcon,
  PlusIcon,
  TriangleAlertIcon,
  UsersIcon,
} from "lucide-react";

import type { PayrollRun, Salary } from "@expendi-business/shared";

import type { SortState } from "~/components/data/table";
import type {
  RunSortKey,
  SalarySortKey,
} from "~/features/payroll/payroll-display";
import { AmountStack, Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
  nextSort,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  Td,
  Th,
} from "~/components/data/table";
import { KIND_LABELS, METHOD_LABELS } from "~/features/payees/payee-display";
import {
  payDayInWords,
  RUN_SORT_FIRST,
  RUN_STATUS_LABELS,
  runMeta,
  SALARY_SORT_FIRST,
  SALARY_STATE_LABELS,
  UNCONFIRMED_NUMBER,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { formatIsoDate } from "~/lib/dates";

/** How the draft changed: "2 changed for this run" and one-offs. */
function RunMarks({ run }: { run: PayrollRun }): JSX.Element | null {
  if (run.adjusted === 0 && run.oneOffs === 0) return null;
  return (
    <>
      {run.adjusted > 0 ? (
        <Mini
          icon={PencilIcon}
          label={`${String(run.adjusted)} changed for this run`}
        >
          {run.adjusted}
        </Mini>
      ) : null}
      {run.oneOffs > 0 ? (
        <Mini
          icon={PlusIcon}
          label={`${String(run.oneOffs)} one-off ${run.oneOffs === 1 ? "payment" : "payments"}`}
        >
          {run.oneOffs}
        </Mini>
      ) : null}
    </>
  );
}

/** Payroll runs, latest pay day first; each opens its sheet. */
export function RunsTable({
  rows,
  sort,
  onSort,
  openId,
  onOpen,
  today,
}: {
  rows: readonly PayrollRun[];
  sort: SortState<RunSortKey>;
  onSort: (sort: SortState<RunSortKey>) => void;
  openId: string | null;
  onOpen: (runId: string) => void;
  today: string;
}): JSX.Element {
  const sortBy = (key: RunSortKey) =>
    onSort(nextSort(sort, key, RUN_SORT_FIRST[key]));
  return (
    <>
      <DataTable caption="Payroll runs, latest pay day first">
        <thead>
          <tr>
            <SortHeader
              label="Pay day"
              sortKey="payDate"
              sort={sort}
              onSort={sortBy}
            />
            <Th collapse="md">Payments</Th>
            <SortHeader
              label="Total"
              sortKey="total"
              align="end"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              onSort={sortBy}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((run) => {
            const status = RUN_STATUS_LABELS[run.status];
            const progress = progressInWords(run);
            return (
              <DataRow
                key={run.id}
                open={run.id === openId}
                onOpen={() => onOpen(run.id)}
              >
                <Td kind="main">
                  <RowTitle onOpen={() => onOpen(run.id)}>
                    <span className="tabular-nums">
                      {formatIsoDate(run.payDate)}
                    </span>
                  </RowTitle>
                  <RowMeta text={runMeta(run, today)}>
                    <RunMarks run={run} />
                  </RowMeta>
                </Td>
                <Td
                  collapse="md"
                  className={
                    progress
                      ? "whitespace-nowrap text-gray-600 tabular-nums"
                      : "whitespace-nowrap text-gray-500"
                  }
                >
                  {progress ?? "Not approved yet"}
                </Td>
                <Td align="end">
                  <AmountStack>
                    <Money amount={run.totalKes} currency="KES" />
                  </AmountStack>
                </Td>
                <Td>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Payroll runs">
        {rows.map((run) => {
          const status = RUN_STATUS_LABELS[run.status];
          return (
            <PhoneCard
              key={run.id}
              mark={
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 flex-none items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-600"
                >
                  <UsersIcon className="size-4" />
                </span>
              }
              title={formatIsoDate(run.payDate)}
              sub={progressInWords(run) ?? runMeta(run, today)}
              flags={
                <>
                  <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
                  <RunMarks run={run} />
                </>
              }
              aside={
                <AmountStack>
                  <Money amount={run.totalKes} currency="KES" />
                </AmountStack>
              }
              onOpen={() => onOpen(run.id)}
            />
          );
        })}
      </PhoneCards>
    </>
  );
}

function SalaryMeta({ salary }: { salary: Salary }): JSX.Element {
  if (salary.payee.payoutPhoneConfirmed === false && salary.state !== "ended") {
    return (
      <span className="flex min-w-0 items-center gap-1.5 text-warn-700">
        <TriangleAlertIcon aria-hidden="true" className="size-3.5 flex-none" />
        <span className="min-w-0 truncate">{UNCONFIRMED_NUMBER}</span>
      </span>
    );
  }
  return (
    <RowMeta
      text={`${KIND_LABELS[salary.payee.kind]} · ${salary.category.name}`}
    />
  );
}

/** Everyone on payroll, A to Z with ended salaries last. */
export function SalariesTable({
  rows,
  sort,
  onSort,
  openId,
  onOpen,
}: {
  rows: readonly Salary[];
  sort: SortState<SalarySortKey>;
  onSort: (sort: SortState<SalarySortKey>) => void;
  openId: string | null;
  onOpen: (salaryId: string) => void;
}): JSX.Element {
  const sortBy = (key: SalarySortKey) =>
    onSort(nextSort(sort, key, SALARY_SORT_FIRST[key]));
  return (
    <>
      <DataTable caption="Salaries, monthly net pay">
        <thead>
          <tr>
            <SortHeader
              label="Person"
              sortKey="person"
              sort={sort}
              onSort={sortBy}
            />
            <Th collapse="lg">Paid by</Th>
            <SortHeader
              label="Next pay date"
              sortKey="next"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Net pay"
              sortKey="amount"
              align="end"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Status"
              sortKey="status"
              sort={sort}
              onSort={sortBy}
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((salary) => {
            const state = SALARY_STATE_LABELS[salary.state];
            return (
              <DataRow
                key={salary.id}
                open={salary.id === openId}
                onOpen={() => onOpen(salary.id)}
              >
                <Td kind="main">
                  <span className="flex min-w-0 items-start gap-3">
                    <EntityMark name={salary.payee.name} kind="person" />
                    <span className="min-w-0">
                      <RowTitle onOpen={() => onOpen(salary.id)}>
                        {salary.payee.name}
                      </RowTitle>
                      <SalaryMeta salary={salary} />
                    </span>
                  </span>
                </Td>
                <Td collapse="lg" className="whitespace-nowrap text-gray-600">
                  {salary.payee.method
                    ? METHOD_LABELS[salary.payee.method]
                    : "Not set"}
                </Td>
                <Td kind="date">
                  {salary.nextPayDate ? formatIsoDate(salary.nextPayDate) : ""}
                  <span className="mt-0.5 block text-xs leading-4 text-gray-500">
                    {salary.state === "ended" && salary.endsOn
                      ? `Ended ${formatIsoDate(salary.endsOn)}`
                      : payDayInWords(salary.payDay)}
                  </span>
                </Td>
                <Td align="end">
                  <AmountStack>
                    <Money amount={salary.amountKes} currency="KES" />
                  </AmountStack>
                </Td>
                <Td>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Salaries">
        {rows.map((salary) => {
          const state = SALARY_STATE_LABELS[salary.state];
          const unconfirmed =
            salary.payee.payoutPhoneConfirmed === false &&
            salary.state !== "ended";
          return (
            <PhoneCard
              key={salary.id}
              mark={<EntityMark name={salary.payee.name} kind="person" />}
              title={salary.payee.name}
              sub={
                salary.nextPayDate
                  ? `Next pay date ${formatIsoDate(salary.nextPayDate)}`
                  : salary.endsOn
                    ? `Ended ${formatIsoDate(salary.endsOn)}`
                    : null
              }
              flags={
                <>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  {unconfirmed ? (
                    <Mini
                      icon={TriangleAlertIcon}
                      label={UNCONFIRMED_NUMBER}
                      warn
                    />
                  ) : null}
                </>
              }
              aside={
                <AmountStack>
                  <Money amount={salary.amountKes} currency="KES" />
                </AmountStack>
              }
              onOpen={() => onOpen(salary.id)}
            />
          );
        })}
      </PhoneCards>
    </>
  );
}
