"use client";

import type { JSX } from "react";
import { useState } from "react";

import type { RecurringItem } from "@expendi-business/shared";

import {
  cellClass,
  headCellClass,
  primaryButton,
  secondaryButton,
  tableClass,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import { formatBillAmount } from "~/features/bills/bill-amount";
import { nairobiIsoDate } from "~/features/bills/bill-groups";
import { BillStatusBadge } from "~/features/bills/bill-status";
import { StatusBadge } from "~/features/payment-ui";
import {
  useCreateRecurringItem,
  useRecurringItems,
} from "~/features/recurring/recurring-api";
import {
  blankDraft,
  nextDueDate,
  scheduleInWords,
  STATE_LABELS,
} from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { RecurringDetailPanel } from "./recurring-detail";
import { PAY_VIA_LABELS, RecurringForm } from "./recurring-form";

type Panel =
  | { readonly kind: "create"; readonly today: string }
  | { readonly kind: "item"; readonly itemId: string };

/**
 * Recurring payments (spec §6.20): set up once, each always has its next
 * bill in Bills. Admins add, change, pause and end them; accountants see
 * the same, read-only.
 */
export function RecurringView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyRecurring
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyRecurring({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const items = useRecurringItems(organizationId);
  const [panel, setPanel] = useState<Panel | null>(null);
  const selectedId = panel?.kind === "item" ? panel.itemId : null;

  return (
    <section>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Recurring</h1>
          <p className="mt-1 text-sm text-stone-600">
            Rent, subscriptions, utilities and statutory payments, set up once.
            Each one&apos;s next bill is always ready in Bills.
          </p>
        </div>
        {canAct ? (
          <button
            type="button"
            onClick={() =>
              setPanel({ kind: "create", today: nairobiIsoDate(new Date()) })
            }
            className={primaryButton}
          >
            New recurring payment
          </button>
        ) : null}
      </div>

      <div
        className={`mt-6 grid gap-6 ${panel ? "xl:grid-cols-2" : ""} xl:items-start`}
      >
        <ItemList
          items={items}
          selectedId={selectedId}
          onSelect={(itemId) => setPanel({ kind: "item", itemId })}
        />
        {panel?.kind === "item" ? (
          <div className="xl:sticky xl:top-8">
            <RecurringDetailPanel
              key={panel.itemId}
              organizationId={organizationId}
              itemId={panel.itemId}
              canAct={canAct}
              onClose={() => setPanel(null)}
            />
          </div>
        ) : panel?.kind === "create" && canAct ? (
          <div className="xl:sticky xl:top-8">
            <CreateRecurringItem
              organizationId={organizationId}
              today={panel.today}
              onCreated={(item) => setPanel({ kind: "item", itemId: item.id })}
              onCancel={() => setPanel(null)}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

function ItemList({
  items,
  selectedId,
  onSelect,
}: {
  items: ReturnType<typeof useRecurringItems>;
  selectedId: string | null;
  onSelect: (itemId: string) => void;
}): JSX.Element {
  if (items.isPending) {
    return (
      <p className="text-sm text-stone-500">Loading recurring payments…</p>
    );
  }
  if (items.isError) {
    return (
      <div className="text-sm text-error-700" role="alert">
        <p>{describeApiError(items.error)}</p>
        <button
          type="button"
          onClick={() => void items.refetch()}
          className={`mt-2 ${secondaryButton}`}
        >
          Try again
        </button>
      </div>
    );
  }
  if (items.data.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        No recurring payments yet. Set up rent, subscriptions or a monthly KRA
        payment once, and its next bill is always ready in Bills.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Payee
            </th>
            <th scope="col" className={headCellClass}>
              Schedule
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              Amount
            </th>
            <th scope="col" className={headCellClass}>
              Paid
            </th>
            <th scope="col" className={headCellClass}>
              Next due
            </th>
            <th scope="col" className={headCellClass}>
              State
            </th>
          </tr>
        </thead>
        <tbody>
          {items.data.map((item) => (
            <ItemRow
              key={item.id}
              item={item}
              selected={item.id === selectedId}
              onSelect={() => onSelect(item.id)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ItemRow({
  item,
  selected,
  onSelect,
}: {
  item: RecurringItem;
  selected: boolean;
  onSelect: () => void;
}): JSX.Element {
  const state = STATE_LABELS[item.state];
  const due = nextDueDate(item);
  return (
    <tr
      className={`border-t border-stone-200 align-top ${selected ? "bg-brand-50" : ""}`}
    >
      <td className={cellClass}>
        <button
          type="button"
          onClick={onSelect}
          aria-pressed={selected}
          className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
        >
          {item.payee.name}
        </button>
        <span className="block text-xs text-stone-500">
          {item.category.name}
        </span>
      </td>
      <td className={cellClass}>{scheduleInWords(item)}</td>
      <td className={`${cellClass} text-right whitespace-nowrap tabular-nums`}>
        {formatBillAmount(item) ?? "Variable"}
      </td>
      <td className={cellClass}>{PAY_VIA_LABELS[item.payVia]}</td>
      <td className={`${cellClass} whitespace-nowrap`}>
        {due ? formatIsoDate(due) : "—"}
        {item.nextBill ? (
          <span className="mt-1 block">
            <BillStatusBadge status={item.nextBill.status} />
          </span>
        ) : null}
      </td>
      <td className={cellClass}>
        <StatusBadge label={state.label} tone={state.tone} />
      </td>
    </tr>
  );
}

function CreateRecurringItem({
  organizationId,
  today,
  onCreated,
  onCancel,
}: {
  organizationId: string;
  today: string;
  onCreated: (item: RecurringItem) => void;
  onCancel: () => void;
}): JSX.Element {
  const create = useCreateRecurringItem(organizationId);
  return (
    <section
      aria-label="New recurring payment"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <h2 className="text-lg font-semibold">New recurring payment</h2>
      <p className="mt-1 mb-4 text-sm text-stone-600">
        Its first bill is created now and shows in Bills.
      </p>
      <RecurringForm
        organizationId={organizationId}
        initialDraft={blankDraft(today)}
        submitLabel="Set up payment"
        submitting={create.isPending}
        submitError={create.isError ? create.error : null}
        onSubmit={(request) => create.mutate(request, { onSuccess: onCreated })}
        onCancel={onCancel}
      />
    </section>
  );
}
