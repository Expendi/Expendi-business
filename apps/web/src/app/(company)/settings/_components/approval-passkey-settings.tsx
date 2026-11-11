"use client";

import type { JSX } from "react";
import { InfoIcon, KeyRoundIcon } from "lucide-react";

import { Callout } from "~/components/data/detail-sheet";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { isRecentLoginRequired, useEnrolApprovalPasskey } from "./settings-api";
import {
  KeyValue,
  KeyValues,
  PanelError,
  PanelFoot,
  PanelSkeleton,
  SettingsPanel,
} from "./settings-panel";

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

  const setUp =
    status.isSuccess && !status.data.enrolled ? (
      <Button
        size="md"
        disabled={enrol.isPending}
        onClick={() => enrol.mutate()}
      >
        {enrol.isPending ? null : <KeyRoundIcon aria-hidden="true" />}
        {enrol.isPending
          ? "Waiting for your browser…"
          : "Set up approval passkey"}
      </Button>
    ) : null;

  return (
    <SettingsPanel
      id="passkey"
      title="Your approval passkey"
      actions={setUp}
      busy={status.isPending}
    >
      {status.isPending ? (
        <PanelSkeleton lines={3} />
      ) : status.isError ? (
        <PanelError
          title="Couldn't check your approval passkey"
          message={describeApiError(status.error)}
          onRetry={() => void status.refetch()}
        />
      ) : status.data.enrolled ? (
        <>
          <KeyValues>
            <KeyValue label="Status">
              <StatusBadge tone="paid" className="-my-0.5">
                Set up
              </StatusBadge>
            </KeyValue>
            {status.data.enrolledAt ? (
              <KeyValue label="Since">
                {formatNairobiDateTime(status.data.enrolledAt)}
              </KeyValue>
            ) : null}
            <KeyValue label="What it confirms">
              Payments, withdrawals and allowlist changes, in the app and here.
            </KeyValue>
            <KeyValue label="From this computer">
              To use the one on your phone, choose &ldquo;use a phone or
              tablet&rdquo; when your browser asks.
            </KeyValue>
          </KeyValues>
          <PanelFoot icon={InfoIcon}>To replace it, contact Expendi.</PanelFoot>
        </>
      ) : (
        <>
          {enrol.data === "cancelled" ? (
            <p
              role="status"
              className="m-0 flex items-start gap-2 px-5 pb-4 text-muted-foreground"
            >
              <InfoIcon
                aria-hidden="true"
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
              />
              Cancelled. No passkey was set up.
            </p>
          ) : null}
          {enrol.isError ? (
            <div role="alert" className="px-5 pb-4">
              {isRecentLoginRequired(enrol.error) ? (
                <Callout
                  tone="warn"
                  action={
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => void endSession(SIGN_IN_AGAIN)}
                    >
                      Sign in again
                    </Button>
                  }
                >
                  <p>{SIGN_IN_AGAIN}</p>
                </Callout>
              ) : (
                <Callout tone="error">
                  <p>{describeApprovalError(enrol.error)}</p>
                </Callout>
              )}
            </div>
          ) : null}
          <KeyValues>
            <KeyValue label="Status">
              <StatusBadge tone="waiting" className="-my-0.5">
                Not set up yet
              </StatusBadge>
            </KeyValue>
            <KeyValue label="What it's for">
              Paying, withdrawing and changing allowed addresses need your
              approval passkey. You get one, used in the app and here.
            </KeyValue>
            <KeyValue label="Where to keep it">
              Create it on a device you&apos;ll keep with you: in your
              browser&apos;s prompt, choose &ldquo;use a phone or tablet&rdquo;
              to keep it on your phone.
            </KeyValue>
            <KeyValue label="Before you start">
              You need to have signed in within the last 10 minutes, and every
              admin is emailed when it&apos;s set up.
            </KeyValue>
          </KeyValues>
        </>
      )}
    </SettingsPanel>
  );
}
