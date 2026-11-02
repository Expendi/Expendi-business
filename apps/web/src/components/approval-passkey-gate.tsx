"use client";

import type { JSX, ReactNode } from "react";

import { describeApiError } from "~/lib/api";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { alertClass, secondaryButton } from "./styles";

/**
 * Shows its children only to an admin with an approval passkey (spec
 * §7.3), which confirms every money action. Mount it only where the admin
 * can act.
 */
export function ApprovalPasskeyGate({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const status = useApprovalPasskeyStatus();

  if (status.isPending) {
    return (
      <p className="text-sm text-stone-500">Checking your approval passkey…</p>
    );
  }
  if (status.isError) {
    return (
      <div className={alertClass} role="alert">
        <p>{describeApiError(status.error)}</p>
        <button
          type="button"
          onClick={() => void status.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }
  if (!status.data.enrolled) {
    return (
      <div className="rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-700">
        <p className="font-medium text-stone-900">
          Set up your approval passkey first
        </p>
        <p className="mt-1">
          Paying needs your approval passkey. Set it up in the Expendi Business
          app; then confirm here with “use a phone or tablet” in your
          browser&apos;s passkey prompt.
        </p>
      </div>
    );
  }
  return <>{children}</>;
}
