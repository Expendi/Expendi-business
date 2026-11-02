"use client";

import type { FormEvent, JSX } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { ActivityEntry, ActivityPage } from "@expendi-business/shared";
import { activityPageSchema } from "@expendi-business/shared";

import {
  alertClass,
  cellClass,
  headCellClass,
  inputClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApi } from "~/lib/use-api";
import {
  ACTIVITY_AREAS,
  describeAction,
  describeActor,
  describeChanges,
} from "./activity-display";

const PAGE_SIZE = 50;

interface ActivityFilters {
  readonly actionPrefix?: string;
  readonly from?: string;
  readonly to?: string;
}

const NO_FILTERS: ActivityFilters = {};

function activityPath(
  organizationId: string,
  filters: ActivityFilters,
  cursor: string | null,
): `/${string}` {
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  for (const [key, value] of Object.entries(filters)) {
    if (typeof value === "string" && value !== "") params.set(key, value);
  }
  if (cursor) params.set("cursor", cursor);
  return `/organizations/${organizationId}/activity?${params.toString()}`;
}

function filtersFrom(form: FormData): ActivityFilters {
  const text = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" && value !== "" ? value : undefined;
  };
  const actionPrefix = text("actionPrefix");
  const from = text("from");
  const to = text("to");
  return {
    ...(actionPrefix ? { actionPrefix } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
}

/**
 * The company's own audit log (spec §6.13, §6.14), read-only, for admins
 * and accountants: who changed what and when, newest first.
 */
export function ActivityView(): JSX.Element {
  const { company } = useDashboard();
  return (
    <CompanyActivity
      key={company.organizationId}
      organizationId={company.organizationId}
    />
  );
}

function CompanyActivity({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const [filters, setFilters] = useState<ActivityFilters>(NO_FILTERS);

  function onFilter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFilters(filtersFrom(new FormData(event.currentTarget)));
  }

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Activity</h1>
        <p className="mt-1 text-sm text-stone-600">
          Every change to the company&apos;s money, people and settings, by whom
          and when, in Nairobi time. Nothing here can be edited or deleted.
        </p>
      </div>

      <form
        onSubmit={onFilter}
        aria-label="Filter activity"
        className="grid grid-cols-1 gap-4 rounded-lg border border-stone-200 bg-white p-4 sm:grid-cols-3"
      >
        <label className="text-sm">
          Area
          <select name="actionPrefix" defaultValue="" className={inputClass}>
            <option value="">Everything</option>
            {ACTIVITY_AREAS.map((area) => (
              <option key={area.prefix} value={area.prefix}>
                {area.label}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          From
          <input type="date" name="from" className={inputClass} />
        </label>
        <label className="text-sm">
          To
          <input type="date" name="to" className={inputClass} />
        </label>
        <div className="flex gap-3 sm:col-span-3">
          <button type="submit" className={primaryButton}>
            Filter
          </button>
          <button
            type="reset"
            onClick={() => setFilters(NO_FILTERS)}
            className={secondaryButton}
          >
            Clear
          </button>
        </div>
      </form>

      <ActivityResults
        key={JSON.stringify(filters)}
        organizationId={organizationId}
        filters={filters}
      />
    </section>
  );
}

function ActivityResults({
  organizationId,
  filters,
}: {
  organizationId: string;
  filters: ActivityFilters;
}): JSX.Element {
  const api = useApi();
  const result = useInfiniteQuery({
    queryKey: ["activity", organizationId, filters],
    queryFn: ({ pageParam }): Promise<ActivityPage> =>
      api.get(
        activityPath(organizationId, filters, pageParam),
        activityPageSchema,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  if (result.isPending) {
    return <p className="text-sm text-stone-500">Loading activity…</p>;
  }
  if (result.isError) {
    return (
      <div className={alertClass} role="alert">
        <p>{describeApiError(result.error)}</p>
        <button
          type="button"
          onClick={() => void result.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }

  const entries = result.data.pages.flatMap((page) => page.entries);
  if (entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        Nothing matches these filters.
      </p>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
        <table className={tableClass}>
          <thead className="bg-stone-100 text-stone-600">
            <tr>
              <th scope="col" className={headCellClass}>
                When
              </th>
              <th scope="col" className={headCellClass}>
                Who
              </th>
              <th scope="col" className={headCellClass}>
                What
              </th>
              <th scope="col" className={headCellClass}>
                Details
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} />
            ))}
          </tbody>
        </table>
      </div>
      {result.hasNextPage ? (
        <button
          type="button"
          onClick={() => void result.fetchNextPage()}
          disabled={result.isFetchingNextPage}
          className={`mt-4 ${secondaryButton}`}
        >
          {result.isFetchingNextPage ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </div>
  );
}

function ActivityRow({ entry }: { entry: ActivityEntry }): JSX.Element {
  const changes = describeChanges(entry.before, entry.after);
  return (
    <tr className="border-t border-stone-200 align-top">
      <td className={`${cellClass} whitespace-nowrap`}>
        {formatNairobiDateTime(entry.occurredAt)}
      </td>
      <td className={cellClass}>{describeActor(entry.actor)}</td>
      <td className={cellClass}>
        <span className="font-medium">{describeAction(entry.action)}</span>
        <span className="block font-mono text-xs text-stone-500">
          {entry.action}
        </span>
      </td>
      <td className={`${cellClass} max-w-md`}>
        {changes.length > 0 ? (
          <ul className="space-y-0.5 break-words text-stone-700">
            {changes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        ) : (
          <span className="text-stone-500">—</span>
        )}
        {entry.before !== null || entry.after !== null ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-stone-500">
              Recorded values
            </summary>
            <pre className="mt-1 max-h-64 overflow-auto rounded bg-stone-50 p-2 text-xs whitespace-pre-wrap">
              {JSON.stringify(
                { before: entry.before, after: entry.after },
                null,
                2,
              )}
            </pre>
          </details>
        ) : null}
      </td>
    </tr>
  );
}
