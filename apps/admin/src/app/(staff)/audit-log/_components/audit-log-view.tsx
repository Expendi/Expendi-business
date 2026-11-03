"use client";

import type { FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import type { AuditEntry } from "@expendi-business/shared";
import { AUDIT_ACTOR_TYPES } from "@expendi-business/shared";

import type { AuditFilters } from "./audit-filters";
import { JsonDiff } from "~/components/json-diff";
import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { NativeSelect } from "~/components/ui/native-select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";
import {
  filtersFromForm,
  filtersFromParams,
  filtersToParams,
} from "./audit-filters";

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
    <section>
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Every recorded change to money, access and settings, across all
        companies. Read-only. Times are Nairobi time.
      </p>

      <AuditSearchForm
        key={filtersKey}
        filters={filters}
        onSubmit={onSearch}
        onClear={() => router.push(pathname)}
      />

      <AuditResults key={filtersKey} filters={filters} />
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
    <form
      onSubmit={onSubmit}
      className="mt-6 grid grid-cols-1 gap-4 rounded-xl border border-border bg-card p-4 sm:grid-cols-2 sm:p-6 xl:grid-cols-4"
    >
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
    </form>
  );
}

/** Keyed on the filters, so a new search starts again at the newest page. */
function AuditResults({ filters }: { filters: AuditFilters }) {
  const { api } = useStaffAuth();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const query = { ...filters, cursor: cursors.at(-1), limit: PAGE_SIZE };

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
    <div className="mt-6">
      {entries.length === 0 ? (
        <PageEmpty title="No entries match.">
          Try a different company, action or date range.
        </PageEmpty>
      ) : (
        <AuditTable
          entries={entries}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
      )}

      <nav
        aria-label="Pages"
        className="mt-4 flex flex-wrap items-center gap-3 text-sm text-muted-foreground"
      >
        <Button
          type="button"
          disabled={pageNumber === 1}
          onClick={() => {
            setSelectedId(null);
            setCursors((stack) => stack.slice(0, -1));
          }}
          variant="outline"
        >
          Newer
        </Button>
        <span>Page {pageNumber}</span>
        <Button
          type="button"
          disabled={!nextCursor || result.isPlaceholderData}
          onClick={() => {
            if (!nextCursor) return;
            setSelectedId(null);
            setCursors((stack) => [...stack, nextCursor]);
          }}
          variant="outline"
        >
          Older
        </Button>
      </nav>

      {selected ? (
        <AuditEntryDetail
          entry={selected}
          onClose={() => setSelectedId(null)}
        />
      ) : null}
    </div>
  );
}

function actorLabel(entry: AuditEntry): string {
  return entry.actor.email ?? entry.actor.id;
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
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Table aria-label="Audit entries">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Time</TableHead>
            <TableHead scope="col">Company</TableHead>
            <TableHead scope="col">Actor</TableHead>
            <TableHead scope="col">Action</TableHead>
            <TableHead scope="col">Entity</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {entries.map((entry) => (
            <TableRow
              key={entry.id}
              data-state={entry.id === selectedId ? "selected" : undefined}
            >
              <TableCell>
                <Button
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-expanded={entry.id === selectedId}
                  variant="link"
                  className="px-0"
                >
                  {formatNairobiTime(entry.occurredAt)}
                </Button>
              </TableCell>
              <TableCell className="min-w-40 max-w-64 break-words whitespace-normal">
                {entry.organization?.name ?? (
                  <span className="text-stone-500">Platform</span>
                )}
              </TableCell>
              <TableCell className="min-w-40 max-w-64 break-all whitespace-normal">
                <span className="text-xs text-stone-500">
                  {entry.actor.type}
                </span>{" "}
                {actorLabel(entry)}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {entry.action}
              </TableCell>
              <TableCell className="font-mono text-xs">
                {entry.entity.type}
                {entry.entity.id ? ` ${entry.entity.id}` : ""}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
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
    <section
      aria-label="Audit entry"
      className="mt-6 min-w-0 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
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
            <dt className="text-stone-500">{label}</dt>
            <dd className="break-all">{value}</dd>
          </div>
        ))}
      </dl>

      {entry.organization ? (
        <p className="mt-3 text-sm">
          <Link
            href={`/companies/${entry.organization.id}`}
            className="font-medium text-brand-700 underline-offset-4 hover:underline"
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
        <summary className="cursor-pointer text-stone-600">Raw JSON</summary>
        <div className="mt-2 grid min-w-0 gap-4 md:grid-cols-2 [&>pre]:min-w-0">
          <pre className="overflow-x-auto rounded-md bg-stone-100 p-3 text-xs">
            {JSON.stringify(entry.before, null, 2)}
          </pre>
          <pre className="overflow-x-auto rounded-md bg-stone-100 p-3 text-xs">
            {JSON.stringify(entry.after, null, 2)}
          </pre>
        </div>
      </details>
    </section>
  );
}
