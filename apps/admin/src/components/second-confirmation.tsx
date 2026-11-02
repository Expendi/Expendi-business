import type { ReactNode } from "react";

import { formatNairobiTime } from "~/lib/format";
import { dangerButton, secondaryButton } from "./styles";

/**
 * The second step of an action that needs one (spec §6.15): what will
 * happen, in the API's words, before the staff member confirms.
 */
export function SecondConfirmation({
  title,
  consequences,
  reason,
  expiresAt,
  confirmLabel,
  pending,
  error,
  onConfirm,
  onBack,
  children,
}: {
  title: string;
  consequences: readonly string[];
  reason: string;
  expiresAt: string;
  confirmLabel: string;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
  children?: ReactNode;
}) {
  return (
    <div
      role="region"
      aria-label={title}
      className="rounded-lg border border-amber-300 bg-amber-50 p-4"
    >
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
      <p className="mt-3 text-sm font-medium">Confirming will:</p>
      <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
        {consequences.map((consequence) => (
          <li key={consequence}>{consequence}</li>
        ))}
      </ul>
      <p className="mt-3 text-sm">
        <span className="font-medium">Your reason:</span> {reason}
      </p>
      <p className="mt-1 text-xs text-stone-600">
        This confirmation expires at {formatNairobiTime(expiresAt)}.
      </p>
      {error ? (
        <p role="alert" className="mt-3 text-sm text-error-700">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={dangerButton}
        >
          {pending ? "Confirming…" : confirmLabel}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className={secondaryButton}
        >
          Back
        </button>
      </div>
    </div>
  );
}
