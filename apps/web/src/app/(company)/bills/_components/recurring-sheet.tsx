"use client";

import type { JSX } from "react";
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
} from "lucide-react";

import type { RecurringItem } from "@expendi-business/shared";

import type { RecurringItemAction } from "~/features/recurring/recurring-api";
import { TextLinkButton } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { EntityMark } from "~/components/data/table";
import { Button } from "~/components/ui/button";
import { FieldError } from "~/components/ui/field";
import { storedAmount } from "~/features/bills/bill-amount";
import { BillStatusBadge, headingLabel } from "~/features/bills/bill-status";
import { useRecurringItemAction } from "~/features/recurring/recurring-api";
import {
  nextDueDate,
  reminderInWords,
  scheduleInWords,
  STATE_LABELS,
} from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { formatKes, formatUsdc } from "~/lib/money";
import { Note } from "./note";
import { PAY_VIA_LABELS } from "./recurring-form";
import { SheetFooterPortal } from "./sheet-footer";

export const RECURRING_VIEW_ONLY =
  "View only. Only admins set up and change recurring payments.";

/** "KES 48,500", "USD 45.00" or "Variable". */
export function recurringAmountText(item: RecurringItem): string {
  const stored = storedAmount(item);
  if (stored === null) return "Variable";
  return item.currency === "usd"
    ? `USD ${formatUsdc(stored)}`
    : `KES ${formatKes(stored)}`;
}

function StateBadge({
  item,
  className,
}: {
  item: RecurringItem;
  className?: string;
}): JSX.Element {
  const state = STATE_LABELS[item.state];
  return (
    <StatusBadge tone={state.tone} className={className}>
      {state.label}
    </StatusBadge>
  );
}

function ListSkeleton(): JSX.Element {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        Loading recurring payments…
      </p>
      <ul aria-hidden="true" className="m-0 list-none p-0">
        {[0, 1, 2, 3, 4, 5].map((row) => (
          <li
            key={row}
            className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-3 border-b border-row-divider px-6 py-3.5 max-[600px]:px-4"
          >
            <Skel width={32} height={32} />
            <div>
              <Skel width="55%" height={14} style={{ marginTop: 5 }} />
              <Skel width="80%" height={12} style={{ marginTop: 9 }} />
            </div>
            <div className="flex flex-col items-end gap-1">
              <Skel width={84} height={14} style={{ marginTop: 5 }} />
              <Skel width={64} height={20} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Every recurring payment but salaries: active first, then paused, then
 * ended, the soonest due first. Each row opens its details.
 */
export function RecurringList({
  items,
  error,
  canAct,
  onOpen,
  onNew,
  onRetry,
}: {
  /** Undefined while they load. */
  items: readonly RecurringItem[] | undefined;
  error: unknown;
  canAct: boolean;
  onOpen: (itemId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}): JSX.Element {
  if (error) {
    return (
      <ErrorState title="Recurring payments didn't load" onRetry={onRetry} />
    );
  }
  if (items === undefined) return <ListSkeleton />;
  if (items.length === 0) {
    return (
      <EmptyState
        icon={RepeatIcon}
        title="No recurring payments yet."
        action={
          canAct ? (
            <Button variant="outline" size="md" onClick={onNew}>
              <PlusIcon aria-hidden="true" />
              New recurring payment
            </Button>
          ) : null
        }
      >
        Set up rent, subscriptions or a monthly KRA payment once, and its next
        bill is always ready in Bills.
      </EmptyState>
    );
  }
  return (
    <ul aria-label="Recurring payments" className="m-0 list-none p-0">
      {items.map((item) => {
        const due = nextDueDate(item);
        return (
          <li key={item.id} className="border-b border-row-divider">
            <button
              type="button"
              data-item={item.id}
              onClick={() => onOpen(item.id)}
              className="grid w-full grid-cols-[32px_minmax(0,1fr)_auto] items-start gap-3 border-0 bg-transparent px-6 py-3.5 text-left transition-colors duration-150 hover:bg-gray-25 focus-visible:-outline-offset-2 max-[600px]:px-4"
            >
              <EntityMark name={item.payee.name} />
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-base leading-6 font-(--w-name) text-gray-900">
                  <span>{item.payee.name}</span>
                  {item.state === "active" ? null : <StateBadge item={item} />}
                </span>
                <span className="block text-gray-500 tabular-nums">
                  {scheduleInWords(item)} · {recurringAmountText(item)}
                </span>
              </span>
              <span className="flex flex-col items-end gap-1 whitespace-nowrap text-gray-600">
                {due ? (
                  <>
                    <span className="tabular-nums">{formatIsoDate(due)}</span>
                    {item.nextBill ? (
                      <BillStatusBadge status={item.nextBill.status} />
                    ) : null}
                  </>
                ) : (
                  <span className="text-gray-500">No more bills</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

export function RecurringListFooter({
  canAct,
  canAdd,
  onNew,
  onClose,
}: {
  canAct: boolean;
  /** The list has loaded with at least one payment. */
  canAdd: boolean;
  onNew: () => void;
  onClose: () => void;
}): JSX.Element {
  return (
    <>
      {canAct && canAdd ? (
        <Button onClick={onNew}>
          <PlusIcon aria-hidden="true" />
          New recurring payment
        </Button>
      ) : null}
      <Button variant="outline" onClick={onClose}>
        Close
      </Button>
      {canAct ? null : <ReadOnlyNote>{RECURRING_VIEW_ONLY}</ReadOnlyNote>}
    </>
  );
}

/** The detail's eyebrow: back to the list. */
export function BackToRecurring({
  onBack,
}: {
  onBack: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onBack}
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-[4px] border-0 bg-transparent p-0 text-xs leading-4 font-(--w-ui) text-gray-600 hover:text-gray-900"
    >
      <ChevronLeftIcon aria-hidden="true" className="size-3.5" />
      Back to recurring payments
    </button>
  );
}

/** Under the title: the amount, then the state. */
export function RecurringSheetHeader({
  item,
}: {
  item: RecurringItem;
}): JSX.Element {
  const stored = storedAmount(item);
  return (
    <>
      <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
        {stored === null ? (
          <span className="text-base text-gray-500">Variable amount</span>
        ) : (
          <Money
            amount={stored}
            currency={item.currency === "usd" ? "USD" : "KES"}
          />
        )}
      </p>
      <StateBadge item={item} className="mt-2" />
    </>
  );
}

function NextBill({
  item,
  onOpenBill,
}: {
  item: RecurringItem;
  onOpenBill: (billId: string) => void;
}): JSX.Element | null {
  const bill = item.nextBill;
  if (bill === null) {
    if (item.state !== "ended") return null;
    return (
      <section aria-label="Next bill" className="flex flex-col gap-2">
        <SectionLabel>Next bill</SectionLabel>
        <p className="rounded-control border border-dashed border-control-border px-4 py-3.5 text-gray-600">
          No more bills
        </p>
      </section>
    );
  }
  const currency = bill.currency ?? item.currency;
  const stored = currency === "usd" ? bill.amountUsdc : bill.amountKes;
  return (
    <section aria-label="Next bill" className="flex flex-col gap-2">
      <SectionLabel>Next bill</SectionLabel>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-control border border-gray-200 px-4 py-3.5">
        <span className="text-base leading-6 font-(--w-name) tabular-nums">
          Due {formatIsoDate(bill.dueOn)}
        </span>
        <span className="text-right text-base leading-6 font-(--w-amount) whitespace-nowrap">
          {stored === null ? (
            <span className="text-warn-700">Amount to enter</span>
          ) : (
            <Money
              amount={stored}
              currency={currency === "usd" ? "USD" : "KES"}
            />
          )}
        </span>
        <BillStatusBadge status={bill.status} className="justify-self-start" />
        <TextLinkButton
          onClick={() => onOpenBill(bill.id)}
          className="inline-flex items-center gap-0.5 justify-self-end whitespace-nowrap"
        >
          Open bill
          <ChevronRightIcon aria-hidden="true" className="size-3.5" />
        </TextLinkButton>
      </div>
      {item.payVia === "expendi" ? (
        <Note>
          Bills aren’t paid automatically on the due date. An admin pays each
          one in Bills, with their approval passkey.
        </Note>
      ) : null}
    </section>
  );
}

/** One recurring payment: its bill still owed, then its schedule and settings. */
export function RecurringDetailBody({
  item,
  onOpenBill,
}: {
  item: RecurringItem;
  onOpenBill: (billId: string) => void;
}): JSX.Element {
  return (
    <>
      <NextBill item={item} onOpenBill={onOpenBill} />
      <DetailList>
        <DetailItem label="When">{scheduleInWords(item)}</DetailItem>
        <DetailItem label="Starts">{formatIsoDate(item.startsOn)}</DetailItem>
        <DetailItem label="Ends">
          {item.endsOn ? formatIsoDate(item.endsOn) : "No end date"}
        </DetailItem>
        {item.nextDueOn ? (
          <DetailItem
            label={item.nextBill ? "The bill after that" : "Next bill"}
          >
            Due {formatIsoDate(item.nextDueOn)}
          </DetailItem>
        ) : null}
        <DetailItem label="How it’s paid">
          {item.payVia === "outside"
            ? "Outside Expendi. Mark each bill paid once you’ve paid it."
            : PAY_VIA_LABELS.expendi}
        </DetailItem>
        <DetailItem label="Reminder">
          {reminderInWords(item.reminderDays)}
        </DetailItem>
        <DetailItem label="Overview heading">
          {headingLabel(item.overviewHeading)}
        </DetailItem>
        <DetailItem label="Category">{item.category.name}</DetailItem>
      </DetailList>
    </>
  );
}

export type RecurringConfirmKind = Exclude<RecurringItemAction, "resume">;

/**
 * An admin's actions on a payment that hasn't ended: resume a paused one,
 * edit it, pause or end it. Accountants see why there are none.
 */
export function RecurringDetailFooter({
  organizationId,
  item,
  canAct,
  index,
  total,
  onEdit,
  onConfirm,
}: {
  organizationId: string;
  item: RecurringItem;
  canAct: boolean;
  index: number;
  total: number;
  onEdit: () => void;
  onConfirm: (kind: RecurringConfirmKind) => void;
}): JSX.Element {
  const resume = useRecurringItemAction(organizationId, item.id);
  const position = <SheetPosition index={index} total={total} />;
  if (!canAct) {
    return (
      <>
        <ReadOnlyNote>{RECURRING_VIEW_ONLY}</ReadOnlyNote>
        {position}
      </>
    );
  }
  if (item.state === "ended") return position;
  return (
    <>
      <SheetActions kind="primary">
        {item.state === "paused" ? (
          <Button
            disabled={resume.isPending}
            onClick={() => resume.mutate("resume")}
          >
            {resume.isPending ? (
              "Resuming…"
            ) : (
              <>
                <PlayIcon aria-hidden="true" />
                Resume
              </>
            )}
          </Button>
        ) : null}
        <Button variant="outline" onClick={onEdit}>
          <PencilIcon aria-hidden="true" />
          Edit payment
        </Button>
      </SheetActions>
      <SheetActions kind="secondary">
        {item.state === "active" ? (
          <Button variant="ghost" size="md" onClick={() => onConfirm("pause")}>
            Pause
          </Button>
        ) : null}
        <Button variant="danger" size="md" onClick={() => onConfirm("end")}>
          End payment
        </Button>
      </SheetActions>
      {resume.isError ? (
        <FieldError className="basis-full">
          {describeApiError(resume.error)}
        </FieldError>
      ) : null}
    </>
  );
}

export const CONFIRMATIONS: Readonly<
  Record<
    RecurringConfirmKind,
    {
      title: string;
      message: (payee: string) => string;
      confirm: string;
      icon: typeof PauseIcon;
    }
  >
> = {
  pause: {
    title: "Pause this payment?",
    message: (payee) =>
      `No new bills for ${payee} until you resume it. The bill already there stays.`,
    confirm: "Pause",
    icon: PauseIcon,
  },
  end: {
    title: "End this payment?",
    message: (payee) =>
      `No more bills for ${payee}. The bill already there stays. Ending is final: it can’t be undone.`,
    confirm: "End payment",
    icon: BanIcon,
  },
};

/** Pausing keeps the bill already there; ending is final. */
export function RecurringConfirm({
  organizationId,
  item,
  kind,
  footerSlot,
  onDone,
  onKeep,
}: {
  organizationId: string;
  item: RecurringItem;
  kind: RecurringConfirmKind;
  footerSlot: HTMLElement | null;
  onDone: () => void;
  onKeep: () => void;
}): JSX.Element {
  const action = useRecurringItemAction(organizationId, item.id);
  const confirmation = CONFIRMATIONS[kind];
  return (
    <>
      <Callout tone="warn" icon={confirmation.icon}>
        <p>{confirmation.message(item.payee.name)}</p>
      </Callout>
      {action.isError ? (
        <FieldError>{describeApiError(action.error)}</FieldError>
      ) : null}
      <SheetFooterPortal slot={footerSlot}>
        <Button
          disabled={action.isPending}
          onClick={() => action.mutate(kind, { onSuccess: onDone })}
        >
          {action.isPending ? "Working…" : confirmation.confirm}
        </Button>
        <Button variant="outline" disabled={action.isPending} onClick={onKeep}>
          Keep it
        </Button>
      </SheetFooterPortal>
    </>
  );
}
