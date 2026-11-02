"use client";

import type { FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import {
  cellClass,
  headCellClass,
  inputClass,
  linkClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

const PAGE_SIZE = 50;

export function CompaniesView() {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams().get("search")?.trim() ?? "";

  function onSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get("search");
    const term = typeof value === "string" ? value.trim() : "";
    router.push(
      term ? `${pathname}?search=${encodeURIComponent(term)}` : pathname,
    );
  }

  return (
    <section>
      <h1 className="text-xl font-semibold">Companies</h1>
      <p className="mt-1 text-sm text-stone-600">Search by name or KRA PIN.</p>
      <form
        key={search}
        onSubmit={onSearch}
        className="mt-6 flex max-w-xl items-end gap-3"
      >
        <label className="flex-1 text-sm">
          Name or KRA PIN
          <input
            name="search"
            defaultValue={search}
            placeholder="e.g. Acme or P051234567X"
            className={inputClass}
          />
        </label>
        <button type="submit" className={primaryButton}>
          Search
        </button>
      </form>
      <CompanyResults key={search} search={search} />
    </section>
  );
}

function CompanyResults({ search }: { search: string }) {
  const { api } = useStaffAuth();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = { search, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const result = useQuery({
    queryKey: queryKeys.companies(query),
    queryFn: () => api.ops.searchCompanies(query),
    placeholderData: keepPreviousData,
  });

  if (result.isPending) {
    return <p className="mt-6 text-sm text-stone-500">Loading…</p>;
  }
  if (result.isError) {
    return (
      <p role="alert" className="mt-6 text-sm text-error-700">
        {describeApiError(result.error)}
      </p>
    );
  }

  const { companies, nextCursor } = result.data;
  return (
    <div className="mt-6">
      {companies.length === 0 ? (
        <p className="text-sm text-stone-500">No companies match.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className={tableClass}>
            <thead className="bg-stone-100 text-stone-600">
              <tr>
                <th scope="col" className={headCellClass}>
                  Company
                </th>
                <th scope="col" className={headCellClass}>
                  KRA PIN
                </th>
                <th scope="col" className={headCellClass}>
                  Payouts
                </th>
                <th scope="col" className={headCellClass}>
                  Signed up
                </th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.id} className="border-t border-stone-200">
                  <td className={cellClass}>
                    <Link
                      href={`/companies/${company.id}`}
                      className={linkClass}
                    >
                      {company.name}
                    </Link>
                  </td>
                  <td className={`${cellClass} font-mono text-xs`}>
                    {company.kraPin ?? "—"}
                  </td>
                  <td className={cellClass}>
                    {company.payoutsPaused ? (
                      <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                        Paused
                      </span>
                    ) : (
                      <span className="text-xs text-stone-500">Running</span>
                    )}
                  </td>
                  <td className={`${cellClass} whitespace-nowrap`}>
                    {formatNairobiTime(company.createdAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <nav aria-label="Pages" className="mt-4 flex items-center gap-4 text-sm">
        <button
          type="button"
          disabled={cursors.length === 1}
          onClick={() => setCursors((stack) => stack.slice(0, -1))}
          className={secondaryButton}
        >
          Previous
        </button>
        <span className="text-stone-600">Page {cursors.length}</span>
        <button
          type="button"
          disabled={!nextCursor || result.isPlaceholderData}
          onClick={() => {
            if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
          }}
          className={secondaryButton}
        >
          Next
        </button>
      </nav>
    </div>
  );
}
