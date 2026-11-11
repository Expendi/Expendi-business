"use client";

import type { FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import type { AuditEntry } from "@expendi-business/shared";
import { AUDIT_ACTOR_TYPES } from "@expendi-business/shared";

import type { AuditFilters } from "./audit-filters";
import { CursorPager } from "~/components/cursor-pager";
import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { JsonDiff } from "~/components/json-diff";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { Button } from "~/components/ui/button";
import { Card, CardContent } from "~/components/ui/card";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import {
  filtersFromForm,
  filtersFromParams,
  filtersToParams,
} from "./audit-filters";
import { actorLabel, auditColumns } from "./columns";

const PAGE_SIZE = 50;

export function AuditLogView() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = filtersFromParams(searchParams);
  const filtersKey = filtersToParams(filters).toString();

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params = filtersToParams(
      filtersFromForm(new FormData(event.currentTarget)),
    ).toString();
    router.push(params ? `${pathname}?${params}` : pathname);
  }

  return (
    <section className="flex flex-col gap-6">
      <PageHeader
        title="Audit log"
        subtitle="Every recorded change to money, access and settings, across all companies. Read-only. Times are Nairobi time."
      />

      <AuditSearchForm
        key={`form-${filtersKey}`}
        filters={filters}
        onSubmit={onSearch}
        onClear={() => router.push(pathname)}
      />

      <AuditResults key={`results-${filtersKey}`} filters={filters} />
    </section>
  );
}

function AuditSearchForm({
  filters,
  onSubmit,
  onClear,
}: {
  filters: AuditFilters;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onClear: () => void;
}) {
  return (
    <form onSubmit={onSubmit}>
      <Card>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <label className="text-sm">
            Company ID
            <Input
              name="organizationId"
              defaultValue={filters.organizationId}
              placeholder="Any company"
              className="mt-2"
            />
          </label>
          <label className="text-sm">
            Actor type
            <NativeSelect
              name="actorType"
              defaultValue={filters.actorType ?? ""}
              className="mt-2 w-full"
            >
              <option value="">Any</option>
              {AUDIT_ACTOR_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </NativeSelect>
          </label>
          <label className="text-sm">
            Actor ID
            <Input
              name="actorId"
              defaultValue={filters.actorId}
              placeholder="User, staff or system ID"
              className="mt-2"
            />
          </label>
          <div className="text-sm">
            <label htmlFor="audit-action">Action</label>
            <div className="mt-2 flex gap-2">
              <NativeSelect
                name="actionMatch"
                aria-label="How to match the action"
                defaultValue={filters.actionPrefix ? "prefix" : "exact"}
                className="w-28 shrink-0"
              >
                <option value="exact">is</option>
                <option value="prefix">starts with</option>
              </NativeSelect>
              <Input
                id="audit-action"
                name="action"
                defaultValue={filters.actionPrefix ?? filters.action}
                placeholder="e.g. payout."
              />
            </div>
          </div>
          <label className="text-sm">
            Entity type
            <Input
              name="entityType"
              defaultValue={filters.entityType}
              placeholder="e.g. payout"
              className="mt-2"
            />
          </label>
          <label className="text-sm">
            Entity ID
            <Input
              name="entityId"
              defaultValue={filters.entityId}
              className="mt-2"
            />
          </label>
          <label className="text-sm">
            From (Nairobi date)
            <Input
              type="date"
              name="from"
              defaultValue={filters.from}
              className="mt-2"
            />
          </label>
          <label className="text-sm">
            To (Nairobi date)
            <Input
              type="date"
              name="to"
              defaultValue={filters.to}
              className="mt-2"
            />
          </label>
          <div className="flex flex-wrap gap-3 sm:col-span-2 xl:col-span-4">
            <Button type="submit">Search</Button>
            <Button type="button" onClick={onClear} variant="outline">
              Clear
            </Button>
          </div>
        </CardContent>
      </Card>
    </form>
  );
}

/** Keyed on the filters, so a new search starts again at the newest page. */
function AuditResults({ filters }: { filters: AuditFilters }) {
  const { api } = useStaffAuth();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = { ...filters, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const toggle = useCallback(
    (id: string) => setSelectedId((current) => (current === id ? null : id)),
    [],
  );

  const result = useQuery({
    queryKey: queryKeys.auditSearch(query),
    queryFn: () => api.searchAudit(query),
    placeholderData: keepPreviousData,
  });

  if (result.isPending) {
    return <PageLoading label="Searching audit entries…" />;
  }
  if (result.isError) {
    return <PageError>{describeApiError(result.error)}</PageError>;
  }

  const { entries, nextCursor } = result.data;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const pageNumber = cursors.length;

  return (
    <div className="flex flex-col gap-6">
      <Card className="gap-0 overflow-hidden py-0">
        {entries.length === 0 ? (
          <PageEmpty title="No entries match.">
            Try a different company, action or date range.
          </PageEmpty>
        ) : (
          <AuditTable
            entries={entries}
            selectedId={selectedId}
            onSelect={toggle}
          />
        )}

        <CursorPager
          page={pageNumber}
          hasPrevious={pageNumber > 1}
          hasNext={Boolean(nextCursor) && !result.isPlaceholderData}
          onPrevious={() => {
            setSelectedId(null);
            setCursors((stack) => stack.slice(0, -1));
          }}
          onNext={() => {
            if (!nextCursor) return;
            setSelectedId(null);
            setCursors((stack) => [...stack, nextCursor]);
          }}
          previousLabel="Newer"
          nextLabel="Older"
        />
      </Card>

      {selected ? (
        <AuditEntryDetail
          entry={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function AuditTable({
  entries,
  selectedId,
  onSelect,
}: {
  entries: AuditEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const columns = useMemo(
    () => auditColumns({ selectedId, onSelect }),
    [selectedId, onSelect],
  );
  const table = useDataTable({
    data: entries,
    columns,
    getRowId: (entry) => entry.id,
    manual: true,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption="Audit entries"
      onRowOpen={(entry) => onSelect(entry.id)}
      openRowId={selectedId}
    />
  );
}

function AuditEntryDetail({
  entry,
  onClose,
}: {
  entry: AuditEntry;
  onClose: () => void;
}) {
  const facts: [string, string][] = [
    ["Entry ID", entry.id],
    ["Time", formatNairobiTime(entry.occurredAt)],
    ["Actor", `${entry.actor.type} ${actorLabel(entry)} (${entry.actor.id})`],
    [
      "Company",
      entry.organization
        ? `${entry.organization.name} (${entry.organization.id})`
        : "Platform-wide",
    ],
    ["Action", entry.action],
    ["Entity", `${entry.entity.type} ${entry.entity.id ?? ""}`.trim()],
    ["Request ID", entry.requestId ?? "—"],
    ["IP", entry.ip ?? "—"],
    ["Device", entry.userAgent ?? "—"],
  ];

  return (
    <section aria-label="Audit entry" className="min-w-0">
      <Card>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <h2 className="min-w-0 font-mono text-base font-semibold break-all">
              {entry.action}
            </h2>
            <Button type="button" onClick={onClose} variant="outline">
              Close
            </Button>
          </div>

          <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[10rem_1fr]">
            {facts.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
          </dl>

          {entry.organization ? (
            <p className="mt-3 text-sm">
              <Link
                href={`/companies/${entry.organization.id}`}
                className="font-medium text-accent-foreground underline-offset-4 hover:underline"
              >
                Open the company
              </Link>
            </p>
          ) : null}

          <h3 className="mt-6 text-sm font-semibold">Before and after</h3>
          <div className="mt-2">
            <JsonDiff before={entry.before} after={entry.after} />
          </div>

          <details className="mt-4 text-sm">
            <summary className="cursor-pointer text-muted-foreground">
              Raw JSON
            </summary>
            <div className="mt-2 grid min-w-0 gap-4 md:grid-cols-2 [&>pre]:min-w-0">
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(entry.before, null, 2)}
              </pre>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                {JSON.stringify(entry.after, null, 2)}
              </pre>
            </div>
          </details>
        </CardContent>
      </Card>
    </section>
  );
}
