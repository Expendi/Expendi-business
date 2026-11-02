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

const inputClass =
  "mt-1 w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none";

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
      <h1 className="text-xl font-semibold">Audit log</h1>
      <p className="mt-1 text-sm text-stone-600">
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
      className="mt-6 grid grid-cols-1 gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      <label className="text-sm">
        Company ID
        <input
          name="organizationId"
          defaultValue={filters.organizationId}
          placeholder="Any company"
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        Actor type
        <select
          name="actorType"
          defaultValue={filters.actorType ?? ""}
          className={inputClass}
        >
          <option value="">Any</option>
          {AUDIT_ACTOR_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
      </label>
      <label className="text-sm">
        Actor ID
        <input
          name="actorId"
          defaultValue={filters.actorId}
          placeholder="User, staff or system ID"
          className={inputClass}
        />
      </label>
      <div className="text-sm">
        <label htmlFor="audit-action">Action</label>
        <div className="mt-1 flex gap-2">
          <select
            name="actionMatch"
            aria-label="How to match the action"
            defaultValue={filters.actionPrefix ? "prefix" : "exact"}
            className="rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm"
          >
            <option value="exact">is</option>
            <option value="prefix">starts with</option>
          </select>
          <input
            id="audit-action"
            name="action"
            defaultValue={filters.actionPrefix ?? filters.action}
            placeholder="e.g. payout."
            className="w-full rounded-md border border-stone-300 bg-white px-2 py-1.5 text-sm focus:border-brand-600 focus:outline-none"
          />
        </div>
      </div>
      <label className="text-sm">
        Entity type
        <input
          name="entityType"
          defaultValue={filters.entityType}
          placeholder="e.g. payout"
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        Entity ID
        <input
          name="entityId"
          defaultValue={filters.entityId}
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        From (Nairobi date)
        <input
          type="date"
          name="from"
          defaultValue={filters.from}
          className={inputClass}
        />
      </label>
      <label className="text-sm">
        To (Nairobi date)
        <input
          type="date"
          name="to"
          defaultValue={filters.to}
          className={inputClass}
        />
      </label>
      <div className="flex gap-3 sm:col-span-2 lg:col-span-4">
        <button
          type="submit"
          className="rounded-md bg-brand-700 px-4 py-2 text-sm font-medium text-white hover:bg-brand-600"
        >
          Search
        </button>
        <button
          type="button"
          onClick={onClear}
          className="rounded-md border border-stone-300 px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100"
        >
          Clear
        </button>
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
    return <p className="mt-6 text-sm text-stone-500">Searching…</p>;
  }
  if (result.isError) {
    return (
      <p role="alert" className="mt-6 text-sm text-error-700">
        {describeApiError(result.error)}
      </p>
    );
  }

  const { entries, nextCursor } = result.data;
  const selected = entries.find((entry) => entry.id === selectedId) ?? null;
  const pageNumber = cursors.length;

  return (
    <div className="mt-6">
      {entries.length === 0 ? (
        <p className="text-sm text-stone-500">No entries match.</p>
      ) : (
        <AuditTable
          entries={entries}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId(id === selectedId ? null : id)}
        />
      )}

      <nav
        aria-label="Pages"
        className="mt-4 flex items-center gap-4 text-sm text-stone-600"
      >
        <button
          type="button"
          disabled={pageNumber === 1}
          onClick={() => {
            setSelectedId(null);
            setCursors((stack) => stack.slice(0, -1));
          }}
          className="rounded-md border border-stone-300 px-3 py-1.5 font-medium disabled:opacity-40"
        >
          Newer
        </button>
        <span>Page {pageNumber}</span>
        <button
          type="button"
          disabled={!nextCursor || result.isPlaceholderData}
          onClick={() => {
            if (!nextCursor) return;
            setSelectedId(null);
            setCursors((stack) => [...stack, nextCursor]);
          }}
          className="rounded-md border border-stone-300 px-3 py-1.5 font-medium disabled:opacity-40"
        >
          Older
        </button>
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
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className="w-full text-left text-sm">
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">
              Time
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Company
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Actor
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Action
            </th>
            <th scope="col" className="px-3 py-2 font-medium">
              Entity
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr
              key={entry.id}
              className={`border-t border-stone-200 ${entry.id === selectedId ? "bg-brand-50" : "hover:bg-stone-50"}`}
            >
              <td className="px-3 py-2 whitespace-nowrap">
                <button
                  type="button"
                  onClick={() => onSelect(entry.id)}
                  aria-expanded={entry.id === selectedId}
                  className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
                >
                  {formatNairobiTime(entry.occurredAt)}
                </button>
              </td>
              <td className="px-3 py-2">
                {entry.organization?.name ?? (
                  <span className="text-stone-500">Platform</span>
                )}
              </td>
              <td className="px-3 py-2">
                <span className="text-xs text-stone-500">
                  {entry.actor.type}
                </span>{" "}
                {actorLabel(entry)}
              </td>
              <td className="px-3 py-2 font-mono text-xs">{entry.action}</td>
              <td className="px-3 py-2 font-mono text-xs">
                {entry.entity.type}
                {entry.entity.id ? ` ${entry.entity.id}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
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
      className="mt-6 rounded-lg border border-stone-200 bg-white p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <h2 className="font-mono text-base font-semibold">{entry.action}</h2>
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-medium text-stone-600 underline-offset-4 hover:underline"
        >
          Close
        </button>
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
        <div className="mt-2 grid gap-4 md:grid-cols-2">
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
