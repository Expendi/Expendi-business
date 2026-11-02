"use client";

import type { JSX } from "react";
import { useState } from "react";

import type {
  Bill,
  BillPaymentResult,
  PayeeChangeHold,
} from "@expendi-business/shared";
import {
  BILL_PAYMENT_MAX_BILLS,
  billPaymentSchema,
} from "@expendi-business/shared";

import type { BillPaymentRequest } from "~/features/bills/bill-payment";
import type { PreparedBillPayment } from "~/features/bills/bills-api";
import type { BillListView } from "~/features/payment-keys";
import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  cellClass,
  headCellClass,
  primaryButton,
  secondaryButton,
  tableClass,
  textButton,
} from "~/components/styles";
import { useDashboard } from "~/contexts/dashboard-context";
import { formatBillAmount } from "~/features/bills/bill-amount";
import {
  groupOpenBills,
  historyNewestFirst,
} from "~/features/bills/bill-groups";
import {
  CostChangedError,
  describePaymentError,
  holdFrom,
  isPayable,
  toggleSelection,
} from "~/features/bills/bill-payment";
import { BillAmount, BillStatusBadge } from "~/features/bills/bill-status";
import {
  useBills,
  useInvalidateBills,
  useKesRate,
  usePayBills,
  usePrepareBillPayment,
} from "~/features/bills/bills-api";
import { HoldWarning } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { BillForm } from "./bill-form";
import { BillPanel } from "./bill-panel";
import {
  BillPaymentResultNotice,
  BillPaymentReview,
} from "./bill-payment-review";

const VIEWS: readonly { view: BillListView; label: string }[] = [
  { view: "open", label: "To pay" },
  { view: "history", label: "Paid & cancelled" },
];

type Panel =
  { readonly kind: "bill"; readonly billId: string } | { readonly kind: "new" };

type PaymentStep =
  | {
      readonly step: "hold";
      readonly request: BillPaymentRequest;
      readonly hold: PayeeChangeHold;
    }
  | { readonly step: "review"; readonly prepared: PreparedBillPayment };

/** Selected together for Pay all; a failed payment is retried on its own. */
const canSelect = (bill: Bill): boolean =>
  isPayable(bill) && bill.status !== "payout_failed";

/**
 * Bills (spec §6.14, §6.20): what's owed by status, and what was paid or
 * cancelled. Admins add and change bills, upload invoices (PDFs too), and
 * pay up to 20 at once with one passkey, each as its own payout.
 * Accountants see the same, with no actions.
 */
export function BillsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyBills
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyBills({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [view, setView] = useState<BillListView>("open");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [payment, setPayment] = useState<PaymentStep | null>(null);
  const [result, setResult] = useState<BillPaymentResult | null>(null);
  const bills = useBills(organizationId, view);
  const rate = useKesRate(organizationId);
  const refresh = useInvalidateBills(organizationId);
  const prepare = usePrepareBillPayment(organizationId);
  const pay = usePayBills(organizationId);

  function startPayment(request: BillPaymentRequest) {
    pay.reset();
    setResult(null);
    prepare.mutate(request, {
      onSuccess: (prepared) => setPayment({ step: "review", prepared }),
      onError: (error) => {
        const hold = holdFrom(error);
        setPayment(
          hold && !request.secondConfirmation
            ? { step: "hold", request, hold }
            : null,
        );
      },
    });
  }

  function onPay(prepared: PreparedBillPayment) {
    pay.mutate(prepared, {
      onSuccess: (outcome) => {
        if (outcome.status !== "approved") return;
        setResult(outcome.result);
        setPayment(null);
        setSelected([]);
      },
      onError: (error) => {
        const fresh =
          error instanceof CostChangedError
            ? billPaymentSchema.safeParse(error.fresh)
            : null;
        if (fresh?.success) {
          setPayment({
            step: "review",
            prepared: {
              ...prepared,
              payment: fresh.data,
              preparedAt: Date.now(),
            },
          });
          return;
        }
        // The confirmation may have reached the API; show where things stand.
        setPayment(null);
        void refresh();
      },
    });
  }

  const openBills = view === "open" ? (bills.data ?? []) : [];
  const selectedBills = openBills.filter((bill) => selected.includes(bill.id));
  const busy = prepare.isPending || pay.isPending || payment !== null;
  const holdShown = payment?.step === "hold";
  const actionError =
    prepare.isError && !holdShown
      ? describePaymentError(prepare.error)
      : pay.isError
        ? describePaymentError(pay.error)
        : null;

  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Bills</h1>
          <p className="mt-1 text-sm text-stone-600">
            {canAct
              ? `Suppliers, rent, utilities, subscriptions and statutory payments. Pay up to ${String(BILL_PAYMENT_MAX_BILLS)} bills with one passkey; each is paid on its own.`
              : "Suppliers, rent, utilities, subscriptions and statutory payments. Only admins add and pay bills."}
          </p>
        </div>
        {canAct ? (
          <button
            type="button"
            onClick={() => setPanel({ kind: "new" })}
            className={primaryButton}
          >
            New bill
          </button>
        ) : null}
      </div>

      {result ? (
        <BillPaymentResultNotice
          result={result}
          onRetry={(billId) =>
            startPayment({
              billIds: [billId],
              retry: true,
              secondConfirmation: false,
            })
          }
          onDismiss={() => setResult(null)}
        />
      ) : null}

      {canAct && view === "open" ? (
        <ApprovalPasskeyGate>
          {payment?.step === "review" ? (
            <BillPaymentReview
              payment={payment.prepared.payment}
              isRetry={payment.prepared.request.retry}
              paying={pay.isPending}
              onPay={() => onPay(payment.prepared)}
              onCancel={() => {
                pay.reset();
                setPayment(null);
              }}
            />
          ) : payment?.step === "hold" ? (
            <HoldWarning
              hold={payment.hold}
              onConfirm={() =>
                startPayment({ ...payment.request, secondConfirmation: true })
              }
              onCancel={() => {
                prepare.reset();
                setPayment(null);
              }}
            />
          ) : (
            <PayBar
              bills={openBills}
              selected={selectedBills}
              preparing={prepare.isPending}
              onSelect={setSelected}
              onPay={() =>
                startPayment({
                  billIds: selectedBills.map((bill) => bill.id),
                  retry: false,
                  secondConfirmation: false,
                })
              }
            />
          )}
        </ApprovalPasskeyGate>
      ) : null}

      {pay.data?.status === "cancelled" && payment ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing was sent.</p>
      ) : null}
      {actionError ? (
        <p className={alertClass} role="alert">
          {actionError}
        </p>
      ) : null}

      <div role="tablist" aria-label="Bills" className="flex gap-2">
        {VIEWS.map((option) => (
          <button
            key={option.view}
            type="button"
            role="tab"
            aria-selected={view === option.view}
            onClick={() => {
              setView(option.view);
              setSelected([]);
            }}
            className={`rounded-md px-3 py-1.5 text-sm font-medium ${view === option.view ? "bg-stone-900 text-white" : "text-stone-700 hover:bg-stone-100"}`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div
        className={`grid gap-6 ${panel ? "xl:grid-cols-2" : ""} xl:items-start`}
      >
        <div className="space-y-6">
          {bills.isPending ? (
            <p className="text-sm text-stone-500">Loading bills…</p>
          ) : bills.isError ? (
            <div className="text-sm text-error-700" role="alert">
              <p>{describeApiError(bills.error)}</p>
              <button
                type="button"
                onClick={() => void bills.refetch()}
                className={`mt-2 ${secondaryButton}`}
              >
                Try again
              </button>
            </div>
          ) : view === "open" ? (
            <OpenBills
              bills={bills.data}
              rate={rate}
              selectedId={panel?.kind === "bill" ? panel.billId : null}
              selection={
                canAct
                  ? {
                      selected,
                      disabled: busy,
                      onToggle: (billId) =>
                        setSelected((current) =>
                          toggleSelection(current, billId),
                        ),
                    }
                  : null
              }
              onOpen={(billId) => setPanel({ kind: "bill", billId })}
            />
          ) : (
            <BillHistory
              bills={bills.data}
              selectedId={panel?.kind === "bill" ? panel.billId : null}
              onOpen={(billId) => setPanel({ kind: "bill", billId })}
            />
          )}
        </div>
        {panel ? (
          <div className="xl:sticky xl:top-8">
            {panel.kind === "new" ? (
              <section
                aria-label="New bill"
                className="rounded-lg border border-stone-200 bg-white p-4"
              >
                <BillForm
                  organizationId={organizationId}
                  bill={null}
                  onSaved={(bill) => {
                    setView("open");
                    setPanel({ kind: "bill", billId: bill.id });
                  }}
                  onCancel={() => setPanel(null)}
                />
              </section>
            ) : (
              <BillPanel
                key={panel.billId}
                organizationId={organizationId}
                billId={panel.billId}
                canAct={canAct}
                rate={rate}
                paymentBusy={busy}
                onPay={(bill) =>
                  startPayment({
                    billIds: [bill.id],
                    retry: bill.status === "payout_failed",
                    secondConfirmation: false,
                  })
                }
                onClose={() => setPanel(null)}
              />
            )}
          </div>
        ) : null}
      </div>
    </section>
  );
}

/** Pay all: the selection, its total, and a shortcut to select every payable bill. */
function PayBar({
  bills,
  selected,
  preparing,
  onSelect,
  onPay,
}: {
  bills: readonly Bill[];
  selected: readonly Bill[];
  preparing: boolean;
  onSelect: (billIds: string[]) => void;
  onPay: () => void;
}): JSX.Element {
  const payable = bills.filter(canSelect);
  const totals = selected
    .map((bill) => formatBillAmount(bill))
    .filter((amount): amount is string => amount !== null);
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-white p-4">
      <p className="text-sm text-stone-700">
        {selected.length === 0
          ? "Select bills to pay together."
          : `${String(selected.length)} selected · ${totals.join(" + ")}`}
      </p>
      <button
        type="button"
        disabled={selected.length === 0 || preparing}
        onClick={onPay}
        className={primaryButton}
      >
        {preparing
          ? "Working out the cost…"
          : selected.length > 1
            ? `Pay all ${String(selected.length)}`
            : "Pay"}
      </button>
      {payable.length > 0 && selected.length < payable.length ? (
        <button
          type="button"
          onClick={() =>
            onSelect(
              payable.slice(0, BILL_PAYMENT_MAX_BILLS).map((bill) => bill.id),
            )
          }
          className={textButton}
        >
          Select all payable
          {payable.length > BILL_PAYMENT_MAX_BILLS
            ? ` (first ${String(BILL_PAYMENT_MAX_BILLS)})`
            : ""}
        </button>
      ) : null}
      {selected.length > 0 ? (
        <button
          type="button"
          onClick={() => onSelect([])}
          className={textButton}
        >
          Clear selection
        </button>
      ) : null}
    </div>
  );
}

interface Selection {
  readonly selected: readonly string[];
  readonly disabled: boolean;
  readonly onToggle: (billId: string) => void;
}

function BillName({
  bill,
  selected,
  onOpen,
}: {
  bill: Bill;
  selected: boolean;
  onOpen: (billId: string) => void;
}): JSX.Element {
  const notes = [
    bill.reference,
    bill.category.name,
    bill.recurringItemId ? "Recurring" : null,
    bill.payrollRunId ? "Payroll" : null,
    bill.fileCount > 0
      ? `${String(bill.fileCount)} ${bill.fileCount === 1 ? "file" : "files"}`
      : null,
  ].filter((note): note is string => note !== null);
  return (
    <>
      <button
        type="button"
        onClick={() => onOpen(bill.id)}
        aria-pressed={selected}
        className="text-left font-medium text-brand-700 underline-offset-4 hover:underline"
      >
        {bill.payee.name}
      </button>
      <span className="block text-xs text-stone-500">{notes.join(" · ")}</span>
    </>
  );
}

function OpenBills({
  bills,
  rate,
  selectedId,
  selection,
  onOpen,
}: {
  bills: readonly Bill[];
  rate: string | null;
  selectedId: string | null;
  selection: Selection | null;
  onOpen: (billId: string) => void;
}): JSX.Element {
  const groups = groupOpenBills(bills);
  if (groups.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        Nothing to pay. New bills and recurring payments show up here.
      </p>
    );
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.status} aria-label={group.title}>
          <h2 className="mb-2 text-base font-semibold">{group.title}</h2>
          <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
            <table className={tableClass}>
              <thead className="bg-stone-100 text-stone-600">
                <tr>
                  {selection ? (
                    <th scope="col" className={`${headCellClass} w-8`}>
                      <span className="sr-only">Select</span>
                    </th>
                  ) : null}
                  <th scope="col" className={headCellClass}>
                    Due
                  </th>
                  <th scope="col" className={headCellClass}>
                    Payee
                  </th>
                  <th scope="col" className={`${headCellClass} text-right`}>
                    Amount
                  </th>
                  <th scope="col" className={headCellClass}>
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {group.bills.map((bill) => {
                  const checked = selection
                    ? selection.selected.includes(bill.id)
                    : false;
                  return (
                    <tr
                      key={bill.id}
                      className={`border-t border-stone-200 align-top ${bill.id === selectedId ? "bg-brand-50" : ""}`}
                    >
                      {selection ? (
                        <td className={cellClass}>
                          {canSelect(bill) ? (
                            <input
                              type="checkbox"
                              aria-label={`Select ${bill.payee.name}`}
                              checked={checked}
                              disabled={
                                selection.disabled ||
                                (!checked &&
                                  selection.selected.length >=
                                    BILL_PAYMENT_MAX_BILLS)
                              }
                              onChange={() => selection.onToggle(bill.id)}
                            />
                          ) : null}
                        </td>
                      ) : null}
                      <td className={`${cellClass} whitespace-nowrap`}>
                        {formatIsoDate(bill.dueOn)}
                      </td>
                      <td className={cellClass}>
                        <BillName
                          bill={bill}
                          selected={bill.id === selectedId}
                          onOpen={onOpen}
                        />
                      </td>
                      <td
                        className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
                      >
                        <BillAmount bill={bill} rate={rate} />
                      </td>
                      <td className={cellClass}>
                        <BillStatusBadge status={bill.status} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </>
  );
}

function settledOn(bill: Bill): string {
  if (bill.paidOn) return formatIsoDate(bill.paidOn);
  if (bill.cancelledAt) return formatNairobiDate(bill.cancelledAt);
  return formatIsoDate(bill.dueOn);
}

function BillHistory({
  bills,
  selectedId,
  onOpen,
}: {
  bills: readonly Bill[];
  selectedId: string | null;
  onOpen: (billId: string) => void;
}): JSX.Element {
  if (bills.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
        No bills paid or cancelled in the last six months.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Settled
            </th>
            <th scope="col" className={headCellClass}>
              Payee
            </th>
            <th scope="col" className={`${headCellClass} text-right`}>
              Amount
            </th>
            <th scope="col" className={headCellClass}>
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {historyNewestFirst(bills).map((bill) => (
            <tr
              key={bill.id}
              className={`border-t border-stone-200 align-top ${bill.id === selectedId ? "bg-brand-50" : ""}`}
            >
              <td className={`${cellClass} whitespace-nowrap`}>
                {settledOn(bill)}
              </td>
              <td className={cellClass}>
                <BillName
                  bill={bill}
                  selected={bill.id === selectedId}
                  onOpen={onOpen}
                />
              </td>
              <td
                className={`${cellClass} text-right whitespace-nowrap tabular-nums`}
              >
                <BillAmount bill={bill} rate={null} />
              </td>
              <td className={cellClass}>
                <BillStatusBadge status={bill.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
