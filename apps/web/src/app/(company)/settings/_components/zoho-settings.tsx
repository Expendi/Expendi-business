"use client";

import type { JSX } from "react";
import { InfoIcon } from "lucide-react";

import type {
  AccountingSyncSubjectType,
  CompanyZohoResponse,
  CompanyZohoStatus,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { Callout } from "~/components/data/detail-sheet";
import { StatusBadge } from "~/components/data/status-badge";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useZohoStatus } from "./settings-api";
import {
  KeyValue,
  KeyValues,
  PanelEmpty,
  PanelError,
  PanelFoot,
  PanelSkeleton,
  SettingsList,
  SettingsPanel,
  SettingsRow,
  Tag,
} from "./settings-panel";

export const ZOHO_STATUS: Record<
  CompanyZohoStatus,
  { readonly label: string; readonly tone: StatusTone }
> = {
  not_connected: { label: "Not connected", tone: "quiet" },
  pending: { label: "Connecting", tone: "waiting" },
  active: { label: "Connected", tone: "paid" },
  needs_reconnect: { label: "Needs reconnecting", tone: "failed" },
};

const SUBJECT_LABELS: Record<AccountingSyncSubjectType, string> = {
  expense: "Expense",
  bill: "Bill",
  payroll_run: "Payroll run",
};

const plural = (count: number, one: string, many: string) =>
  `${String(count)} ${count === 1 ? one : many}`;

/** e.g. "212 synced, 3 waiting, 2 didn't sync". */
export function describeSyncCounts(
  counts: CompanyZohoResponse["counts"],
): string {
  return [
    `${String(counts.synced)} synced`,
    `${String(counts.pending)} waiting`,
    `${String(counts.failed)} didn't sync`,
  ].join(", ");
}

/**
 * Zoho Books (spec §6.17), read-only: Expendi staff connect it and map the
 * accounts with the accountant, so there's nothing to change here. It shows
 * the connection, the counts and why recent items didn't reach Zoho.
 */
export function ZohoSettings({
  organizationId,
}: {
  organizationId: string;
}): JSX.Element {
  const zoho = useZohoStatus(organizationId);
  return (
    <SettingsPanel
      id="zoho"
      title="Zoho Books"
      sub="Paid spending goes straight into the company's Zoho Books, one way."
      busy={zoho.isPending}
    >
      {zoho.isPending ? (
        <PanelSkeleton lines={3} />
      ) : zoho.isError ? (
        <PanelError
          title="Zoho Books status didn't load"
          message={describeApiError(zoho.error)}
          onRetry={() => void zoho.refetch()}
        />
      ) : zoho.data.status === "not_connected" ? (
        <PanelEmpty>
          Not connected yet. Expendi connects Zoho Books with your accountant
          during setup.
        </PanelEmpty>
      ) : (
        <ZohoConnection zoho={zoho.data} />
      )}
    </SettingsPanel>
  );
}

function ZohoConnection({ zoho }: { zoho: CompanyZohoResponse }): JSX.Element {
  const status = ZOHO_STATUS[zoho.status];
  return (
    <>
      {zoho.status === "needs_reconnect" ? (
        <div role="status" className="px-5 pb-4">
          <Callout tone="warn" title="Syncing is paused">
            <p>
              Zoho Books stopped accepting Expendi&apos;s access. Spending paid
              in the meantime syncs after reconnecting. Ask Expendi for a new
              connect link.
            </p>
          </Callout>
        </div>
      ) : null}
      <KeyValues>
        <KeyValue label="Status">
          <StatusBadge tone={status.tone} className="-my-0.5">
            {status.label}
          </StatusBadge>
        </KeyValue>
        <KeyValue label="Zoho organization">
          {zoho.organizationName ?? (
            <span className="text-gray-500">Not chosen yet</span>
          )}
        </KeyValue>
        <KeyValue label="Connected">
          {zoho.connectedAt ? (
            formatNairobiDateTime(zoho.connectedAt)
          ) : (
            <span className="text-gray-500">Not yet</span>
          )}
        </KeyValue>
        <KeyValue label="Last synced">
          {zoho.lastSyncedAt ? (
            formatNairobiDateTime(zoho.lastSyncedAt)
          ) : (
            <span className="text-gray-500">Nothing synced yet</span>
          )}
        </KeyValue>
        <KeyValue label="Paid items">
          {describeSyncCounts(zoho.counts)}
        </KeyValue>
        <KeyValue label="What goes to Zoho">
          Each paid reimbursement, bill and piece of petty cash or company
          spending as its own expense, with its receipt. Each payroll run as one
          expense.
        </KeyValue>
      </KeyValues>
      {zoho.failed.length > 0 ? (
        <div className="border-t border-gray-200">
          <p className="m-0 px-5 pt-4 pb-2 text-xs leading-4 font-(--w-ui) text-gray-500">
            {zoho.counts.failed > zoho.failed.length
              ? `Didn't reach Zoho: the latest ${String(zoho.failed.length)} of ${String(zoho.counts.failed)}`
              : `Didn't reach Zoho (${plural(zoho.failed.length, "item", "items")})`}
          </p>
          <SettingsList label="Items that didn't reach Zoho Books">
            {zoho.failed.map((item) => (
              <SettingsRow key={item.id}>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 truncate font-(--w-name)">
                      {item.label ??
                        `A ${SUBJECT_LABELS[item.subjectType].toLowerCase()}`}
                    </span>
                    <Tag>{SUBJECT_LABELS[item.subjectType]}</Tag>
                  </span>
                  <span className="mt-0.5 block text-gray-600">
                    {item.reason ?? "Zoho Books didn't say why."}
                  </span>
                </span>
                <span className="flex-none self-start pt-0.5 text-xs leading-4 whitespace-nowrap text-gray-500 tabular-nums">
                  {formatNairobiDateTime(item.failedAt)}
                </span>
              </SettingsRow>
            ))}
          </SettingsList>
        </div>
      ) : null}
      <PanelFoot icon={InfoIcon}>
        Expendi set this up with your accountant, including which Zoho account
        each category and paid-from account posts to. To change it, contact
        Expendi.
      </PanelFoot>
    </>
  );
}
