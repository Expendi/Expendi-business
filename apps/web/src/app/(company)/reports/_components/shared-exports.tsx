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
import { useMemo } from "react";

import type { ExportFile, ExportSummary } from "@expendi-business/shared";
import { EXPORT_FILES, reportFilename } from "@expendi-business/shared";

import type { ExportSortKey } from "./reports-display";
import type {
  DataTableColumnDef,
  SortState,
} from "~/components/data/data-table";
import { Mini, PhoneCard, RowMeta, RowTitle } from "~/components/data/cells";
import {
  DataTable,
  DataTableColumnHeader,
  pressedKey,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
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

const EXPORT_KEYS: readonly ExportSortKey[] = ["month", "made", "until"];

function exportColumns(
  now: Date,
  onOpen: (id: string) => void,
): DataTableColumnDef<ExportSummary>[] {
  return [
    {
      id: "month",
      accessorFn: (exported) => exported.month,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Export" />
      ),
      cell: ({ row }) => (
        <>
          <RowTitle onOpen={() => onOpen(row.original.id)}>
            {monthLabel(row.original.month)} export
          </RowTitle>
          <RowMeta text={madeBy(row.original)}>
            <HowMade exported={row.original} />
          </RowMeta>
        </>
      ),
      meta: { kind: "main", label: "Export" },
    },
    {
      id: "made",
      accessorFn: (exported) => exported.createdAt,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Made" />
      ),
      cell: ({ row }) => (
        <>
          {dayLabel(row.original.createdAt)}
          <span className="block text-xs leading-4 text-muted-foreground">
            {nairobiTime(row.original.createdAt)}
          </span>
        </>
      ),
      meta: { kind: "date", label: "Made" },
    },
    {
      id: "until",
      accessorFn: (exported) => exported.expiresAt,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Links work until" />
      ),
      cell: ({ row }) => dayLabel(row.original.expiresAt),
      meta: { kind: "date", label: "Links work until" },
    },
    {
      id: "links",
      header: "Links",
      enableSorting: false,
      cell: ({ row }) => <LinksBadge exported={row.original} now={now} />,
      meta: { label: "Links" },
    },
  ];
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
  const columns = useMemo(() => exportColumns(now, onOpen), [now, onOpen]);
  const table = useDataTable({
    data: sorted,
    columns,
    getRowId: (exported) => exported.id,
    manual: { sorting: true },
    paginate: false,
    sorting: {
      value: toSorting(sort),
      onChange: (next) => onSort(pressedKey(next, sort, EXPORT_KEYS)),
    },
  });
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
            <DataTable
              table={table}
              caption="Shared exports"
              loading={exports.isPending}
              skeletonRows={4}
              onRowOpen={(exported) => onOpen(exported.id)}
              openRowId={openId}
              renderPhoneCard={(row) => (
                <PhoneCard
                  key={row.id}
                  mark={
                    <span
                      aria-hidden="true"
                      className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-secondary-foreground"
                    >
                      {row.original.monthly ? (
                        <MailIcon className="size-4" />
                      ) : (
                        <Link2Icon className="size-4" />
                      )}
                    </span>
                  }
                  title={`${monthLabel(row.original.month)} export`}
                  sub={`${madeBy(row.original)} · ${dayLabel(row.original.createdAt)}`}
                  flags={<LinksBadge exported={row.original} now={now} />}
                  onOpen={() => onOpen(row.id)}
                />
              )}
            />
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
                className="grid grid-cols-[32px_minmax(0,1fr)_auto] items-center gap-3 rounded-control border border-border px-3 py-2.5"
              >
                <span
                  aria-hidden="true"
                  className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-secondary-foreground"
                >
                  <Icon className="size-4" />
                </span>
                <span className="min-w-0">
                  <span className="block font-(--w-name) text-foreground">
                    {EXPORT_FILE_LABELS[file]}
                  </span>
                  <span className="block text-xs leading-4 [overflow-wrap:anywhere] text-muted-foreground">
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
        <p className="text-muted-foreground">
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
          className="flex items-center gap-2 text-sm text-muted-foreground"
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
