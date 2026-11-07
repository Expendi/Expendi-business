"use client";

import type { JSX, ReactNode } from "react";
import { ClockIcon } from "lucide-react";
import { Suspense, useState } from "react";

import type { ReportFormat } from "@expendi-business/shared";

import type {
  CategorySortKey,
  ChangeContext,
  ExportSortKey,
} from "./reports-display";
import type { SortState } from "~/components/data/table";
import { PageHeader } from "~/components/data/page-header";
import { nextSort } from "~/components/data/table";
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { useDashboard } from "~/contexts/dashboard-context";
import { useKesRate } from "~/features/bills/bills-api";
import { CategorySheet } from "./category-sheet";
import { DownloadsPanel } from "./downloads";
import { FileSheet } from "./file-sheet";
import {
  monthLabel,
  nairobiDay,
  nairobiMonth,
  shiftMonth,
} from "./report-month";
import { ReportStats } from "./report-stats";
import {
  useReportDownload,
  useReportSpending,
  useReportSummary,
  useSharedExports,
} from "./reports-api";
import {
  CATEGORY_FIRST_DIRECTION,
  categoryRows,
  changeLine,
  EXPORT_FIRST_DIRECTION,
  isReportFormat,
  resolveMonth,
  resolveRange,
  sortCategories,
  sortExports,
  spendingMonths,
} from "./reports-display";
import { ExportSheet, SharedExports } from "./shared-exports";
import { SpendingBody } from "./spending";
import { MenuChip } from "./viz/menu-chip";
import { MonthChip } from "./viz/month-chip";

/**
 * Reports (spec §6.11, §6.14): any month's export, receipts and eTIMS
 * report, downloaded by admins and accountants alike, money out by month,
 * heading and category, and the exports made with links. Admins can also
 * make an export with links to share for 30 days.
 */
export function ReportsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <Suspense>
      <CompanyReports
        key={company.organizationId}
        organizationId={company.organizationId}
        companyName={company.name}
        canAct={canAct}
      />
    </Suspense>
  );
}

function Section({
  id,
  title,
  sub,
  action,
  children,
}: {
  id: string;
  title: string;
  sub: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section aria-labelledby={id} className="mt-10 motion-safe:animate-rise">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          <h2
            id={id}
            className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] text-gray-900"
          >
            {title}
          </h2>
          <p className="mt-1 max-w-[70ch] text-sm text-gray-600">{sub}</p>
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function CompanyReports({
  organizationId,
  companyName,
  canAct,
}: {
  organizationId: string;
  companyName: string;
  canAct: boolean;
}): JSX.Element {
  const [now] = useState(() => new Date());
  const thisMonth = nairobiMonth(now);
  const today = nairobiDay(now);
  const defaultMonth = shiftMonth(thisMonth, -1);

  const [monthParam, setMonthParam] = useDeepLinkParam("month");
  const [rangeParam, setRangeParam] = useDeepLinkParam("range");
  const [fileParam, setFileParam] = useDeepLinkParam("file");
  const [categoryParam, setCategoryParam] = useDeepLinkParam("category");
  const [exportParam, setExportParam] = useDeepLinkParam("export");

  const month = resolveMonth(monthParam, thisMonth) ?? defaultMonth;
  const range = resolveRange(rangeParam);
  const partial = month === thisMonth;
  const context: ChangeContext = { month, thisMonth, today };

  const summary = useReportSummary(organizationId, month);
  const spending = useReportSpending(organizationId, month, range);
  const exports = useSharedExports(organizationId);
  const rate = useKesRate(organizationId);
  const download = useReportDownload(organizationId);

  const [categorySort, setCategorySort] = useState<SortState<CategorySortKey>>({
    key: "current",
    dir: "desc",
  });
  const [exportSort, setExportSort] = useState<SortState<ExportSortKey>>({
    key: "made",
    dir: "desc",
  });

  const spendingData = spending.isSuccess ? spending.data : null;
  const months = spendingData ? spendingMonths(spendingData) : [];
  const categories = spendingData
    ? sortCategories(categoryRows(spendingData), categorySort)
    : [];
  const shownMonth = spendingData?.month ?? month;
  const shownContext: ChangeContext = { ...context, month: shownMonth };
  const selectedMonth = months.find((entry) => entry.month === month);
  const moneyOutChange = selectedMonth
    ? changeLine(selectedMonth.total, selectedMonth.previous, context)
    : null;
  const sortedExports = exports.isSuccess
    ? sortExports(exports.data, exportSort)
    : [];

  const file: ReportFormat | null = isReportFormat(fileParam)
    ? fileParam
    : null;
  const categoryIndex = categories.findIndex((row) => row.id === categoryParam);
  const exportIndex = sortedExports.findIndex(
    (exported) => exported.id === exportParam,
  );
  const summaryData =
    summary.isSuccess && summary.data.month === month ? summary.data : null;

  function setMonth(next: string) {
    download.reset();
    setMonthParam(next === defaultMonth ? null : next);
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Any month's export, receipts and eTIMS report. Months follow Nairobi time. Exports include salaries, so keep them private."
        actions={
          <div>
            <MonthChip
              month={month}
              thisMonth={thisMonth}
              onChange={setMonth}
            />
          </div>
        }
      />

      <ReportStats
        summary={summary}
        change={moneyOutChange}
        partial={partial}
        rate={rate}
      />

      <Section
        id="downloads-title"
        title="Downloads"
        sub={`${monthLabel(month)}${partial ? " so far" : ""}. Each file is made from today's records when you download it.`}
      >
        <DownloadsPanel
          organizationId={organizationId}
          companyName={companyName}
          month={month}
          partial={partial}
          summary={summary}
          download={download}
          canAct={canAct}
          onOpenFile={(format) => setFileParam(format)}
        />
      </Section>

      <Section
        id="spending-title"
        title="Spending"
        sub="Money out by overview heading and by category, salaries included."
        action={
          spending.isError ? null : (
            <MenuChip
              icon={ClockIcon}
              label="Show"
              display={range === 12 ? "Last 12 months" : "Last 6 months"}
              options={[
                { value: "6", label: "Last 6 months" },
                { value: "12", label: "Last 12 months" },
              ]}
              value={String(range)}
              onChange={(value) => setRangeParam(value === "12" ? "12" : null)}
            />
          )
        }
      >
        <SpendingBody
          spending={spending}
          months={months}
          rows={categories}
          context={shownContext}
          canAct={canAct}
          sort={categorySort}
          onSort={(key) =>
            setCategorySort((current) =>
              nextSort(current, key, CATEGORY_FIRST_DIRECTION[key]),
            )
          }
          openCategoryId={categoryParam}
          onOpenCategory={(id) => setCategoryParam(id)}
        />
      </Section>

      <Section
        id="shared-title"
        title="Shared exports"
        sub="Exports made with links: the one emailed to accountants on the 1st, and any an admin made to share."
      >
        <SharedExports
          exports={exports}
          sorted={sortedExports}
          sort={exportSort}
          onSort={(key) =>
            setExportSort((current) =>
              nextSort(current, key, EXPORT_FIRST_DIRECTION[key]),
            )
          }
          now={now}
          canAct={canAct}
          openId={exportParam}
          onOpen={(id) => setExportParam(id)}
        />
      </Section>

      <FileSheet
        format={file}
        month={month}
        partial={partial}
        summary={summaryData}
        download={download}
        onStep={(format) => setFileParam(format)}
        onClose={() => setFileParam(null)}
      />
      <CategorySheet
        row={categories[categoryIndex] ?? null}
        months={months}
        context={shownContext}
        largestPayments={spendingData?.largestPayments ?? []}
        index={categoryIndex}
        total={categories.length}
        onStep={(delta) => {
          const next = categories[categoryIndex + delta];
          if (next) setCategoryParam(next.id);
        }}
        onClose={() => setCategoryParam(null)}
      />
      <ExportSheet
        organizationId={organizationId}
        exported={sortedExports[exportIndex] ?? null}
        now={now}
        index={exportIndex}
        total={sortedExports.length}
        onStep={(delta) => {
          const next = sortedExports[exportIndex + delta];
          if (next) setExportParam(next.id);
        }}
        onClose={() => setExportParam(null)}
      />
    </div>
  );
}
