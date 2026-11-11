"use client";

import type { JSX } from "react";
import {
  CalendarIcon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FilterXIcon,
  KeyRoundIcon,
  PlusIcon,
  ShieldCheckIcon,
  TagIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  PayrollRun,
  PayrollRunStatus,
  Salary,
} from "@expendi-business/shared";
import {
  PAYROLL_DRAFT_LEAD_DAYS,
  SALARY_PAYEE_METHODS,
} from "@expendi-business/shared";

import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type { PasskeyState } from "~/features/payment-ui";
import { Banner, Banners } from "~/components/data/banner";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { Money } from "~/components/data/money";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState } from "~/components/data/states";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import {
  usePayrollMargin,
  usePayrollRuns,
  useSalaries,
} from "~/features/payroll/payroll-api";
import {
  addDays,
  DEFAULT_RUN_SORT,
  DEFAULT_SALARY_SORT,
  nairobiToday,
  payDayInWords,
  RUN_STATUS_LABELS,
  SALARY_STATE_LABELS,
  sortRuns,
  sortSalaries,
  waitingRuns,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { formatIsoDate } from "~/lib/dates";
import { sumUnits } from "~/lib/money";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { CapSheet } from "./cap-sheet";
import {
  PayrollTableSkeleton,
  RunsTable,
  SalariesTable,
} from "./payroll-tables";
import { RunSheet } from "./run-sheet";
import { SalarySheet } from "./salary-sheet";

type PayrollTab = "runs" | "salaries";

type Param =
  "view" | "status" | "payday" | "method" | "category" | "runId" | "salaryId";

const FILTERS = ["status", "payday", "method", "category"] as const;
type FilterName = (typeof FILTERS)[number];
type Filters = Readonly<Record<FilterName, string | null>>;

const NO_FILTERS = {
  status: null,
  payday: null,
  method: null,
  category: null,
} as const;

const RUN_STATUS_ORDER: readonly PayrollRunStatus[] = [
  "draft",
  "partly_failed",
  "paying",
  "paid",
];

const SALARY_STATE_ORDER: readonly Salary["state"][] = [
  "active",
  "paused",
  "ended",
];

const EMPTY: Record<PayrollTab, { title: string; text: string }> = {
  runs: {
    title: "No payroll runs yet",
    text: "The first one is drafted before the next pay day.",
  },
  salaries: {
    title: "Nobody is on payroll yet",
    text: "Monthly net pay. Expendi pays what’s entered and doesn’t calculate tax.",
  },
};

/**
 * Payroll (spec §6.21): draft runs with their adjustments, Approve & pay
 * all with one passkey, salaries and the payroll cap. Accountants see
 * everything, salaries included, with no actions (spec §6.14). The tab,
 * filters and the open run or salary live in the URL.
 */
export function PayrollView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyPayroll
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyPayroll({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const runs = usePayrollRuns(organizationId);
  const salaries = useSalaries(organizationId);
  const margin = usePayrollMargin(organizationId);
  const passkeyStatus = useApprovalPasskeyStatus(canAct);
  const [param, setParams] = useDeepLinkParams<Param>();
  const [runSort, setRunSort] = useState(DEFAULT_RUN_SORT);
  const [salarySort, setSalarySort] = useState(DEFAULT_SALARY_SORT);
  const [panel, setPanel] = useState<"new-salary" | "cap" | null>(null);
  const today = nairobiToday();

  const passkey: PasskeyState = !canAct
    ? "none"
    : passkeyStatus.data === undefined
      ? "checking"
      : passkeyStatus.data.enrolled
        ? "ready"
        : "missing";
  const tab: PayrollTab = param("view") === "salaries" ? "salaries" : "runs";
  const filters = readFilters(tab, param);
  const anyFilter = FILTERS.some((name) => filters[name] !== null);
  const loading = runs.isPending || salaries.isPending || margin.isPending;
  const failed = runs.isError || salaries.isError || margin.isError;
  const allRuns = useMemo(() => runs.data ?? [], [runs.data]);
  const allSalaries = useMemo(() => salaries.data ?? [], [salaries.data]);

  const { status, payday, method, category } = filters;
  const runRows = useMemo(
    () =>
      sortRuns(
        allRuns.filter((run) => status === null || run.status === status),
        runSort,
      ),
    [allRuns, status, runSort],
  );
  const salaryRows = useMemo(
    () =>
      sortSalaries(
        allSalaries.filter((salary) =>
          matchesSalary(salary, { status, payday, method, category }),
        ),
        salarySort,
      ),
    [allSalaries, status, payday, method, category, salarySort],
  );
  const runIds = (
    tab === "runs" ? runRows : sortRuns(allRuns, DEFAULT_RUN_SORT)
  ).map((run) => run.id);
  const salaryIds = (
    tab === "salaries"
      ? salaryRows
      : sortSalaries(allSalaries, DEFAULT_SALARY_SORT)
  ).map((salary) => salary.id);

  const runId = param("runId");
  const openRun = runId ? allRuns.find((run) => run.id === runId) : undefined;
  const salaryId = openRun ? null : param("salaryId");
  const salarySheetOpen =
    !loading && (salaryId !== null || panel === "new-salary");

  function changeTab(next: PayrollTab) {
    setParams({ ...NO_FILTERS, view: next === "salaries" ? next : null });
  }

  function openRunSheet(id: string) {
    setParams({ runId: id, salaryId: null });
  }

  function retry() {
    void runs.refetch();
    void salaries.refetch();
    void margin.refetch();
  }

  const tabs: readonly KindTab<PayrollTab>[] = [
    {
      value: "runs",
      label: "Payroll runs",
      count: loading || failed ? undefined : allRuns.length,
    },
    {
      value: "salaries",
      label: "Salaries",
      count: loading || failed ? undefined : allSalaries.length,
    },
  ];

  return (
    <section>
      <PageHeader
        title="Payroll"
        subtitle={
          canAct
            ? "Check each draft run, change it for this run only, then approve and pay everyone with one passkey. Each person is paid on their own."
            : "Payroll runs, everyone’s pay and the payroll cap. Only admins change or pay them."
        }
        actions={
          canAct ? (
            <>
              <Button
                variant="outline"
                size="md"
                onClick={() => setPanel("cap")}
              >
                <ShieldCheckIcon aria-hidden="true" />
                Payroll cap
              </Button>
              <Button size="md" onClick={() => setPanel("new-salary")}>
                <PlusIcon aria-hidden="true" />
                Add salary
              </Button>
            </>
          ) : null
        }
      />

      {loading || failed ? null : (
        <PayrollBanners
          runs={allRuns}
          canAct={canAct}
          passkey={passkey}
          onOpenRun={openRunSheet}
        />
      )}

      {failed ? null : margin.data === undefined || loading ? (
        <StatCards>
          {Array.from({ length: 4 }, (_, at) => (
            <StatCardSkeleton key={at} />
          ))}
        </StatCards>
      ) : (
        <PayrollStats
          runs={allRuns}
          salaries={allSalaries}
          marginPct={margin.data.marginPct}
        />
      )}

      <ResultsPanel label="Payroll">
        <ResultsHead
          tabs={
            <KindTabs
              label="Payroll"
              tabs={tabs}
              value={tab}
              onChange={changeTab}
              controls="payroll-results"
            />
          }
          chips={
            <PayrollChips
              tab={tab}
              filters={filters}
              salaries={allSalaries}
              disabled={loading || failed}
              onChange={(name, value) => setParams({ [name]: value })}
            />
          }
          onClearAll={anyFilter ? () => setParams(NO_FILTERS) : undefined}
        />
        <ResultsBody id="payroll-results" busy={loading}>
          {loading ? (
            <PayrollTableSkeleton />
          ) : failed ? (
            <ErrorState title="Payroll didn't load" onRetry={retry} />
          ) : (tab === "runs" ? runRows : salaryRows).length === 0 ? (
            <EmptyState
              icon={
                anyFilter
                  ? FilterXIcon
                  : tab === "runs"
                    ? CalendarIcon
                    : UsersIcon
              }
              title={
                anyFilter
                  ? `No ${tab === "runs" ? "runs" : "salaries"} match these filters`
                  : EMPTY[tab].title
              }
              action={
                anyFilter ? (
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => setParams(NO_FILTERS)}
                  >
                    Clear all
                  </Button>
                ) : canAct && allSalaries.length === 0 ? (
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => setPanel("new-salary")}
                  >
                    <PlusIcon aria-hidden="true" />
                    Add salary
                  </Button>
                ) : null
              }
            >
              {anyFilter ? null : EMPTY[tab].text}
            </EmptyState>
          ) : tab === "runs" ? (
            <RunsTable
              rows={runRows}
              sort={runSort}
              onSort={setRunSort}
              openId={openRun?.id ?? null}
              onOpen={openRunSheet}
              today={today}
            />
          ) : (
            <SalariesTable
              rows={salaryRows}
              sort={salarySort}
              onSort={setSalarySort}
              openId={salaryId}
              onOpen={(id) => setParams({ salaryId: id, runId: null })}
            />
          )}
        </ResultsBody>
      </ResultsPanel>

      {openRun ? (
        <RunSheet
          organizationId={organizationId}
          run={openRun}
          index={runIds.indexOf(openRun.id)}
          total={runIds.length}
          onStep={(delta) => {
            const next = runIds[runIds.indexOf(openRun.id) + delta];
            if (next) openRunSheet(next);
          }}
          onClose={() => setParams({ runId: null })}
          canAct={canAct}
          passkey={passkey}
        />
      ) : null}

      {salarySheetOpen ? (
        <SalarySheet
          organizationId={organizationId}
          salaryId={salaryId}
          salaries={allSalaries}
          index={salaryId ? salaryIds.indexOf(salaryId) : -1}
          total={salaryIds.length}
          onStep={(delta) => {
            const at = salaryId ? salaryIds.indexOf(salaryId) : -1;
            const next = salaryIds[at + delta];
            if (next) setParams({ salaryId: next });
          }}
          onCreated={(salary) => {
            setSalarySort(DEFAULT_SALARY_SORT);
            setParams({
              ...NO_FILTERS,
              view: "salaries",
              runId: null,
              salaryId: salary.id,
            });
          }}
          onClose={() => {
            setPanel(null);
            setParams({ salaryId: null });
          }}
          canAct={canAct}
          passkey={passkey}
          today={today}
        />
      ) : null}

      {panel === "cap" ? (
        <CapSheet
          organizationId={organizationId}
          marginPct={margin.data?.marginPct ?? null}
          passkey={passkey}
          onClose={() => setPanel(null)}
        />
      ) : null}
    </section>
  );
}

/** The URL's filters for this tab; anything that doesn't fit it is ignored. */
function readFilters(
  tab: PayrollTab,
  param: (name: Param) => string | null,
): Filters {
  const status = param("status");
  if (tab === "runs") {
    return {
      ...NO_FILTERS,
      status: RUN_STATUS_ORDER.find((known) => known === status) ?? null,
    };
  }
  const payday = param("payday");
  return {
    status: SALARY_STATE_ORDER.find((known) => known === status) ?? null,
    payday: payday && /^\d{1,2}$/.test(payday) ? payday : null,
    method:
      SALARY_PAYEE_METHODS.find((known) => known === param("method")) ?? null,
    category: param("category"),
  };
}

function matchesSalary(salary: Salary, filters: Filters): boolean {
  return (
    (filters.status === null || salary.state === filters.status) &&
    (filters.payday === null || String(salary.payDay) === filters.payday) &&
    (filters.method === null || salary.payee.method === filters.method) &&
    (filters.category === null || salary.category.id === filters.category)
  );
}

function PayrollChips({
  tab,
  filters,
  salaries,
  disabled,
  onChange,
}: {
  tab: PayrollTab;
  filters: Filters;
  salaries: readonly Salary[];
  disabled: boolean;
  onChange: (name: FilterName, value: string | null) => void;
}): JSX.Element {
  if (tab === "runs") {
    return (
      <FilterChip
        label="Status"
        icon={ClockIcon}
        options={RUN_STATUS_ORDER.map((value) => ({
          value,
          ...RUN_STATUS_LABELS[value],
        }))}
        value={filters.status}
        onChange={(value) => onChange("status", value)}
        anyLabel="Any status"
        disabled={disabled}
      />
    );
  }
  const payDays = [...new Set(salaries.map((salary) => salary.payDay))].sort(
    (a, b) => a - b,
  );
  const categories = new Map(
    salaries.map((salary) => [salary.category.id, salary.category.name]),
  );
  const categoryOptions: FilterOption[] = [...categories]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return (
    <>
      <FilterChip
        label="Status"
        icon={ClockIcon}
        options={SALARY_STATE_ORDER.map((value) => ({
          value,
          ...SALARY_STATE_LABELS[value],
        }))}
        value={filters.status}
        onChange={(value) => onChange("status", value)}
        anyLabel="Any status"
        disabled={disabled}
      />
      <FilterChip
        label="Pay day"
        icon={CalendarIcon}
        options={payDays.map((day) => ({
          value: String(day),
          label: payDayInWords(day),
        }))}
        value={filters.payday}
        onChange={(value) => onChange("payday", value)}
        anyLabel="Any pay day"
        disabled={disabled}
      />
      <FilterChip
        label="Paid by"
        icon={WalletIcon}
        options={SALARY_PAYEE_METHODS.map((value) => ({
          value,
          label: METHOD_LABELS[value],
        }))}
        value={filters.method}
        onChange={(value) => onChange("method", value)}
        anyLabel="Any method"
        disabled={disabled}
      />
      <FilterChip
        label="Category"
        icon={TagIcon}
        options={categoryOptions}
        value={filters.category}
        onChange={(value) => onChange("category", value)}
        anyLabel="All categories"
        disabled={disabled}
      />
    </>
  );
}

/** Plain numbers for the whole payroll; filtering lives in the chips. */
function PayrollStats({
  runs,
  salaries,
  marginPct,
}: {
  runs: readonly PayrollRun[];
  salaries: readonly Salary[];
  marginPct: number;
}): JSX.Element {
  const active = salaries.filter((salary) => salary.state === "active");
  const monthly = sumUnits(active.map((salary) => salary.amountKes));
  const draft = runs
    .filter((run) => run.status === "draft")
    .sort((a, b) => a.payDate.localeCompare(b.payDate))[0];
  const nextSalary = active
    .map((salary) => salary.nextPayDate)
    .filter((date) => date !== null)
    .sort()[0];
  const last = runs
    .filter((run) => run.approvedAt !== null)
    .sort((a, b) => b.payDate.localeCompare(a.payDate))[0];

  return (
    <StatCards>
      <StatCard
        icon={UsersIcon}
        tone="total"
        label="On payroll"
        value={String(active.length)}
        sub={
          active.length > 0 ? (
            <>
              <Money amount={monthly} currency="KES" /> a month
            </>
          ) : (
            "Nobody yet"
          )
        }
      />
      {draft && (nextSalary === undefined || draft.payDate <= nextSalary) ? (
        <StatCard
          icon={CalendarIcon}
          tone="attention"
          label="Next pay day"
          value={formatIsoDate(draft.payDate)}
          sub={
            <>
              Draft · <Money amount={draft.totalKes} currency="KES" />
            </>
          }
        />
      ) : nextSalary ? (
        <StatCard
          icon={CalendarIcon}
          tone="total"
          label="Next pay day"
          value={formatIsoDate(nextSalary)}
          sub={`Drafted on ${formatIsoDate(addDays(nextSalary, -PAYROLL_DRAFT_LEAD_DAYS))}`}
        />
      ) : (
        <StatCard
          icon={CalendarIcon}
          tone="total"
          label="Next pay day"
          value="None yet"
          sub="No salaries set up"
        />
      )}
      {last ? (
        <StatCard
          icon={last.status === "partly_failed" ? CircleAlertIcon : CheckIcon}
          tone={
            last.status === "partly_failed"
              ? "danger"
              : last.status === "paid"
                ? "clear"
                : "total"
          }
          label="Last run"
          value={formatIsoDate(last.payDate)}
          sub={
            <>
              <Money amount={last.totalKes} currency="KES" />,{" "}
              {progressInWords(last)}
            </>
          }
        />
      ) : (
        <StatCard
          icon={CheckIcon}
          tone="total"
          label="Last run"
          value="None yet"
          sub="No runs paid yet"
        />
      )}
      <StatCard
        icon={ShieldCheckIcon}
        tone="total"
        label="Payroll cap"
        value={`${String(marginPct)}%`}
        sub="Margin above each run’s salaries"
      />
    </StatCards>
  );
}

/** The passkey gate, and each run waiting for the admin. */
function PayrollBanners({
  runs,
  canAct,
  passkey,
  onOpenRun,
}: {
  runs: readonly PayrollRun[];
  canAct: boolean;
  passkey: PasskeyState;
  onOpenRun: (runId: string) => void;
}): JSX.Element {
  return (
    <Banners>
      {passkey === "missing" ? (
        <Banner
          role="note"
          icon={KeyRoundIcon}
          title="Set up your approval passkey first"
        >
          Paying needs your approval passkey. Set it up in the Expendi Business
          app; then confirm here with “use a phone or tablet” in your
          browser&apos;s passkey prompt.
        </Banner>
      ) : null}
      {canAct
        ? waitingRuns(runs).map((run) =>
            run.status === "draft" ? (
              <Banner
                key={run.id}
                role="status"
                icon={CalendarIcon}
                title="Payroll ready to review"
                actions={
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => onOpenRun(run.id)}
                  >
                    Review run
                  </Button>
                }
              >
                <p className="tabular-nums">
                  Payroll for {formatIsoDate(run.payDate)} has{" "}
                  {String(run.people)}{" "}
                  {run.people === 1 ? "payment" : "payments"} to review before
                  pay day.
                </p>
              </Banner>
            ) : (
              <Banner
                key={run.id}
                role="status"
                tone="warn"
                title="Some payments failed"
                actions={
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => onOpenRun(run.id)}
                  >
                    Open run
                  </Button>
                }
              >
                <p className="tabular-nums">
                  Payroll for {formatIsoDate(run.payDate)}:{" "}
                  {progressInWords(run)}.
                </p>
              </Banner>
            ),
          )
        : null}
    </Banners>
  );
}
