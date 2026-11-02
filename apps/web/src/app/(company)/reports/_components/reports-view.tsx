"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { GeneratedExport, ReportFormat } from "@expendi-business/shared";
import { reportMonthSchema } from "@expendi-business/shared";

import {
  alertClass,
  inputClass,
  linkClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import {
  expiryLabel,
  monthLabel,
  nairobiMonth,
  shareMessage,
  shiftMonth,
} from "./report-month";
import { useGenerateExport, useReportDownload } from "./reports-api";

export const DOWNLOADS: readonly {
  readonly format: ReportFormat;
  readonly title: string;
  readonly detail: string;
}[] = [
  {
    format: "workbook",
    title: "Export (Excel)",
    detail:
      "All money out, bills outstanding at month end and float transfers, a sheet each.",
  },
  {
    format: "csv",
    title: "Export (CSV files)",
    detail: "The same sheets as UTF-8 CSV files, in a zip.",
  },
  {
    format: "receipts",
    title: "Receipts (zip)",
    detail: "Every receipt, named to match the export's receipt file column.",
  },
  {
    format: "etims",
    title: "eTIMS report (CSV)",
    detail:
      "Each expense bought in the month, with its eTIMS status, invoice number and supplier PIN.",
  },
];

const cardClass = "mt-6 rounded-lg border border-stone-200 bg-white p-4";

/**
 * Reports (spec §6.11, §6.14): any month's export, receipts and eTIMS
 * report, downloaded by admins and accountants alike. Admins can also make
 * an export with links to share for 30 days.
 */
export function ReportsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyReports
      key={company.organizationId}
      organizationId={company.organizationId}
      companyName={company.name}
      canAct={canAct}
    />
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
  const thisMonth = nairobiMonth(new Date());
  const [month, setMonth] = useState(() => shiftMonth(thisMonth, -1));
  const download = useReportDownload(organizationId);
  const ready =
    reportMonthSchema.safeParse(month).success && month <= thisMonth;

  return (
    <section>
      <h1 className="text-xl font-semibold">Reports</h1>
      <p className="mt-1 text-sm text-stone-600">
        Any month&apos;s export, receipts and eTIMS report. Months follow
        Nairobi time. Exports include salaries, so keep them private.
      </p>

      <div className={cardClass}>
        <label className="block max-w-xs text-sm">
          Month
          <input
            type="month"
            max={thisMonth}
            value={month}
            onChange={(event) => {
              setMonth(event.target.value);
              download.reset();
            }}
            className={inputClass}
          />
        </label>
        {ready ? null : (
          <p className="mt-2 text-sm text-error-700">
            Choose this month or an earlier one.
          </p>
        )}
        <ul className="mt-4 divide-y divide-stone-200">
          {DOWNLOADS.map(({ format, title, detail }) => (
            <li
              key={format}
              className="flex flex-wrap items-center justify-between gap-4 py-3"
            >
              <div className="max-w-xl">
                <h2 className="text-sm font-medium">{title}</h2>
                <p className="text-sm text-stone-600">{detail}</p>
              </div>
              <button
                type="button"
                onClick={() => download.mutate({ month, format })}
                disabled={!ready || download.isPending}
                className={secondaryButton}
              >
                {download.isPending && download.variables.format === format
                  ? "Preparing…"
                  : "Download"}
                <span className="sr-only"> {title}</span>
              </button>
            </li>
          ))}
        </ul>
        {download.isError ? (
          <p role="alert" className={alertClass}>
            {describeApiError(download.error)}
          </p>
        ) : null}
        {download.isSuccess ? (
          <p role="status" className="mt-4 text-sm text-stone-600">
            Saved {download.data}.
          </p>
        ) : null}
      </div>

      {canAct ? (
        <ShareExport
          key={month}
          organizationId={organizationId}
          companyName={companyName}
          month={month}
          ready={ready}
        />
      ) : null}
    </section>
  );
}

function ShareExport({
  organizationId,
  companyName,
  month,
  ready,
}: {
  organizationId: string;
  companyName: string;
  month: string;
  ready: boolean;
}): JSX.Element {
  const generate = useGenerateExport(organizationId);
  return (
    <div className={cardClass}>
      <h2 className="text-base font-semibold">Share an export</h2>
      <p className="mt-1 text-sm text-stone-600">
        Makes the month&apos;s export with links that open for 30 days without
        signing in, for an accountant without a login. Accountants on the team
        also get last month&apos;s by email on the 1st.
      </p>
      <button
        type="button"
        onClick={() => generate.mutate(month)}
        disabled={!ready || generate.isPending}
        className={`mt-4 ${primaryButton}`}
      >
        {generate.isPending ? "Making links…" : "Make links to share"}
      </button>
      {generate.isError ? (
        <p role="alert" className={alertClass}>
          {describeApiError(generate.error)}
        </p>
      ) : null}
      {generate.data ? (
        <SharedLinks companyName={companyName} exported={generate.data} />
      ) : null}
    </div>
  );
}

function SharedLinks({
  companyName,
  exported,
}: {
  companyName: string;
  exported: GeneratedExport;
}): JSX.Element {
  const links = [
    ["Spreadsheet (Excel)", exported.links.workbook],
    ["Spreadsheet (CSV files)", exported.links.csv],
    ["Receipts (zip)", exported.links.receipts],
  ] as const;
  return (
    <div className="mt-4 rounded-md bg-stone-50 p-3 text-sm">
      <p className="font-medium">{monthLabel(exported.month)} export</p>
      <ul className="mt-2 space-y-1">
        {links.map(([label, href]) => (
          <li key={label}>
            {label}:{" "}
            <a href={href} className={`${linkClass} break-all`}>
              {href}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-stone-600">
        These links work until {expiryLabel(exported.expiresAt)}. They&apos;re
        shown only now, so copy them before you leave.
      </p>
      <CopyLinks text={shareMessage(companyName, exported)} />
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CopyLinks({ text }: { text: string }): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  function copy() {
    // Inside the promise, so a browser without the clipboard API shows the
    // fallback instead of throwing.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(text))
      .then(
        () => setState("copied"),
        () => setState("failed"),
      );
  }

  return (
    <span className="mt-3 inline-flex items-center gap-2">
      <button type="button" onClick={copy} className={secondaryButton}>
        Copy links
      </button>
      <span role="status" className="text-sm text-stone-600">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy. Select the links and copy them instead."
            : null}
      </span>
    </span>
  );
}
