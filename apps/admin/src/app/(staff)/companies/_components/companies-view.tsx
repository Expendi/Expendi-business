"use client";

import type { FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useMemo, useState } from "react";

import { CursorPager } from "~/components/cursor-pager";
import { DataTable, useDataTable } from "~/components/data/data-table";
import { PageHeader } from "~/components/data/page-header";
import { EmptyState } from "~/components/data/states";
import { Alert, AlertDescription } from "~/components/ui/alert";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { queryKeys } from "~/lib/query-keys";
import { companyColumns } from "./columns";

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
    <section className="flex flex-col gap-6">
      <PageHeader title="Companies" subtitle="Search by name or KRA PIN." />
      <Card>
        <CardHeader>
          <CardTitle>
            <h2>Company directory</h2>
          </CardTitle>
          <CardDescription>
            Find a company to review its account and payouts.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <form key={`form-${search}`} onSubmit={onSearch} className="max-w-xl">
            <FieldGroup className="flex-row items-end gap-3">
              <Field className="min-w-0 flex-1">
                <FieldLabel htmlFor="company-search">
                  Name or KRA PIN
                </FieldLabel>
                <Input
                  id="company-search"
                  name="search"
                  defaultValue={search}
                  placeholder="e.g. Acme or P051234567X"
                />
              </Field>
              <Button type="submit">Search</Button>
            </FieldGroup>
          </form>
          <CompanyResults key={`results-${search}`} search={search} />
        </CardContent>
      </Card>
    </section>
  );
}

function CompanyResults({ search }: { search: string }) {
  const { api } = useStaffAuth();
  const router = useRouter();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const query = { search, cursor: cursors.at(-1), limit: PAGE_SIZE };
  const result = useQuery({
    queryKey: queryKeys.companies(query),
    queryFn: () => api.ops.searchCompanies(query),
    placeholderData: keepPreviousData,
  });
  const companies = useMemo(() => result.data?.companies ?? [], [result.data]);
  const table = useDataTable({
    data: companies,
    columns: companyColumns,
    getRowId: (company) => company.id,
    manual: true,
    paginate: false,
  });

  if (result.isPending) {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    );
  }
  if (result.isError) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{describeApiError(result.error)}</AlertDescription>
      </Alert>
    );
  }

  const nextCursor = result.data.nextCursor;
  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-lg border border-border">
        <DataTable
          table={table}
          caption="Company directory"
          onRowOpen={(company) => router.push(`/companies/${company.id}`)}
          empty={
            <EmptyState title="No companies match.">
              Try another company name or KRA PIN.
            </EmptyState>
          }
        />
      </div>
      <CursorPager
        page={cursors.length}
        hasPrevious={cursors.length > 1}
        hasNext={Boolean(nextCursor) && !result.isPlaceholderData}
        onPrevious={() => setCursors((stack) => stack.slice(0, -1))}
        onNext={() => {
          if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
        }}
        previousLabel="Previous"
        nextLabel="Next"
      />
    </div>
  );
}
