"use client";

import type { FormEvent } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
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
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Companies</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Search by name or KRA PIN.
        </p>
      </header>
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
          <form key={search} onSubmit={onSearch} className="max-w-xl">
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
          <CompanyResults key={search} search={search} />
        </CardContent>
      </Card>
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

  const { companies, nextCursor } = result.data;
  return (
    <div className="flex flex-col gap-4">
      {companies.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No companies match.</EmptyTitle>
            <EmptyDescription>
              Try another company name or KRA PIN.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="min-w-0">
          <Table aria-label="Company directory">
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Company</TableHead>
                <TableHead scope="col">KRA PIN</TableHead>
                <TableHead scope="col">Payouts</TableHead>
                <TableHead scope="col">Signed up</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {companies.map((company) => (
                <TableRow key={company.id}>
                  <TableCell className="min-w-40 max-w-72 whitespace-normal wrap-anywhere">
                    <Button
                      asChild
                      variant="link"
                      className="h-auto justify-start px-0 text-left whitespace-normal wrap-anywhere"
                    >
                      <Link href={`/companies/${company.id}`}>
                        {company.name}
                      </Link>
                    </Button>
                  </TableCell>
                  <TableCell>{company.kraPin ?? "—"}</TableCell>
                  <TableCell>
                    <Badge
                      variant={company.payoutsPaused ? "secondary" : "outline"}
                    >
                      {company.payoutsPaused ? "Paused" : "Running"}
                    </Badge>
                  </TableCell>
                  <TableCell>{formatNairobiTime(company.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      <nav
        aria-label="Pages"
        className="flex flex-wrap items-center gap-4 text-sm"
      >
        <Button
          type="button"
          disabled={cursors.length === 1}
          onClick={() => setCursors((stack) => stack.slice(0, -1))}
          variant="outline"
        >
          Previous
        </Button>
        <span className="text-muted-foreground">Page {cursors.length}</span>
        <Button
          type="button"
          disabled={!nextCursor || result.isPlaceholderData}
          onClick={() => {
            if (nextCursor) setCursors((stack) => [...stack, nextCursor]);
          }}
          variant="outline"
        >
          Next
        </Button>
      </nav>
    </div>
  );
}
