"use client";

import type { JSX, ReactNode } from "react";
import { useState } from "react";

import type { PayeeChangeHold } from "@expendi-business/shared";

import type { PreviewRow } from "~/features/bills/bill-payment";
import { primaryButton, secondaryButton } from "~/components/styles";
import { holdWarning } from "~/features/bills/bill-payment";
import { formatKesCents } from "~/lib/money";

/**
 * Pieces the bills, recurring, payees and payroll pages share: status
 * badges, labelled rows, and the steps around a passkey payment.
 */

export type Tone = "neutral" | "success" | "warning" | "danger";

const TONES: Record<Tone, string> = {
  neutral: "bg-stone-100 text-stone-700",
  success: "bg-emerald-50 text-emerald-800",
  warning: "bg-amber-100 text-amber-900",
  danger: "bg-error-50 text-error-700",
};

export function StatusBadge({
  label,
  tone,
}: {
  label: string;
  tone: Tone;
}): JSX.Element {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}
    >
      {label}
    </span>
  );
}

/** Label and value side by side, e.g. a payment's cost. */
export function PreviewRows({
  rows,
}: {
  rows: readonly PreviewRow[];
}): JSX.Element {
  return (
    <dl className="space-y-1 text-sm">
      {rows.map((row) => (
        <div key={row.label} className="flex justify-between gap-3">
          <dt className="text-stone-600">{row.label}</dt>
          <dd className="text-right font-medium break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A small label above its value, as in a detail panel. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

/**
 * A payee's details changed in the last 24 hours (spec §6.19, §7.8): the
 * admin confirms they checked them before the payment is prepared again
 * with `secondConfirmation`.
 */
export function HoldWarning({
  hold,
  onConfirm,
  onCancel,
}: {
  hold: PayeeChangeHold;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const [checked, setChecked] = useState(false);
  const warning = holdWarning(hold);
  return (
    <section
      aria-label={warning.title}
      className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900"
    >
      <h2 className="text-base font-semibold">{warning.title}</h2>
      <p className="mt-1">{warning.body}</p>
      <label className="mt-3 flex items-start gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={(event) => setChecked(event.target.checked)}
          className="mt-0.5"
        />
        <span>{warning.confirmLabel}</span>
      </label>
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          disabled={!checked}
          onClick={onConfirm}
          className={primaryButton}
        >
          Continue
        </button>
        <button type="button" onClick={onCancel} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Shown instead of the passkey prompt while the wallet is short (spec §6.7 step 4). */
export function TopUpNotice({
  topUpKes,
  what,
}: {
  topUpKes: string;
  what: string;
}): JSX.Element {
  return (
    <p className="mt-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <span className="font-semibold">
        Top up KES {formatKesCents(topUpKes)}
      </span>{" "}
      The wallet doesn’t hold enough USDC for {what}. Add funds, then review it
      again.
    </p>
  );
}

export const PASSKEY_HINT =
  "Your browser asks for your approval passkey. To use the one on your phone, choose “use a phone or tablet”.";
