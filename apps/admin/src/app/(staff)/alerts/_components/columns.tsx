import Link from "next/link";

import type { OpsAlert, OpsAlertKind } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";
import { linkClass } from "~/components/styles";
import { formatNairobiTime } from "~/lib/format";

export const KIND_LABELS: Record<OpsAlertKind, string> = {
  payout_needs_review: "Payout needs review",
  payout_failed: "Payout failed",
  webhook_signature_failure: "Webhook signature failure",
  reconciliation_stopped: "Reconciliation stopped",
  low_company_balance: "Low company balance",
  zoho_sync_failing: "Zoho sync failing",
  card_close_failed: "Card close failed",
  unexpected_transit_transfer: "Unexplained transfer to a transit wallet",
  deposits_held: "Deposits held",
};

/** Where staff look into an alert's cause. */
export function causeLink(
  alert: OpsAlert,
): { href: string; label: string } | null {
  switch (alert.kind) {
    case "payout_needs_review":
    case "payout_failed":
      return { href: `/payouts/${alert.subjectKey}`, label: "Open the payout" };
    case "low_company_balance":
    case "card_close_failed":
    case "unexpected_transit_transfer":
    case "deposits_held":
      return alert.organization
        ? {
            href: `/companies/${alert.organization.id}`,
            label: "Open the company",
          }
        : null;
    case "zoho_sync_failing":
      return alert.organization
        ? {
            href: `/companies/${alert.organization.id}/zoho`,
            label: "Open Zoho Books",
          }
        : null;
    case "webhook_signature_failure":
    case "reconciliation_stopped":
      return { href: "/health", label: "Open system health" };
  }
}

function EmailStatus({ email }: { email: OpsAlert["email"] }) {
  switch (email.status) {
    case "sent":
      return (
        <span className="text-xs">
          Sent{email.sentAt ? ` ${formatNairobiTime(email.sentAt)}` : ""}
        </span>
      );
    case "pending":
      return (
        <span className="text-xs text-muted-foreground">Not sent yet</span>
      );
    case "retrying":
      return (
        <span className="text-xs text-error-700">
          Failed {email.attempts} {email.attempts === 1 ? "time" : "times"}
          {email.lastError ? `: ${email.lastError}` : ""}
          {email.nextAttemptAt ? (
            <span className="block text-muted-foreground">
              Next try {formatNairobiTime(email.nextAttemptAt)}
            </span>
          ) : null}
        </span>
      );
    case "not_sent":
      return (
        <span className="text-xs text-muted-foreground">
          Not sent: resolved first
        </span>
      );
  }
}

export const alertColumns: DataTableColumnDef<OpsAlert>[] = [
  plainColumn<OpsAlert>({
    id: "alert",
    title: "Alert",
    value: (alert) => alert.title,
    cell: (alert) => {
      const cause = causeLink(alert);
      return (
        <>
          <span className="block text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {KIND_LABELS[alert.kind]}
          </span>
          <span className="block font-medium">{alert.title}</span>
          {alert.details.length > 0 ? (
            <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
              {alert.details.map((detail, index) => (
                <div key={`${detail.label}-${index}`}>
                  <dt className="inline font-medium">{detail.label}: </dt>
                  <dd className="inline break-words">{detail.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {cause ? (
            <Link
              href={cause.href}
              className={`${linkClass} mt-1 inline-block`}
            >
              {cause.label}
            </Link>
          ) : null}
        </>
      );
    },
    meta: { kind: "main", className: "min-w-64 max-w-md whitespace-normal" },
  }),
  plainColumn<OpsAlert>({
    id: "company",
    title: "Company",
    value: (alert) => alert.organization?.name ?? "All companies",
    cell: (alert) =>
      alert.organization ? (
        <Link
          href={`/companies/${alert.organization.id}`}
          className="underline-offset-4 hover:underline"
        >
          {alert.organization.name}
        </Link>
      ) : (
        <span className="text-muted-foreground">All companies</span>
      ),
    meta: { className: "min-w-40 max-w-64 whitespace-normal" },
  }),
  plainColumn<OpsAlert>({
    id: "when",
    title: "When",
    value: (alert) => alert.openedAt,
    cell: (alert) => (
      <>
        <span className="block">
          Opened {formatNairobiTime(alert.openedAt)}
        </span>
        {alert.occurrences > 1 ? (
          <span className="block text-xs text-muted-foreground">
            Seen {alert.occurrences} times, last{" "}
            {formatNairobiTime(alert.lastSeenAt)}
          </span>
        ) : null}
        {alert.resolvedAt ? (
          <span className="block text-xs text-muted-foreground">
            Resolved {formatNairobiTime(alert.resolvedAt)}
          </span>
        ) : null}
      </>
    ),
    meta: { className: "whitespace-nowrap" },
  }),
  plainColumn<OpsAlert>({
    id: "email",
    title: "Email",
    value: (alert) => alert.email.status,
    cell: (alert) => <EmailStatus email={alert.email} />,
    meta: { className: "min-w-40 max-w-xs whitespace-normal" },
  }),
];
