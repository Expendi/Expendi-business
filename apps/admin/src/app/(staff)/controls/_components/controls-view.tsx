"use client";

import type { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { PageEmpty, PageError, PageLoading } from "~/components/page-state";
import { PauseFlow } from "~/components/pause-flow";
import { inputClass, linkClass, secondaryButton } from "~/components/styles";
import { Card, CardContent, CardHeader, CardTitle } from "~/components/ui/card";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { describeApiError } from "~/lib/api";
import { formatNairobiTime } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The payout pause (spec §6.15, §7.6): every company, or one. Pausing
 * never moves money; it stops new payouts at once.
 */
export function ControlsView() {
  const { api, staff } = useStaffAuth();
  const canAct = staff?.role === "ops_admin";
  const result = useQuery({
    queryKey: queryKeys.controls(),
    queryFn: () => api.ops.controls(),
  });

  return (
    <section className="max-w-3xl">
      <h1 className="text-2xl font-semibold tracking-tight">Controls</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Pause payouts for every company or for one. Pausing sends nothing and
        takes effect at once; every change needs a reason and a second
        confirmation, and is audited.
      </p>
      {canAct ? null : (
        <p className="mt-2 text-sm text-stone-500">
          You can look but not change anything: that needs an ops admin.
        </p>
      )}

      {result.isPending ? (
        <PageLoading label="Loading payout controls…" />
      ) : result.isError ? (
        <PageError>{describeApiError(result.error)}</PageError>
      ) : (
        <>
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>
                <h2>All companies</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="mt-1 text-sm">
                {result.data.platformPayoutsPaused
                  ? "Every company's payouts are paused."
                  : "Payouts are running."}{" "}
                <span className="text-stone-500">
                  Last changed{" "}
                  {formatNairobiTime(result.data.platformUpdatedAt)}.
                </span>
              </p>
              {canAct ? (
                <div className="mt-3">
                  {result.data.platformPayoutsPaused ? (
                    <PauseFlow
                      action="unpause"
                      label="Unpause every company's payouts"
                    />
                  ) : (
                    <PauseFlow
                      action="pause"
                      label="Pause every company's payouts"
                    />
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card className="mt-6">
            <CardHeader>
              <CardTitle>
                <h2>Paused companies</h2>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {result.data.pausedCompanies.length === 0 ? (
                <PageEmpty title="No individually paused companies." />
              ) : (
                <ul className="mt-2 space-y-4">
                  {result.data.pausedCompanies.map((company) => (
                    <li key={company.id}>
                      <Link
                        href={`/companies/${company.id}`}
                        className={linkClass}
                      >
                        {company.name}
                      </Link>
                      {canAct ? (
                        <div className="mt-2">
                          <PauseFlow
                            action="unpause"
                            organizationId={company.id}
                            label={`Unpause ${company.name}'s payouts`}
                          />
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          {canAct ? <PauseOneCompany /> : null}
        </>
      )}
    </section>
  );
}

function PauseOneCompany() {
  const [input, setInput] = useState("");
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);

  function onChoose(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const id = input.trim();
    setInvalid(!UUID.test(id));
    setCompanyId(UUID.test(id) ? id : null);
  }

  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>
          <h2>Pause one company</h2>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mt-1 text-sm text-stone-600">
          Find the company under{" "}
          <Link href="/companies" className={linkClass}>
            Companies
          </Link>{" "}
          and pause it from its page, or paste its ID here.
        </p>
        <form
          onSubmit={onChoose}
          className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end"
        >
          <label className="min-w-0 flex-1 text-sm">
            Company ID
            <input
              value={input}
              aria-invalid={invalid}
              aria-describedby={invalid ? "company-id-error" : undefined}
              onChange={(event) => setInput(event.target.value)}
              className={inputClass}
            />
          </label>
          <button type="submit" className={secondaryButton}>
            Choose
          </button>
        </form>
        {invalid ? (
          <p
            id="company-id-error"
            role="alert"
            className="mt-2 text-sm text-error-700"
          >
            That isn&apos;t a company ID.
          </p>
        ) : null}
        {companyId ? (
          <div className="mt-3">
            <PauseFlow
              key={companyId}
              action="pause"
              organizationId={companyId}
              label="Pause this company's payouts"
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
