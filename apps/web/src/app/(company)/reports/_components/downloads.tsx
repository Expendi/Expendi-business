"use client";

import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import {
  CircleCheckIcon,
  CopyIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  ImageIcon,
  ImagesIcon,
  Link2Icon,
  MailIcon,
  Table2Icon,
} from "lucide-react";
import { useState } from "react";

import type {
  GeneratedExport,
  ReportFormat,
  ReportMonthSummary,
} from "@expendi-business/shared";
import { reportFilename } from "@expendi-business/shared";

import type { ReportRequest } from "./reports-api";
import type { FactIcon } from "./reports-display";
import { TextLinkButton } from "~/components/data/actions";
import { Mini } from "~/components/data/cells";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";
import {
  expiryLabel,
  monthLabel,
  monthName,
  shareMessage,
} from "./report-month";
import { useGenerateExport } from "./reports-api";
import { DOWNLOADS, EXPORT_FILE_LABELS, fileFacts } from "./reports-display";

export const DOWNLOAD_ICONS: Record<ReportFormat, LucideIcon> = {
  workbook: FileSpreadsheetIcon,
  csv: FileArchiveIcon,
  receipts: ImagesIcon,
  etims: FileTextIcon,
};

const FACT_ICONS: Record<FactIcon, LucideIcon> = {
  sheet: FileSpreadsheetIcon,
  archive: FileArchiveIcon,
  table: Table2Icon,
  image: ImageIcon,
};

export type ReportDownload = UseMutationResult<string, Error, ReportRequest>;

/** Download, or "Preparing…" while that file is being made; the others wait. */
export function DownloadButton({
  format,
  month,
  download,
  variant = "outline",
}: {
  format: ReportFormat;
  month: string;
  download: ReportDownload;
  variant?: "outline" | "default";
}): JSX.Element {
  const title = DOWNLOADS.find((entry) => entry.format === format)?.title;
  const preparing = download.isPending && download.variables.format === format;
  return (
    <Button
      variant={variant}
      size="md"
      disabled={download.isPending && !preparing}
      aria-disabled={preparing || undefined}
      aria-busy={preparing || undefined}
      onClick={() => {
        if (!download.isPending) download.mutate({ month, format });
      }}
    >
      {preparing ? (
        "Preparing…"
      ) : (
        <>
          <DownloadIcon aria-hidden="true" />
          Download
        </>
      )}
      <span className="sr-only"> {title}</span>
    </Button>
  );
}

/** "Saved expendi-2026-10.xlsx." or why the download failed. */
export function DownloadFeedback({
  download,
  month,
  format,
}: {
  download: ReportDownload;
  month: string;
  /** Only this file's outcome; every file's when left out. */
  format?: ReportFormat;
}): JSX.Element | null {
  const variables = download.variables;
  if (
    variables?.month !== month ||
    (format !== undefined && variables.format !== format)
  ) {
    return null;
  }
  if (download.isError) {
    return (
      <div role="alert" className="w-full">
        <Callout tone="error">
          <p>{describeApiError(download.error)}</p>
        </Callout>
      </div>
    );
  }
  if (download.isSuccess) {
    return (
      <p
        role="status"
        className="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <CircleCheckIcon
          aria-hidden="true"
          className="size-4 text-success-700"
        />
        Saved {download.data}.
      </p>
    );
  }
  return null;
}

/**
 * Any month's files, made from today's records when downloaded (spec
 * §6.11, §6.14), then the admins' share block.
 */
export function DownloadsPanel({
  organizationId,
  companyName,
  month,
  partial,
  summary,
  download,
  canAct,
  onOpenFile,
}: {
  organizationId: string;
  companyName: string;
  month: string;
  partial: boolean;
  summary: UseQueryResult<ReportMonthSummary>;
  download: ReportDownload;
  canAct: boolean;
  onOpenFile: (format: ReportFormat) => void;
}): JSX.Element {
  const data = summary.isSuccess ? summary.data : null;
  const empty =
    data !== null && data.moneyOut.rows === 0 && data.outstanding.rows === 0;
  const feedback = <DownloadFeedback download={download} month={month} />;
  return (
    <div className="mt-4 overflow-clip rounded-xl border border-border bg-card text-sm shadow-xs">
      {data && (partial || empty) ? (
        <div className="flex flex-col gap-3 px-5 pt-4 max-[600px]:px-4">
          {partial ? (
            <Callout tone="neutral">
              <p>
                {monthName(month)} isn&apos;t over yet. The files have
                what&apos;s been paid up to today.
              </p>
            </Callout>
          ) : null}
          {empty ? (
            <Callout tone="neutral">
              <p>
                Nothing was paid out in {monthLabel(month)}, so the files have
                column headings only.
              </p>
            </Callout>
          ) : null}
        </div>
      ) : null}
      <ul
        aria-label="Files"
        className={
          summary.isPlaceholderData
            ? "m-0 list-none p-0 opacity-50 transition-opacity duration-200"
            : "m-0 list-none p-0 transition-opacity duration-200"
        }
      >
        {DOWNLOADS.map(({ format, title, detail }) => {
          const Icon = DOWNLOAD_ICONS[format];
          return (
            <li
              key={format}
              data-format={format}
              className="grid grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 border-b border-border px-5 py-4 max-[600px]:grid-cols-[40px_minmax(0,1fr)] max-[600px]:px-4 max-[600px]:py-3.5"
            >
              <span
                aria-hidden="true"
                className="inline-flex size-10 items-center justify-center self-start rounded-control border border-border bg-muted/40 text-muted-foreground"
              >
                <Icon className="size-5" />
              </span>
              <div className="min-w-0">
                <h3 className="text-base leading-6 font-(--w-name) text-foreground">
                  {title}
                </h3>
                <p className="text-muted-foreground">{detail}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="text-xs leading-4 [overflow-wrap:anywhere] text-muted-foreground">
                    {reportFilename(month, format)}
                  </span>
                  {data
                    ? fileFacts(format, data).map((fact) => (
                        <Mini
                          key={fact.text}
                          icon={FACT_ICONS[fact.icon]}
                          label={fact.text}
                        >
                          {fact.text}
                        </Mini>
                      ))
                    : null}
                </p>
              </div>
              <div className="flex items-center gap-4 max-[600px]:col-start-2 max-[600px]:mt-2 max-[600px]:justify-between">
                {data ? (
                  <TextLinkButton
                    aria-haspopup="dialog"
                    onClick={() => onOpenFile(format)}
                  >
                    What&apos;s inside
                    <span className="sr-only"> {title}</span>
                  </TextLinkButton>
                ) : null}
                <DownloadButton
                  format={format}
                  month={month}
                  download={download}
                />
              </div>
            </li>
          );
        })}
      </ul>
      {download.variables?.month === month &&
      (download.isError || download.isSuccess) ? (
        <div className="border-b border-border px-5 py-3 max-[600px]:px-4">
          {feedback}
        </div>
      ) : null}
      {canAct ? (
        <ShareExport
          key={month}
          organizationId={organizationId}
          companyName={companyName}
          month={month}
          disabled={summary.isPending}
        />
      ) : (
        <p className="flex items-start gap-2 px-5 pt-3.5 pb-4 text-muted-foreground max-[600px]:px-4">
          <MailIcon
            aria-hidden="true"
            className="mt-0.5 size-4 text-muted-foreground"
          />
          You also get last month&apos;s export by email on the 1st, with links
          that work for 30 days.
        </p>
      )}
    </div>
  );
}

export const MAKE_LINKS_ID = "make-links";

function ShareExport({
  organizationId,
  companyName,
  month,
  disabled,
}: {
  organizationId: string;
  companyName: string;
  month: string;
  disabled: boolean;
}): JSX.Element {
  const generate = useGenerateExport(organizationId);
  return (
    <div className="px-5 pt-[18px] pb-5 max-[600px]:px-4">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0 flex-[1_1_360px]">
          <h3 className="text-base leading-6 font-(--w-title) text-foreground">
            Share an export
          </h3>
          <p className="mt-0.5 max-w-[72ch] text-muted-foreground">
            Makes the month&apos;s export with links that open for 30 days
            without signing in, for an accountant without a login. Accountants
            on the team also get last month&apos;s by email on the 1st.
          </p>
        </div>
        <Button
          id={MAKE_LINKS_ID}
          size="md"
          disabled={disabled}
          aria-disabled={generate.isPending || undefined}
          aria-busy={generate.isPending || undefined}
          onClick={() => {
            if (!generate.isPending) generate.mutate(month);
          }}
          className="max-[600px]:w-full"
        >
          {generate.isPending ? (
            "Making links…"
          ) : (
            <>
              <Link2Icon aria-hidden="true" />
              Make links to share
            </>
          )}
        </Button>
      </div>
      {generate.isError ? (
        <div role="alert" className="mt-3">
          <Callout tone="error">
            <p>{describeApiError(generate.error)}</p>
          </Callout>
        </div>
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
    [EXPORT_FILE_LABELS.workbook, exported.links.workbook],
    [EXPORT_FILE_LABELS.csv, exported.links.csv],
    [EXPORT_FILE_LABELS.receipts, exported.links.receipts],
  ] as const;
  return (
    <div className="mt-4 rounded-control border border-border bg-muted/60 px-4 py-3.5">
      <p className="font-(--w-title) text-foreground">
        {monthLabel(exported.month)} export
      </p>
      <ul className="mt-2 flex list-none flex-col gap-1.5 p-0">
        {links.map(([label, href]) => (
          <li key={label} className="min-w-0">
            <span className="text-muted-foreground">{label}: </span>
            <a
              href={href}
              className="text-xs leading-4 [overflow-wrap:anywhere] text-accent-foreground underline decoration-accent underline-offset-3 hover:decoration-current"
            >
              {href}
            </a>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-muted-foreground">
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
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
      <Button variant="outline" size="md" onClick={copy}>
        <CopyIcon aria-hidden="true" />
        Copy links
      </Button>
      <span
        role="status"
        className={
          state === "failed" ? "text-destructive" : "text-muted-foreground"
        }
      >
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy. Select the links and copy them instead."
            : null}
      </span>
    </div>
  );
}
