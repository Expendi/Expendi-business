"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { ImageIcon, MessageSquareTextIcon } from "lucide-react";

import type {
  ReportFormat,
  ReportMonthSummary,
} from "@expendi-business/shared";
import {
  REPORT_PREVIEW_ETIMS_ROWS,
  REPORT_PREVIEW_RECEIPTS,
  REPORT_PREVIEW_ROWS,
  reportFilename,
} from "@expendi-business/shared";

import type { ReportDownload } from "./downloads";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SectionLabel,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { formatKes, formatUsdc } from "~/lib/money";
import { DownloadButton, DownloadFeedback } from "./downloads";
import { dayLabel, monthLabel } from "./report-month";
import {
  DOWNLOADS,
  ETIMS_COLUMNS,
  ETIMS_STATUS_LABELS,
  EXPORT_PARTS,
  FLOAT_TRANSFER_LABELS,
  isImportedMonth,
  KIND_LABELS,
  MONEY_OUT_COLUMNS,
  OUTSTANDING_COLUMNS,
  plural,
  REPORT_FORMATS_SHOWN,
} from "./reports-display";

/** What a download holds: its sheets or files, their columns and first rows. */
export function FileSheet({
  format,
  month,
  partial,
  summary,
  download,
  onStep,
  onClose,
}: {
  format: ReportFormat | null;
  month: string;
  partial: boolean;
  summary: ReportMonthSummary | null;
  download: ReportDownload;
  onStep: (format: ReportFormat) => void;
  onClose: () => void;
}): JSX.Element {
  const open = format !== null && summary !== null;
  const index = format ? REPORT_FORMATS_SHOWN.indexOf(format) : -1;
  const entry = DOWNLOADS.find((download) => download.format === format);
  const total = REPORT_FORMATS_SHOWN.length;
  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      eyebrow={`Download · ${monthLabel(month)}${partial ? " so far" : ""}`}
      title={entry?.title ?? "Download"}
      headerExtra={
        format ? (
          <>
            <p className="mt-0.5 text-muted-foreground">{entry?.detail}</p>
            <p className="mt-0.5 text-xs leading-4 [overflow-wrap:anywhere] text-muted-foreground">
              {reportFilename(month, format)}
            </p>
          </>
        ) : null
      }
      stepper={{
        index,
        total,
        onStep: (delta) => {
          const next = REPORT_FORMATS_SHOWN[index + delta];
          if (next) onStep(next);
        },
        previousLabel: "Previous file",
        nextLabel: "Next file",
      }}
      stepKey={format ?? undefined}
      footer={
        format ? (
          <>
            <div className="basis-full empty:hidden">
              <DownloadFeedback
                download={download}
                month={month}
                format={format}
              />
            </div>
            <DownloadButton
              format={format}
              month={month}
              download={download}
              variant="default"
            />
            <SheetPosition index={index} total={total} />
          </>
        ) : null
      }
    >
      {format && summary ? (
        <FileContents format={format} summary={summary} partial={partial} />
      ) : null}
    </DetailSheet>
  );
}

export function FileContents({
  format,
  summary,
  partial,
}: {
  format: ReportFormat;
  summary: ReportMonthSummary;
  partial: boolean;
}): JSX.Element {
  if (format === "workbook" || format === "csv") {
    return <ExportParts format={format} summary={summary} partial={partial} />;
  }
  if (format === "receipts") return <Receipts summary={summary} />;
  return <Etims summary={summary} />;
}

function Section({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-col gap-2">{children}</div>;
}

function Sub({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-muted-foreground">{children}</p>;
}

function More({
  shown,
  total,
  noun,
}: {
  shown: number;
  total: number;
  noun: string;
}): JSX.Element | null {
  if (total <= shown) return null;
  return (
    <p className="text-xs leading-4 text-muted-foreground tabular-nums">
      And {total - shown} more {noun}.
    </p>
  );
}

function Note({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-xs leading-4 text-muted-foreground">{children}</p>;
}

function ColumnTags({ columns }: { columns: readonly string[] }): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1">
      {columns.map((column) => (
        <span
          key={column}
          className="inline-flex h-[22px] items-center rounded-full border border-border px-2 text-xs whitespace-nowrap text-muted-foreground"
        >
          {column}
        </span>
      ))}
    </div>
  );
}

/** A file's first rows; the last column is the amount, right-aligned. */
function PreviewTable({
  head,
  rows,
}: {
  head: readonly string[];
  rows: readonly (readonly string[])[];
}): JSX.Element {
  const last = head.length - 1;
  return (
    <table className="w-full border-collapse text-xs leading-4 tabular-nums">
      <thead>
        <tr>
          {head.map((label, column) => (
            <th
              key={label}
              scope="col"
              className={cn(
                "py-1.5 pr-2 text-left font-normal text-muted-foreground",
                column === last && "pr-0 text-right whitespace-nowrap",
              )}
            >
              {label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={`${String(index)}:${row.join("|")}`}>
            {row.map((cell, column) => (
              <td
                key={`${String(column)}:${cell}`}
                title={column === 2 ? cell : undefined}
                className={cn(
                  "border-t border-border py-1.5 pr-2 align-top",
                  column === last && "pr-0 text-right whitespace-nowrap",
                  column === 2 && "w-2/5 max-w-0 truncate",
                )}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function rowsLabel(count: number): string {
  return plural(count, "row", "rows");
}

function ExportParts({
  format,
  summary,
  partial,
}: {
  format: "workbook" | "csv";
  summary: ReportMonthSummary;
  partial: boolean;
}): JSX.Element {
  const [moneyOutName, outstandingName, transfersName] = EXPORT_PARTS[format];
  const noun = format === "csv" ? "File" : "Sheet";
  const { moneyOut, outstanding, floatTransfers } = summary;
  return (
    <>
      <Section>
        <SectionLabel>
          {noun} 1: {moneyOutName} · {rowsLabel(moneyOut.rows)}
        </SectionLabel>
        <Sub>
          Every payment out in the month: reimbursements, petty cash spending,
          company spending, bills and salaries, one row each.
        </Sub>
        <ColumnTags columns={MONEY_OUT_COLUMNS} />
        {moneyOut.rows === 0 ? (
          <Note>
            No rows this month. The sheet has its column headings only.
          </Note>
        ) : (
          <div>
            <PreviewTable
              head={["Date", "Kind", "Payee or employee", "Amount (KES)"]}
              rows={moneyOut.preview.map((row) => [
                dayLabel(row.date),
                KIND_LABELS[row.kind],
                row.name,
                formatKes(row.amountKes),
              ])}
            />
            <More
              shown={REPORT_PREVIEW_ROWS}
              total={moneyOut.rows}
              noun="rows"
            />
          </div>
        )}
      </Section>
      <Section>
        <SectionLabel>
          {noun} 2: {outstandingName} · {rowsLabel(outstanding.rows)}
        </SectionLabel>
        <Sub>
          {partial
            ? "Bills due by the end of the month that aren't paid yet."
            : "Bills that were due or overdue and still unpaid at month end."}
        </Sub>
        <ColumnTags columns={OUTSTANDING_COLUMNS} />
        {outstanding.rows === 0 ? (
          <Note>None this month.</Note>
        ) : (
          <div>
            <PreviewTable
              head={["Due date", "Payee", "Status at month end", "Amount"]}
              rows={outstanding.preview.map((bill) => [
                dayLabel(bill.dueOn),
                bill.payee,
                bill.overdue ? "Overdue" : "Due",
                bill.amountKes !== null
                  ? formatKes(bill.amountKes)
                  : bill.amountUsdc !== null
                    ? `USD ${formatUsdc(bill.amountUsdc)}`
                    : "Not entered",
              ])}
            />
            <More
              shown={REPORT_PREVIEW_ROWS}
              total={outstanding.rows}
              noun="rows"
            />
          </div>
        )}
      </Section>
      <Section>
        <SectionLabel>
          {noun} 3: {transfersName} · {rowsLabel(floatTransfers.rows)}
        </SectionLabel>
        <Sub>
          Float issues and top-ups. They move money between the company&apos;s
          own accounts, so they aren&apos;t spending.
        </Sub>
        {floatTransfers.rows === 0 ? (
          <Note>None this month.</Note>
        ) : (
          <div>
            <PreviewTable
              head={["Date", "Status", "Payee or employee", "Amount (KES)"]}
              rows={floatTransfers.preview.map((row) => [
                dayLabel(row.date),
                FLOAT_TRANSFER_LABELS[row.type],
                row.person,
                formatKes(row.amountKes),
              ])}
            />
            <More
              shown={REPORT_PREVIEW_ROWS}
              total={floatTransfers.rows}
              noun="rows"
            />
          </div>
        )}
      </Section>
    </>
  );
}

function Receipts({ summary }: { summary: ReportMonthSummary }): JSX.Element {
  const { receipts } = summary;
  const imported = isImportedMonth(summary);
  return (
    <>
      <Section>
        <SectionLabel>{plural(receipts.files, "file", "files")}</SectionLabel>
        {receipts.names.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {receipts.names.map((name) => {
              const Icon = name.endsWith(".txt")
                ? MessageSquareTextIcon
                : ImageIcon;
              return (
                <li
                  key={name}
                  className="flex min-w-0 items-center gap-2 text-xs leading-4 text-muted-foreground"
                >
                  <Icon
                    aria-hidden="true"
                    className="size-3.5 shrink-0 text-muted-foreground/70"
                  />
                  <span className="min-w-0 truncate" title={name}>
                    {name}
                  </span>
                </li>
              );
            })}
          </ul>
        ) : (
          <Note>
            {imported
              ? "This month came from the spreadsheet import, which had no receipts."
              : "No receipts this month."}
          </Note>
        )}
        <More
          shown={REPORT_PREVIEW_RECEIPTS}
          total={receipts.files}
          noun="files"
        />
        <Sub>
          Photos keep their own format. An M-Pesa message saved as a receipt is
          a .txt file.
        </Sub>
      </Section>
      {receipts.expensesWithout > 0 && !imported ? (
        <Callout
          tone="warn"
          title={`${plural(receipts.expensesWithout, "expense has", "expenses have")} no receipt`}
        >
          <ul className="mt-1 list-disc pl-[18px] tabular-nums">
            {receipts.withoutPreview.map((row) => (
              <li key={`${row.date}:${row.merchant}:${row.amountKes}`}>
                {row.merchant}, KES {formatKes(row.amountKes)},{" "}
                {dayLabel(row.date)}
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}
    </>
  );
}

function Etims({ summary }: { summary: ReportMonthSummary }): JSX.Element {
  const { etims } = summary;
  return (
    <>
      <DetailList>
        <DetailItem label="Expenses">{etims.rows}</DetailItem>
        <DetailItem label="Attached">{etims.attached}</DetailItem>
        <DetailItem label="None">{etims.none}</DetailItem>
        <DetailItem label="Not required">{etims.notRequired}</DetailItem>
      </DetailList>
      <Section>
        <SectionLabel>Columns</SectionLabel>
        <ColumnTags columns={ETIMS_COLUMNS} />
      </Section>
      <Section>
        <SectionLabel>First rows</SectionLabel>
        {etims.rows === 0 ? (
          <Note>No expenses this month.</Note>
        ) : (
          <div>
            <PreviewTable
              head={["Date", "eTIMS status", "Merchant", "Amount (KES)"]}
              rows={etims.preview.map((row) => [
                dayLabel(row.date),
                ETIMS_STATUS_LABELS[row.status],
                row.merchant,
                formatKes(row.amountKes),
              ])}
            />
            <More
              shown={REPORT_PREVIEW_ETIMS_ROWS}
              total={etims.rows}
              noun="rows"
            />
          </div>
        )}
      </Section>
      <Sub>
        Paid or not, every expense dated in the month. Rejected reimbursements
        are left out.
      </Sub>
    </>
  );
}
