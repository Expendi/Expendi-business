"use client";

import type { JSX } from "react";

import {
  alertClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { isRecentLoginRequired, useEnrolApprovalPasskey } from "./settings-api";

const SIGN_IN_AGAIN =
  "Sign in again, then set up your approval passkey within 10 minutes.";

/**
 * The admin's approval passkey (spec §7.3, §6.14): the one passkey that
 * confirms every money action, in the app and here. An admin who has none
 * sets it up in the browser under the app's rules; replacing one goes
 * through Expendi.
 */
export function ApprovalPasskeySettings(): JSX.Element {
  const status = useApprovalPasskeyStatus();
  const enrol = useEnrolApprovalPasskey();
  const { endSession } = useAuth();

  return (
    <section aria-labelledby="passkey-heading" className="space-y-3">
      <h2 id="passkey-heading" className="text-base font-semibold">
        Your approval passkey
      </h2>
      <div className="max-w-3xl rounded-lg border border-stone-200 bg-white p-4 text-sm text-stone-700">
        {status.isPending ? (
          <p className="text-stone-500">Checking your approval passkey…</p>
        ) : status.isError ? (
          <div role="alert">
            <p className="text-error-700">{describeApiError(status.error)}</p>
            <button
              type="button"
              onClick={() => void status.refetch()}
              className={`mt-2 ${secondaryButton}`}
            >
              Try again
            </button>
          </div>
        ) : status.data.enrolled ? (
          <>
            <p className="font-medium text-stone-900">Set up</p>
            <p className="mt-1">
              {status.data.enrolledAt
                ? `Since ${formatNairobiDateTime(status.data.enrolledAt)}. `
                : ""}
              It confirms payments, withdrawals and allowlist changes, in the
              app and here. To use the one on your phone from this computer,
              choose &ldquo;use a phone or tablet&rdquo; when your browser asks.
              To replace it, contact Expendi.
            </p>
          </>
        ) : (
          <>
            <p className="font-medium text-stone-900">Not set up yet</p>
            <p className="mt-1">
              Paying, withdrawing and changing allowed addresses need your
              approval passkey. You get one, used in the app and here. Create it
              on a device you&apos;ll keep with you: in your browser&apos;s
              prompt, choose &ldquo;use a phone or tablet&rdquo; to keep it on
              your phone. You need to have signed in within the last 10 minutes,
              and every admin is emailed when it&apos;s set up.
            </p>
            {enrol.data === "cancelled" ? (
              <p className="mt-3 text-stone-600">
                Cancelled. No passkey was set up.
              </p>
            ) : null}
            {enrol.isError ? (
              <div className={alertClass} role="alert">
                <p>
                  {isRecentLoginRequired(enrol.error)
                    ? SIGN_IN_AGAIN
                    : describeApprovalError(enrol.error)}
                </p>
                {isRecentLoginRequired(enrol.error) ? (
                  <button
                    type="button"
                    onClick={() => void endSession(SIGN_IN_AGAIN)}
                    className={`mt-2 ${secondaryButton}`}
                  >
                    Sign in again
                  </button>
                ) : null}
              </div>
            ) : null}
            <button
              type="button"
              disabled={enrol.isPending}
              onClick={() => enrol.mutate()}
              className={`mt-4 ${primaryButton}`}
            >
              {enrol.isPending
                ? "Waiting for your browser…"
                : "Set up approval passkey"}
            </button>
          </>
        )}
      </div>
    </section>
  );
}
