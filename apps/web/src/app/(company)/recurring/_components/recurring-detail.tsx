"use client";

import type { JSX } from "react";
import Link from "next/link";
import { useState } from "react";

import type { RecurringItem } from "@expendi-business/shared";
import { defaultBillHeading } from "@expendi-business/shared";

import type { RecurringItemAction } from "~/features/recurring/recurring-api";
import {
  alertClass,
  linkClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { formatBillAmount } from "~/features/bills/bill-amount";
import { BillStatusBadge, headingLabel } from "~/features/bills/bill-status";
import { Field, StatusBadge } from "~/features/payment-ui";
import {
  useRecurringItem,
  useRecurringItemAction,
  useUpdateRecurringItem,
} from "~/features/recurring/recurring-api";
import {
  draftFromItem,
  scheduleInWords,
  STATE_LABELS,
} from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { PAY_VIA_LABELS, RecurringForm } from "./recurring-form";

function reminderInWords(days: number): string {
  if (days === 0) return "On the due date";
  return `${String(days)} ${days === 1 ? "day" : "days"} before it’s due`;
}

/** One recurring payment, with its outstanding bill; admins change it here. */
export function RecurringDetailPanel({
  organizationId,
  itemId,
  canAct,
  onClose,
}: {
  organizationId: string;
  itemId: string;
  canAct: boolean;
  onClose: () => void;
}): JSX.Element {
  const item = useRecurringItem(organizationId, itemId);
  const [editing, setEditing] = useState(false);

  return (
    <section
      aria-label="Recurring payment"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="mb-3 flex justify-end">
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      {item.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : item.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(item.error)}</p>
          <button
            type="button"
            onClick={() => void item.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : editing ? (
        <EditRecurringItem
          organizationId={organizationId}
          item={item.data}
          onDone={() => setEditing(false)}
        />
      ) : (
        <div className="space-y-6">
          <ItemFields item={item.data} />
          <NextBill item={item.data} />
          {canAct && item.data.state !== "ended" ? (
            <ItemActions
              organizationId={organizationId}
              item={item.data}
              onEdit={() => setEditing(true)}
            />
          ) : null}
        </div>
      )}
    </section>
  );
}

function ItemFields({ item }: { item: RecurringItem }): JSX.Element {
  const state = STATE_LABELS[item.state];
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold break-words">{item.payee.name}</h2>
        <p className="mt-1 text-xl font-semibold tabular-nums">
          {formatBillAmount(item) ?? "Variable amount"}
        </p>
        <div className="mt-2">
          <StatusBadge label={state.label} tone={state.tone} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label="When">{scheduleInWords(item)}</Field>
        <Field label="Starts">{formatIsoDate(item.startsOn)}</Field>
        <Field label="Ends">
          {item.endsOn ? formatIsoDate(item.endsOn) : "No end date"}
        </Field>
        {item.nextDueOn ? (
          <Field label={item.nextBill ? "The bill after that" : "Next bill"}>
            Due {formatIsoDate(item.nextDueOn)}
          </Field>
        ) : null}
        <Field label="How it’s paid">
          {item.payVia === "outside"
            ? "Outside Expendi. Mark each bill paid once you’ve paid it."
            : PAY_VIA_LABELS.expendi}
        </Field>
        <Field label="Reminder">{reminderInWords(item.reminderDays)}</Field>
        <Field label="Overview heading">
          {headingLabel(item.overviewHeading)}
        </Field>
        <Field label="Category">{item.category.name}</Field>
      </dl>
    </div>
  );
}

function NextBill({ item }: { item: RecurringItem }): JSX.Element | null {
  const bill = item.nextBill;
  if (bill === null) return null;
  const amount = formatBillAmount({ ...bill, currency: item.currency });
  return (
    <section aria-label="Next bill" className="space-y-2">
      <h3 className="text-sm font-semibold">Next bill</h3>
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-stone-200 p-3 text-sm">
        <span>Due {formatIsoDate(bill.dueOn)}</span>
        <span
          className={`font-medium tabular-nums ${amount === null ? "text-amber-800" : ""}`}
        >
          {amount ?? "Amount to enter"}
        </span>
        <BillStatusBadge status={bill.status} />
        <Link href="/bills" className={linkClass}>
          Open Bills
        </Link>
      </div>
    </section>
  );
}

type Confirmable = Exclude<RecurringItemAction, "resume">;

const CONFIRMATIONS: Record<
  Confirmable,
  { title: string; message: (payee: string) => string; confirm: string }
> = {
  pause: {
    title: "Pause this payment?",
    message: (payee) =>
      `No new bills for ${payee} until you resume it. The bill already there stays.`,
    confirm: "Pause",
  },
  end: {
    title: "End this payment?",
    message: (payee) =>
      `No more bills for ${payee}. The bill already there stays. Ending is final: it can’t be undone.`,
    confirm: "End payment",
  },
};

function ItemActions({
  organizationId,
  item,
  onEdit,
}: {
  organizationId: string;
  item: RecurringItem;
  onEdit: () => void;
}): JSX.Element {
  const action = useRecurringItemAction(organizationId, item.id);
  const [confirming, setConfirming] = useState<Confirmable | null>(null);

  function close() {
    setConfirming(null);
    action.reset();
  }

  if (confirming) {
    const confirmation = CONFIRMATIONS[confirming];
    return (
      <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">{confirmation.title}</p>
        <p>{confirmation.message(item.payee.name)}</p>
        <div className="flex gap-3">
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate(confirming, { onSuccess: close })}
            className={primaryButton}
          >
            {action.isPending ? "Working…" : confirmation.confirm}
          </button>
          <button
            type="button"
            disabled={action.isPending}
            onClick={close}
            className={secondaryButton}
          >
            Keep it
          </button>
        </div>
        {action.isError ? (
          <p className={alertClass} role="alert">
            {describeApiError(action.error)}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-3">
        <button type="button" onClick={onEdit} className={secondaryButton}>
          Edit payment
        </button>
        {item.state === "paused" ? (
          <button
            type="button"
            disabled={action.isPending}
            onClick={() => action.mutate("resume")}
            className={primaryButton}
          >
            {action.isPending ? "Resuming…" : "Resume"}
          </button>
        ) : (
          <button
            type="button"
            onClick={() => {
              action.reset();
              setConfirming("pause");
            }}
            className={secondaryButton}
          >
            Pause
          </button>
        )}
        <button
          type="button"
          onClick={() => {
            action.reset();
            setConfirming("end");
          }}
          className={secondaryButton}
        >
          End payment
        </button>
      </div>
      {action.isError ? (
        <p className={alertClass} role="alert">
          {describeApiError(action.error)}
        </p>
      ) : null}
    </div>
  );
}

export function EditRecurringItem({
  organizationId,
  item,
  onDone,
}: {
  organizationId: string;
  item: RecurringItem;
  onDone: () => void;
}): JSX.Element {
  const update = useUpdateRecurringItem(organizationId, item.id);
  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">Edit recurring payment</h2>
        <p className="mt-1 text-sm text-stone-600">
          Changes apply to the bills still to come. The overview heading follows
          the payee ({headingLabel(defaultBillHeading(item.payee.kind))}) unless
          you pick another.
        </p>
      </div>
      <RecurringForm
        organizationId={organizationId}
        item={item}
        initialDraft={draftFromItem(item)}
        submitLabel="Save changes"
        submitting={update.isPending}
        submitError={update.isError ? update.error : null}
        onSubmit={(request) => update.mutate(request, { onSuccess: onDone })}
        onCancel={onDone}
      />
    </div>
  );
}
