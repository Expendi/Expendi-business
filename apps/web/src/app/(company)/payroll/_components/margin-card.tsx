"use client";

import type { FormEvent, JSX } from "react";
import { useState } from "react";

import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import { alertClass, inputClass, primaryButton } from "~/components/styles";
import {
  useChangePayrollMargin,
  usePayrollMargin,
} from "~/features/payroll/payroll-api";
import { parseMarginPct } from "~/features/payroll/payroll-payment";
import { describeApprovalError } from "~/lib/approval";
import { QueryError } from "./query-error";

/**
 * The payroll cap's margin (spec §7.4): a run can pay at most its drafted
 * salaries plus this. Changing it needs the admin's passkey.
 */
export function MarginCard({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const margin = usePayrollMargin(organizationId);

  return (
    <section
      aria-label="Payroll cap"
      className="max-w-xl rounded-lg border border-stone-200 bg-white p-4"
    >
      <h2 className="text-base font-semibold">Payroll cap</h2>
      <p className="mt-1 text-sm text-stone-600">
        A payroll run can pay at most the salaries drafted into it plus this
        margin, so a mistake or a misuse can’t pay far more than the payroll
        that’s set up.
      </p>
      {margin.isPending ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : margin.isError ? (
        <div className="mt-3">
          <QueryError
            error={margin.error}
            onRetry={() => void margin.refetch()}
          />
        </div>
      ) : (
        <>
          <p className="mt-3 text-sm">
            Margin:{" "}
            <span className="font-semibold">
              {String(margin.data.marginPct)}%
            </span>
          </p>
          {canAct ? (
            <div className="mt-4">
              <ApprovalPasskeyGate>
                <ChangeMargin
                  organizationId={organizationId}
                  current={margin.data.marginPct}
                />
              </ApprovalPasskeyGate>
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function ChangeMargin({
  organizationId,
  current,
}: {
  organizationId: string;
  current: number;
}): JSX.Element {
  const change = useChangePayrollMargin(organizationId);
  const [typed, setTyped] = useState("");
  const [typedError, setTypedError] = useState<string | null>(null);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const marginPct = parseMarginPct(typed);
    if (marginPct === null) {
      setTypedError("Enter the margin as a whole percentage, 0 to 100.");
      return;
    }
    if (marginPct === current) {
      setTypedError(`The margin is already ${String(current)}%.`);
      return;
    }
    setTypedError(null);
    change.mutate(marginPct, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") setTyped("");
      },
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label="Change the margin"
      className="space-y-3"
    >
      <label className="block max-w-40 text-sm">
        New margin (%)
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          inputMode="numeric"
          maxLength={4}
          placeholder={String(current)}
          disabled={change.isPending}
          className={inputClass}
        />
      </label>
      <p className="text-sm text-stone-600">
        You confirm the change with your passkey. Every admin gets an email, and
        draft payroll runs use the new margin at once.
      </p>
      {typedError ? (
        <p className={alertClass} role="alert">
          {typedError}
        </p>
      ) : null}
      {change.data?.status === "approved" ? (
        <p className="text-sm text-stone-700" role="status">
          Saved. The margin is now {String(change.data.result.marginPct)}%.
        </p>
      ) : null}
      {change.data?.status === "cancelled" ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing changed.</p>
      ) : null}
      {change.isError ? (
        <p className={alertClass} role="alert">
          {describeApprovalError(change.error)}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={change.isPending}
        className={primaryButton}
      >
        {change.isPending ? "Waiting for your passkey…" : "Change with passkey"}
      </button>
    </form>
  );
}
