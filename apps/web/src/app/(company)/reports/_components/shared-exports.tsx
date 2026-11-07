"use client";

import type { UseQueryResult } from "@tanstack/react-query";
import type { JSX } from "react";
import {
  CircleCheckIcon,
  DownloadIcon,
  FileArchiveIcon,
  FileSpreadsheetIcon,
  ImagesIcon,
  Link2Icon,
  MailIcon,
} from "lucide-react";

import type { ExportFile, ExportSummary } from "@expendi-business/shared";
import { EXPORT_FILES, reportFilename } from "@expendi-business/shared";

import type { ExportSortKey } from "./reports-display";
import type { SortState } from "~/components/data/table";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SectionLabel,
  SheetPosition,
} from "~/components/data/detail-sheet";
import {
  ResultsBody,
  ResultsFoot,
  ResultsPanel,
} from "~/components/data/results";
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  Mini,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  TableSkeletonRows,
  Td,
  Th,
} from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";
import { MAKE_LINKS_ID } from "./downloads";
import { dayLabel, expiryLabel, monthLabel, nairobiTime } from "./report-month";
import { useExportFileDownload } from "./reports-api";
import { EXPORT_FILE_LABELS, linksWork, madeBy } from "./reports-display";

const FILE_ICONS: Record<ExportFile, typeof FileSpreadsheetIcon> = {
  workbook: FileSpreadsheetIcon,
  csv: FileArchiveIcon,
  receipts: ImagesIcon,
};

function LinksBadge({
  exported,
  now,
}: {
  exported: ExportSummary;
  now: Date;
}): JSX.Element {
  return linksWork(exported, now) ? (
    <StatusBadge tone="paid">Links work</StatusBadge>
  ) : (
    <StatusBadge tone="quiet">Links expired</StatusBadge>
  );
}

function HowMade({ exported }: { exported: ExportSummary }): JSX.Element {
  return (
    <Mini
      icon={exported.monthly ? MailIcon : Link2Icon}
      label={exported.monthly ? "Emailed" : "Shared link"}
    />
  );
}

/** Exports made with links: the monthly email to accountants and any an admin shared. */
export function SharedExports({
  exports,
  sorted,
  sort,
  onSort,
  now,
  canAct,
  openId,
  onOpen,
}: {
  exports: UseQueryResult<ExportSummary[]>;
  sorted: readonly ExportSummary[];
  sort: SortState<ExportSortKey>;
  onSort: (key: ExportSortKey) => void;
  now: Date;
  canAct: boolean;
  openId: string | null;
  onOpen: (id: string) => void;
}): JSX.Element {
  return (
    <ResultsPanel label="Shared exports">
      <ResultsBody busy={exports.isPending}>
        {exports.isError ? (
          <ErrorState
            title="Shared exports didn't load"
            onRetry={() => void exports.refetch()}
          />
        ) : exports.isSuccess && sorted.length === 0 ? (
          <EmptyState
            icon={MailIcon}
            title="No shared exports yet"
            action={
              canAct ? (
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => {
                    const button = document.getElementById(MAKE_LINKS_ID);
                    button?.scrollIntoView({ block: "center" });
                    button?.focus({ preventScroll: true });
                  }}
                >
                  Make links to share
                </Button>
              ) : null
            }
          >
            {canAct
              ? "Accountants on the team get last month's export by email on the 1st. To send one now, make links to share."
              : "Your first monthly export arrives by email on the 1st."}
          </EmptyState>
        ) : (
          <>
            <DataTable caption="Shared exports">
              <thead>
                <tr>
                  <SortHeader
                    label="Export"
                    sortKey="month"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="Made"
                    sortKey="made"
                    sort={sort}
                    onSort={onSort}
                  />
                  <SortHeader
                    label="Links work until"
                    sortKey="until"
                    sort={sort}
                    onSort={onSort}
                  />
                  <Th>Links</Th>
                </tr>
              </thead>
              <tbody>
                {exports.isPending ? (
                  <TableSkeletonRows rows={4} columns={4} />
                ) : (
                  sorted.map((exported) => (
                    <DataRow
                      key={exported.id}
                      open={openId === exported.id}
                      onOpen={() => onOpen(exported.id)}
                    >
                      <Td kind="main">
                        <RowTitle onOpen={() => onOpen(exported.id)}>
                          {monthLabel(exported.month)} export
                        </RowTitle>
                        <RowMeta text={madeBy(exported)}>
                          <HowMade exported={exported} />
                        </RowMeta>
                      </Td>
                      <Td kind="date">
                        {dayLabel(exported.createdAt)}
                        <span className="block text-xs leading-4 text-gray-500">
                          {nairobiTime(exported.createdAt)}
                        </span>
                      </Td>
                      <Td kind="date">{dayLabel(exported.expiresAt)}</Td>
                      <Td>
                        <LinksBadge exported={exported} now={now} />
                      </Td>
                    </DataRow>
                  ))
                )}
              </tbody>
            </DataTable>
            <PhoneCards label="Shared exports">
              {sorted.map((exported) => (
                <PhoneCard
                  key={exported.id}
                  mark={
                    <span
                      aria-hidden="true"
                      className="inline-flex size-8 items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-700"
                    >
                      {exported.monthly ? (
                        <MailIcon className="size-4" />
                      ) : (
                        <Link2Icon className="size-4" />
                      )}
                    </span>
                  }
                  title={`${monthLabel(exported.month)} export`}
                  sub={`${madeBy(exported)} · ${dayLabel(exported.createdAt)}`}
                  flags={<LinksBadge exported={exported} now={now} />}
                  onOpen={() => onOpen(exported.id)}
                />
              ))}
            </PhoneCards>
            {exports.isSuccess ? (
              <ResultsFoot>
                <span className="whitespace-nowrap tabular-nums">
                  {sorted.length} {sorted.length === 1 ? "export" : "exports"}
                </span>
                <span>
                  Signed-in admins and accountants can download them any time.
                </span>
              </ResultsFoot>
            ) : null}
          </>
        )}
      </ResultsBody>
    </ResultsPanel>
  );
}

/** A shared export's details and its stored files, as they were when it was made. */
export function ExportSheet({
  organizationId,
  exported,
  now,
  index,
  total,
  onStep,
  onClose,
}: {
  organizationId: string;
  exported: ExportSummary | null;
  now: Date;
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <DetailSheet
      open={exported !== null}
      onClose={onClose}
      eyebrow={exported?.monthly ? "Monthly export" : "Shared export"}
      title={exported ? `${monthLabel(exported.month)} export` : "Export"}
      headerExtra={
        exported ? (
          <div className="mt-1.5">
            <LinksBadge exported={exported} now={now} />
          </div>
        ) : null
      }
      stepper={{
        index,
        total,
        onStep,
        previousLabel: "Previous export",
        nextLabel: "Next export",
      }}
      stepKey={exported?.id}
      footer={<SheetPosition index={index} total={total} />}
    >
      {exported ? (
        <ExportDetails
          key={exported.id}
          organizationId={organizationId}
          exported={exported}
          now={now}
        />
      ) : null}
    </DetailSheet>
  );
}

function ExportDetails({
  organizationId,
  exported,
  now,
}: {
  organizationId: string;
  exported: ExportSummary;
  now: Date;
}): JSX.Element {
  const download = useExportFileDownload(organizationId);
  const pending = download.isPending ? download.variables.file : null;
  return (
    <>
      <DetailList>
        <DetailItem label="Month">{monthLabel(exported.month)}</DetailItem>
        <DetailItem label="Made by">
          {exported.monthly
            ? "Expendi (automatic)"
            : (exported.createdBy ?? "An admin")}
        </DetailItem>
        <DetailItem label="Made">
          {dayLabel(exported.createdAt)}, {nairobiTime(exported.createdAt)}
        </DetailItem>
        <DetailItem label="Links">
          {exported.monthly
            ? "Emailed to each accountant on the team, a link each. A link stops working if they're removed."
            : "One set of links to share, shown once when it was made."}
        </DetailItem>
        <DetailItem
          label={
            linksWork(exported, now) ? "Links work until" : "Links expired"
          }
        >
          {expiryLabel(exported.expiresAt)}
        </DetailItem>
      </DetailList>
      <div className="flex flex-col gap-2">
        <SectionLabel>Files</SectionLabel>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {EXPORT_FILES.map((file) => {
            const Icon = FILE_ICONS[file];
            const preparing = pending === file;
            return (
              <li
                key={file}
                className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-control border border-gray-200 px-3 py-2.5"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 items-center justify-center rounded-control border border-gray-200 bg-surface text-gray-700"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-(--w-name) text-gray-900">
                    {EXPORT_FILE_LABELS[file]}
                  </span>
                  <span className="block text-xs leading-4 [overflow-wrap:anywhere] text-gray-500">
                    {reportFilename(exported.month, file)}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="md"
                  disabled={pending !== null && !preparing}
                  aria-disabled={preparing || undefined}
                  aria-busy={preparing || undefined}
                  onClick={() => {
                    if (pending === null) download.mutate({ exported, file });
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
                  <span className="sr-only"> {EXPORT_FILE_LABELS[file]}</span>
                </Button>
              </li>
            );
          })}
        </ul>
        <p className="text-gray-600">
          These are the files as they were on {dayLabel(exported.createdAt)}.
          For today&apos;s figures, download from Downloads above.
        </p>
      </div>
      {download.isError ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApiError(download.error)}</p>
          </Callout>
        </div>
      ) : null}
      {download.isSuccess ? (
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-gray-600"
        >
          <CircleCheckIcon
            aria-hidden="true"
            className="size-4 text-success-700"
          />
          Saved {download.data}.
        </p>
      ) : null}
    </>
  );
}
