"use client";

import type { JSX } from "react";
import {
  BanIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CreditCardIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  RepeatIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";

import type { RecurringItem } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import type { RecurringItemAction } from "~/features/recurring/recurring-api";
import { RevealCardNumber } from "~/app/(company)/cards/_components/reveal-card-number";
import { TextLinkButton, textLinkClass } from "~/components/data/actions";
import { EntityMark, RowMeta, RowTitle } from "~/components/data/cells";
import { DataTable, useDataTable } from "~/components/data/data-table";
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
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { FieldError } from "~/components/ui/field";
import { storedAmount } from "~/features/bills/bill-amount";
import {
  BillStatusBadge,
  CardDeclinedBadge,
  headingLabel,
  lastFourOf,
} from "~/features/bills/bill-status";
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

/** "KES 48,500", "USD 45.00" or "Variable"; a card-paid payment's "No estimate". */
export function recurringAmountText(item: RecurringItem): string {
  const stored = storedAmount(item);
  if (stored === null)
    return item.payVia === "card" ? "No estimate" : "Variable";
  return item.currency === "usd"
    ? `USD ${formatUsdc(stored)}`
    : `KES ${formatKes(stored)}`;
}

/**
 * Under a card-paid payment's next bill: whether its card will pay it. A
 * paused payment's Card purchases are declined, as are those of one ended
 * while paused, and a frozen or closed card declines them all. The API's
 * purchase check still lets the card pay the last bill a payment ended
 * while active left owed.
 */
export function cardNextBillNote(item: RecurringItem): string | null {
  if (item.payVia !== "card") return null;
  const payee = item.payee.name;
  if (!item.active) {
    const state = item.state === "ended" ? "Ended" : "Paused";
    return `${state}: Card purchases from ${payee} are declined. The bill stays owed.`;
  }
  const card = item.card;
  if (card?.state === "frozen") {
    return `Card ${lastFourOf(card)} is frozen: Card purchases from ${payee} are declined until it’s unfrozen. The bill stays owed.`;
  }
  if (card?.state === "closed") {
    return `Card ${lastFourOf(card)} is closed: Card purchases from ${payee} are declined. The bill stays owed.`;
  }
  if (item.state === "ended") {
    return `Ended: the card pays this last bill when ${payee} charges it, and nothing after it.`;
  }
  return `Paid automatically when ${payee} charges the card. Nobody has to pay each bill.`;
}

/** A row's meta line: when, how much, and for a card-paid one, "Card •••• 1234". */
export function recurringMetaText(item: RecurringItem): string {
  const parts = [scheduleInWords(item), recurringAmountText(item)];
  if (item.payVia === "card" && item.card) {
    parts.push(`Card ${lastFourOf(item.card)}`);
  }
  return parts.join(" · ");
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
  if (items?.length === 0) {
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
  return <RecurringTable items={items} onOpen={onOpen} />;
}

function recurringColumns(
  onOpen: (itemId: string) => void,
): DataTableColumnDef<RecurringItem>[] {
  return [
    {
      id: "payment",
      accessorFn: (item) => item.payee.name,
      header: "Payment",
      cell: ({ row }) => {
        const item = row.original;
        return (
          <span className="flex min-w-0 items-start gap-3">
            <EntityMark name={item.payee.name} />
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <RowTitle onOpen={() => onOpen(item.id)}>
                  {item.payee.name}
                </RowTitle>
                {item.state === "active" ? null : <StateBadge item={item} />}
              </span>
              <RowMeta text={recurringMetaText(item)} />
            </span>
          </span>
        );
      },
      enableSorting: false,
      enableHiding: false,
      meta: { kind: "main", label: "Payment" },
    },
    {
      id: "next",
      accessorFn: (item) => nextDueDate(item) ?? "",
      header: "Next bill",
      cell: ({ row }) => {
        const item = row.original;
        const due = nextDueDate(item);
        return due ? (
          <span className="flex flex-col items-end gap-1 whitespace-nowrap">
            <span className="tabular-nums">{formatIsoDate(due)}</span>
            {item.nextBill ? (
              <span className="flex flex-wrap justify-end gap-1">
                <BillStatusBadge status={item.nextBill.status} />
                {item.nextBill.cardDeclinedAt ? <CardDeclinedBadge /> : null}
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-muted-foreground">No more bills</span>
        );
      },
      enableSorting: false,
      enableHiding: false,
      meta: { align: "end", label: "Next bill" },
    },
  ];
}

function RecurringTable({
  items,
  onOpen,
}: {
  items: readonly RecurringItem[] | undefined;
  onOpen: (itemId: string) => void;
}): JSX.Element {
  const columns = useMemo(() => recurringColumns(onOpen), [onOpen]);
  const table = useDataTable({
    data: items ?? [],
    columns,
    getRowId: (item) => item.id,
    paginate: false,
  });
  return (
    <div aria-busy={items === undefined || undefined}>
      {items === undefined ? (
        <p className="sr-only" role="status">
          Loading recurring payments…
        </p>
      ) : null}
      <DataTable
        table={table}
        caption="Recurring payments"
        loading={items === undefined}
        onRowOpen={(item) => onOpen(item.id)}
      />
    </div>
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
      className="-ml-0.5 inline-flex items-center gap-0.5 rounded-[4px] border-0 bg-transparent p-0 text-xs leading-4 font-(--w-ui) text-muted-foreground hover:text-foreground"
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
  const byCard = item.payVia === "card";
  return (
    <>
      {byCard && stored !== null ? (
        <p className="mt-0.5 text-xs leading-4 font-(--w-ui) text-muted-foreground">
          Estimate
        </p>
      ) : null}
      <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
        {stored === null ? (
          <span className="text-base text-muted-foreground">
            {byCard ? "No estimate" : "Variable amount"}
          </span>
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
        <p className="rounded-control border border-dashed border-input px-4 py-3.5 text-muted-foreground">
          No more bills
        </p>
      </section>
    );
  }
  const currency = bill.currency ?? item.currency;
  const stored = currency === "usd" ? bill.amountUsdc : bill.amountKes;
  const cardNote = cardNextBillNote(item);
  return (
    <section aria-label="Next bill" className="flex flex-col gap-2">
      <SectionLabel>Next bill</SectionLabel>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 rounded-control border border-border px-4 py-3.5">
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
        <span className="flex flex-wrap items-center gap-1 justify-self-start">
          <BillStatusBadge status={bill.status} />
          {bill.cardDeclinedAt ? <CardDeclinedBadge /> : null}
        </span>
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
      {cardNote ? <Note>{cardNote}</Note> : null}
    </section>
  );
}

/**
 * The step after setting up a card-paid payment: the card goes in at the
 * merchant, which then charges it for each bill.
 */
function CardNextStep({
  organizationId,
  item,
  card,
}: {
  organizationId: string;
  item: RecurringItem;
  card: NonNullable<RecurringItem["card"]>;
}): JSX.Element {
  return (
    <Callout
      tone="neutral"
      icon={CreditCardIcon}
      title={`Next: enter this card at ${item.payee.name}`}
      action={
        <RevealCardNumber organizationId={organizationId} cardId={card.id} />
      }
    >
      <p>
        Add {card.nickname} ({lastFourOf(card)}) as the payment card in your{" "}
        {item.payee.name} account. Its bills are then paid when{" "}
        {item.payee.name} charges it.
      </p>
    </Callout>
  );
}

/** How a card-paid payment is paid: the card, and whether it's frozen. */
function CardPaidBy({
  item,
  card,
}: {
  item: RecurringItem;
  card: NonNullable<RecurringItem["card"]>;
}): JSX.Element {
  return (
    <DetailItem
      label="How it’s paid"
      sub={
        <>
          {card.state === "frozen"
            ? `The card is frozen: ${item.payee.name}’s Card purchases are declined until it’s unfrozen. `
            : card.state === "closed"
              ? "The card is closed: pick another card for this payment. "
              : null}
          <Link href={`/cards?id=${card.id}`} className={textLinkClass}>
            See the card
          </Link>
        </>
      }
    >
      {PAY_VIA_LABELS.card}, {card.nickname} {lastFourOf(card)}
    </DetailItem>
  );
}

/**
 * One recurring payment: its bill still owed, then its schedule and
 * settings. Right after it's set up to be paid by a company-held card, the
 * next step comes first: entering the card at the merchant.
 */
export function RecurringDetailBody({
  organizationId,
  item,
  canAct,
  cardNextStep = false,
  onOpenBill,
}: {
  organizationId: string;
  item: RecurringItem;
  canAct: boolean;
  cardNextStep?: boolean;
  onOpenBill: (billId: string) => void;
}): JSX.Element {
  const card = item.payVia === "card" ? (item.card ?? null) : null;
  return (
    <>
      {cardNextStep && canAct && card ? (
        <CardNextStep organizationId={organizationId} item={item} card={card} />
      ) : null}
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
        {card ? (
          <CardPaidBy item={item} card={card} />
        ) : (
          <DetailItem label="How it’s paid">
            {item.payVia === "outside"
              ? "Outside Expendi. Mark each bill paid once you’ve paid it."
              : item.payVia === "card"
                ? PAY_VIA_LABELS.card
                : PAY_VIA_LABELS.expendi}
          </DetailItem>
        )}
        <DetailItem label="Reminder">
          {item.payVia === "card"
            ? "Only if a bill goes overdue"
            : reminderInWords(item.reminderDays)}
        </DetailItem>
        <DetailItem label="Overview heading">
          {headingLabel(item.overviewHeading)}
        </DetailItem>
        <DetailItem label="Category">{item.category.name}</DetailItem>
      </DetailList>
      {card &&
      canAct &&
      !cardNextStep &&
      card.state !== "closed" &&
      item.state !== "ended" ? (
        <RevealCardNumber organizationId={organizationId} cardId={card.id} />
      ) : null}
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

/**
 * Pausing or ending a card-paid payment declines its merchant on the card,
 * which the merchant doesn't hear about.
 */
function cardDeclinedLine(item: RecurringItem): string | null {
  if (item.payVia !== "card" || !item.card) return null;
  return `Card purchases from ${item.payee.name} will be declined on card ${lastFourOf(item.card)}. Cancel with ${item.payee.name} too, or it will keep trying.`;
}

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
  const declined = cardDeclinedLine(item);
  return (
    <>
      <Callout tone="warn" icon={confirmation.icon}>
        <p>{confirmation.message(item.payee.name)}</p>
        {declined ? <p>{declined}</p> : null}
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
