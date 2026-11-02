"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { PayrollRun } from "@expendi-business/shared";

import { cellClass, headCellClass, tableClass } from "~/components/styles";
import { StatusBadge } from "~/features/payment-ui";
import { usePayrollRuns } from "~/features/payroll/payroll-api";
import {
  DRAFT_TIMING,
  RUN_STATUS_LABELS,
} from "~/features/payroll/payroll-display";
import { progressInWords } from "~/features/payroll/payroll-payment";
import { formatIsoDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { QueryError } from "./query-error";
import { RunPanel } from "./run-panel";

/**
 * Payroll runs, latest pay day first. A draft run, or else one with failed
 * payments, opens on its own: it's the one waiting for the admin.
 */
export function PayrollRunsSection({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const runs = usePayrollRuns(organizationId);
  // undefined: nothing picked yet, so the waiting run opens; null: closed.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const waiting =
    runs.data?.find((run) => run.status === "draft") ??
    runs.data?.find((run) => run.status === "partly_failed");
  const openId = picked === undefined ? (waiting?.id ?? null) : picked;

  return (
    <section aria-label="Payroll runs" className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Payroll runs</h2>
        <p className="text-sm text-stone-600">{DRAFT_TIMING}</p>
      </div>
      {runs.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : runs.isError ? (
        <QueryError error={runs.error} onRetry={() => void runs.refetch()} />
      ) : runs.data.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
          No payroll runs yet. The first one is drafted before the next pay day.
        </p>
      ) : (
        <div className="space-y-6">
          <RunTable runs={runs.data} openId={openId} onOpen={setPicked} />
          {openId ? (
            <RunPanel
              key={openId}
              organizationId={organizationId}
              runId={openId}
              canAct={canAct}
              onClose={() => setPicked(null)}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function RunTable({
  runs,
  openId,
  onOpen,
}: {
  runs: readonly PayrollRun[];
  openId: string | null;
  onOpen: (runId: string) => void;
}): JSX.Element {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Pay day
            </th>
            <th scope="col" className={headCellClass}>
              Status
            </th>
            <th scope="col" className={headCellClass}>
              People
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              Total, KES
            </th>
            <th scope="col" className={headCellClass}>
              Payments
            </th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const status = RUN_STATUS_LABELS[run.status];
            return (
              <tr
                key={run.id}
                className={`border-t border-stone-200 align-top ${run.id === openId ? "bg-brand-50" : ""}`}
              >
                <td className={`${cellClass} whitespace-nowrap`}>
                  <button
                    type="button"
                    onClick={() => onOpen(run.id)}
                    aria-pressed={run.id === openId}
                    className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
                  >
                    {formatIsoDate(run.payDate)}
                  </button>
                </td>
                <td className={cellClass}>
                  <StatusBadge label={status.label} tone={status.tone} />
                </td>
                <td className={cellClass}>
                  {String(run.people)}
                  {run.leftOut > 0 ? (
                    <span className="block text-xs text-stone-500">
                      {String(run.leftOut)} left out
                    </span>
                  ) : null}
                </td>
                <td
                  className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
                >
                  {formatKesCents(run.totalKes)}
                </td>
                <td className={cellClass}>{progressInWords(run) ?? "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
