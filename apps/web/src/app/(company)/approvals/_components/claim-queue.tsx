"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, KeyboardEvent, ReactNode } from "react";
import { cn } from "cn";
import { CircleCheckIcon, LockIcon, TriangleAlertIcon } from "lucide-react";

import type { Claim } from "@expendi-business/shared";
import { CLAIM_APPROVAL_MAX_CLAIMS } from "@expendi-business/shared";

import type { QueueTab } from "./claim-detail";
import {
  personName,
  WARNING_LABELS,
  warningCodes,
} from "~/app/(company)/expenses/_components/expense-labels";
import { TextLinkButton } from "~/components/data/actions";
import { Money } from "~/components/data/money";
import { SelectionBar } from "~/components/data/selection-bar";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { EntityMark, RowCheckbox } from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { formatIsoDate } from "~/lib/dates";
import { sumUnits } from "~/lib/money";
import { blockedReason } from "./payment";

const MAX = CLAIM_APPROVAL_MAX_CLAIMS;

/** A small tinted flag under a reimbursement's name. */
function Flag({
  icon: Icon,
  warn = false,
  children,
}: {
  icon?: LucideIcon;
  warn?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={cn(
        "inline-flex h-[22px] flex-none items-center gap-1 rounded-full pr-2 text-xs font-(--w-ui) whitespace-nowrap",
        Icon ? "pl-1.5" : "pl-2",
        warn ? "bg-warn-50 text-warn-700" : "bg-gray-100 text-gray-700",
      )}
    >
      {Icon ? <Icon aria-hidden="true" className="size-[13px]" /> : null}
      {children}
    </span>
  );
}

function ClaimFlags({
  claim,
  tab,
}: {
  claim: Claim;
  tab: QueueTab;
}): JSX.Element | null {
  const codes = warningCodes(claim.warnings);
  const blocked = tab === "waiting" && blockedReason(claim) !== null;
  const noReceipt = claim.receiptCount === 0;
  if (tab === "waiting" && codes.length === 0 && !blocked && !noReceipt) {
    return null;
  }
  return (
    <span className="mt-1.5 flex flex-wrap gap-1">
      {tab === "failed" ? (
        <StatusBadge tone="failed">Payment failed</StatusBadge>
      ) : null}
      {codes.map((code) => (
        <Flag key={code} icon={TriangleAlertIcon} warn>
          {WARNING_LABELS[code]}
        </Flag>
      ))}
      {blocked ? <Flag icon={LockIcon}>Can&apos;t be paid yet</Flag> : null}
      {noReceipt ? <Flag>No receipt</Flag> : null}
    </span>
  );
}

export interface QueueState {
  readonly isPending: boolean;
  readonly isError: boolean;
  readonly hasNextPage: boolean;
  readonly isFetchingNextPage: boolean;
  readonly refetch: () => void;
  readonly fetchNextPage: () => void;
}

/**
 * The queue: one tab's reimbursements, newest first. An admin with a
 * passkey selects up to 20 for one Approve & pay; the active one shows in
 * the pane beside it (or a side sheet on a narrow screen).
 */
export function ClaimQueue({
  tab,
  claims,
  queue,
  total,
  activeId,
  onActivate,
  canPay,
  busy,
  selected,
  onSelectedChange,
  onApproveSelected,
  preparing,
}: {
  tab: QueueTab;
  claims: readonly Claim[];
  queue: QueueState;
  /** Every reimbursement in this tab, from `/claims/summary`. */
  total: { count: number; totalKes: string } | undefined;
  activeId: string | null;
  onActivate: (claimId: string) => void;
  canPay: boolean;
  busy: boolean;
  selected: readonly string[];
  onSelectedChange: (next: string[]) => void;
  onApproveSelected: () => void;
  /** The selection's Approve & pay is working out the cost. */
  preparing: boolean;
}): JSX.Element {
  if (queue.isPending) {
    return (
      <div aria-busy="true">
        <div className="flex min-h-[52px] items-center border-b border-hairline px-4 py-2.5">
          <Skel width="40%" height={14} />
        </div>
        {Array.from({ length: 5 }, (_, row) => (
          <div
            key={row}
            aria-hidden="true"
            className="grid grid-cols-[32px_minmax(0,1fr)_72px] gap-3 border-b border-hairline p-4"
          >
            <Skel width={32} height={32} className="rounded-full" />
            <div>
              <Skel width="70%" height={14} />
              <Skel width="50%" height={12} style={{ marginTop: 8 }} />
            </div>
            <Skel width="100%" height={14} />
          </div>
        ))}
      </div>
    );
  }
  if (queue.isError) {
    return (
      <ErrorState
        title="The reimbursements didn't load"
        onRetry={queue.refetch}
      >
        Check your connection, then try again.
      </ErrorState>
    );
  }
  if (claims.length === 0) {
    return (
      <EmptyState icon={CircleCheckIcon} title="Nothing to approve">
        New reimbursements show up here.
      </EmptyState>
    );
  }

  const selectable = canPay && tab === "waiting";
  const payable = claims.filter((claim) => blockedReason(claim) === null);
  const chosen = claims.filter((claim) => selected.includes(claim.id));
  const allChosen =
    chosen.length > 0 && chosen.length === Math.min(payable.length, MAX);
  const count = total?.count ?? claims.length;
  const totalKes =
    total?.totalKes ?? sumUnits(claims.map((claim) => claim.amountKes));

  function toggle(claimId: string) {
    if (selected.includes(claimId)) {
      onSelectedChange(selected.filter((id) => id !== claimId));
    } else if (selected.length < MAX) {
      onSelectedChange([...selected, claimId]);
    }
  }

  function onRowKeyDown(event: KeyboardEvent<HTMLButtonElement>, at: number) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const next = claims[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    const list = event.currentTarget.closest("ul");
    list
      ?.querySelector<HTMLButtonElement>(`[data-claim-id="${next.id}"]`)
      ?.focus();
    onActivate(next.id);
  }

  return (
    <>
      <div className="flex min-h-[52px] items-center gap-3 border-b border-hairline px-4 py-2.5">
        {selectable ? (
          <label className="inline-flex flex-1 cursor-pointer items-center gap-2.5 text-gray-600">
            <RowCheckbox
              aria-label={`Select every reimbursement that can be paid, up to ${String(MAX)}`}
              checked={allChosen}
              disabled={busy || payable.length === 0}
              onChange={() =>
                onSelectedChange(
                  allChosen
                    ? []
                    : payable.slice(0, MAX).map((claim) => claim.id),
                )
              }
            />
            <span>Select all</span>
          </label>
        ) : (
          <span className="flex-1 text-gray-600">
            {tab === "failed"
              ? "Paid but didn't arrive. Retry each one."
              : `${String(count)} ${count === 1 ? "reimbursement" : "reimbursements"} waiting`}
          </span>
        )}
        <span className="text-xs leading-4 whitespace-nowrap text-gray-500 tabular-nums">
          {count} · <Money amount={totalKes} currency="KES" />
        </span>
      </div>
      <ul
        aria-label={
          tab === "waiting" ? "Waiting for approval" : "Payment failed"
        }
        className="m-0 list-none p-0"
      >
        {claims.map((claim, at) => {
          const active = claim.id === activeId;
          const checked = selected.includes(claim.id);
          const blocked = blockedReason(claim);
          const person = personName(claim.submittedBy);
          return (
            <li
              key={claim.id}
              className={cn(
                "grid border-b border-row-divider transition-colors duration-150",
                selectable
                  ? "grid-cols-[40px_minmax(0,1fr)]"
                  : "grid-cols-[minmax(0,1fr)]",
                checked
                  ? "bg-brand-50"
                  : active
                    ? "bg-gray-50"
                    : "hover:bg-gray-25",
                active &&
                  (checked
                    ? "shadow-[inset_3px_0_0_var(--color-brand-700)]"
                    : "shadow-[inset_3px_0_0_var(--color-gray-900)]"),
              )}
            >
              {selectable && blocked !== null ? <span /> : null}
              {selectable && blocked === null ? (
                <label
                  className="flex cursor-pointer items-start justify-center pt-[22px] pl-2"
                  title={
                    !checked && selected.length >= MAX
                      ? `One passkey approves up to ${String(MAX)} reimbursements.`
                      : undefined
                  }
                >
                  <RowCheckbox
                    aria-label={`Select ${claim.merchant}, ${person}`}
                    checked={checked}
                    disabled={busy || (!checked && selected.length >= MAX)}
                    onChange={() => toggle(claim.id)}
                  />
                </label>
              ) : null}
              <button
                type="button"
                data-claim-id={claim.id}
                aria-current={active || undefined}
                onClick={() => onActivate(claim.id)}
                onKeyDown={(event) => onRowKeyDown(event, at)}
                className={cn(
                  "grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-0 bg-transparent py-3.5 pr-4 text-left focus-visible:-outline-offset-2",
                  selectable ? "pl-2" : "pl-4",
                )}
              >
                <EntityMark name={person} kind="person" />
                <span className="min-w-0">
                  <span className="block truncate text-base leading-6 font-(--w-name)">
                    {claim.merchant}
                  </span>
                  <span className="block truncate text-gray-500">
                    {person} · {formatIsoDate(claim.spentOn)}
                  </span>
                  <ClaimFlags claim={claim} tab={tab} />
                </span>
                <span className="text-base leading-6 font-(--w-amount) whitespace-nowrap">
                  <Money amount={claim.amountKes} currency="KES" />
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {queue.hasNextPage ? (
        <div className="border-b border-hairline px-4 py-3">
          <Button
            variant="outline"
            size="md"
            disabled={queue.isFetchingNextPage}
            onClick={queue.fetchNextPage}
          >
            {queue.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}
      {selectable ? (
        <SelectionBar
          summary={
            chosen.length === 0 ? (
              "Select reimbursements to approve and pay."
            ) : (
              <>
                <strong className="tabular-nums">
                  {chosen.length} selected
                </strong>
                {" · "}
                <Money
                  amount={sumUnits(chosen.map((claim) => claim.amountKes))}
                  currency="KES"
                />{" "}
                to pay back
              </>
            )
          }
          links={
            chosen.length > 0 ? (
              <>
                <TextLinkButton onClick={() => onSelectedChange([])}>
                  Clear selection
                </TextLinkButton>
                {chosen.length >= MAX ? (
                  <span className="text-gray-500">
                    {MAX} selected, the most one passkey approves. Pay these,
                    then select the rest.
                  </span>
                ) : null}
              </>
            ) : null
          }
          action={
            <Button
              disabled={chosen.length === 0 || busy}
              onClick={onApproveSelected}
            >
              {preparing
                ? "Working out the cost…"
                : chosen.length > 0
                  ? `Approve & pay ${String(chosen.length)}`
                  : "Approve & pay"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
