"use client";

import type { FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";

import { PauseFlow } from "~/components/pause-flow";
import { inputClass, linkClass, secondaryButton } from "~/components/styles";
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
      <h1 className="text-xl font-semibold">Controls</h1>
      <p className="mt-1 text-sm text-stone-600">
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
        <p className="mt-6 text-sm text-stone-500">Loading…</p>
      ) : result.isError ? (
        <p role="alert" className="mt-6 text-sm text-error-700">
          {describeApiError(result.error)}
        </p>
      ) : (
        <>
          <div className="mt-6 rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-base font-semibold">All companies</h2>
            <p className="mt-1 text-sm">
              {result.data.platformPayoutsPaused
                ? "Every company's payouts are paused."
                : "Payouts are running."}{" "}
              <span className="text-stone-500">
                Last changed {formatNairobiTime(result.data.platformUpdatedAt)}.
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
          </div>

          <div className="mt-6 rounded-lg border border-stone-200 bg-white p-4">
            <h2 className="text-base font-semibold">Paused companies</h2>
            {result.data.pausedCompanies.length === 0 ? (
              <p className="mt-1 text-sm text-stone-500">None.</p>
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
          </div>

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
    <div className="mt-6 rounded-lg border border-stone-200 bg-white p-4">
      <h2 className="text-base font-semibold">Pause one company</h2>
      <p className="mt-1 text-sm text-stone-600">
        Find the company under{" "}
        <Link href="/companies" className={linkClass}>
          Companies
        </Link>{" "}
        and pause it from its page, or paste its ID here.
      </p>
      <form onSubmit={onChoose} className="mt-3 flex items-end gap-3">
        <label className="flex-1 text-sm">
          Company ID
          <input
            value={input}
            onChange={(event) => setInput(event.target.value)}
            className={inputClass}
          />
        </label>
        <button type="submit" className={secondaryButton}>
          Choose
        </button>
      </form>
      {invalid ? (
        <p role="alert" className="mt-2 text-sm text-error-700">
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
    </div>
  );
}
