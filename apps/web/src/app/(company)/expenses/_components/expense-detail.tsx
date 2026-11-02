"use client";

import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";

import type { ExpenseDetail } from "@expendi-business/shared";

import {
  ETIMS_STATUS_LABELS,
  EXPENSE_LIST_KIND_LABELS,
  ExpenseStatusBadge,
  WarningList,
} from "~/components/expense-status";
import { ReceiptViewer } from "~/components/receipt-viewer";
import { secondaryButton, textButton } from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { formatKesCents } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-sm break-words">{children}</dd>
    </div>
  );
}

function personOf(expense: ExpenseDetail): string {
  return expense.member.name ?? expense.member.email;
}

/** Who the expense belongs to, in the words its kind uses. */
function personLabel(expense: ExpenseDetail): string {
  if (expense.listKind === "company") return "Recorded by";
  return expense.kind === "float" ? "Float holder" : "Claimed by";
}

function ExpenseFields({ expense }: { expense: ExpenseDetail }): JSX.Element {
  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs text-stone-500">
          {EXPENSE_LIST_KIND_LABELS[expense.listKind]}
          {expense.kind === "claim" && expense.floatId
            ? " · claim for what the float didn't cover"
            : ""}
        </p>
        <h2 className="mt-1 text-lg font-semibold break-words">
          {expense.merchant}
        </h2>
        <p className="mt-1 text-xl font-semibold tabular-nums">
          KES {formatKesCents(expense.amountKes)}
        </p>
        <div className="mt-2">
          <ExpenseStatusBadge status={expense.status} />
        </div>
      </div>
      <WarningList warnings={expense.warnings} />
      {expense.rejectedReason ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Rejected: {expense.rejectedReason}
        </p>
      ) : null}
      {expense.noReceipt ? (
        <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
          No receipt
          {expense.noReceiptReason ? `: ${expense.noReceiptReason}` : "."}
        </p>
      ) : null}
      <dl className="grid grid-cols-2 gap-x-4 gap-y-3">
        <Field label={personLabel(expense)}>{personOf(expense)}</Field>
        <Field label="Date">{formatIsoDate(expense.spentOn)}</Field>
        <Field label="Category">{expense.category.name}</Field>
        <Field label="eTIMS">
          {ETIMS_STATUS_LABELS[expense.etimsStatus]}
          {expense.etimsInvoiceNumber ? (
            <span className="block text-xs text-stone-600">
              Invoice {expense.etimsInvoiceNumber}
            </span>
          ) : null}
          {expense.etimsSupplierPin ? (
            <span className="block text-xs text-stone-600">
              Supplier PIN {expense.etimsSupplierPin}
            </span>
          ) : null}
        </Field>
        {expense.mpesaCode ? (
          <Field label="M-Pesa code">
            <span className="font-mono">{expense.mpesaCode}</span>
          </Field>
        ) : null}
        {expense.paidFromAccount ? (
          <Field label="Paid from">{expense.paidFromAccount.name}</Field>
        ) : null}
        {expense.bill ? (
          <Field label="Bill">
            {expense.bill.payeeName}
            {expense.bill.reference ? ` · ${expense.bill.reference}` : ""}
          </Field>
        ) : null}
        {expense.paidAt ? (
          <Field label="Paid">{formatNairobiDate(expense.paidAt)}</Field>
        ) : null}
        {expense.selfApproved ? (
          <Field label="Approval">Approved by the claimant</Field>
        ) : null}
        {expense.source === "import" ? (
          <Field label="Source">Imported history</Field>
        ) : null}
      </dl>
      {expense.description ? (
        <p className="text-sm whitespace-pre-wrap text-stone-700">
          {expense.description}
        </p>
      ) : null}
    </div>
  );
}

/** One expense's details with its receipts beside them. */
export function ExpenseDetailPanel({
  organizationId,
  expenseId,
  onClose,
}: {
  organizationId: string;
  expenseId: string;
  onClose: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const detail = useQuery({
    queryKey: queryKeys.expense(organizationId, expenseId),
    queryFn: () => api.getExpense(organizationId, expenseId),
  });

  return (
    <section
      aria-label="Expense"
      className="rounded-lg border border-stone-200 bg-white p-4"
    >
      <div className="mb-3 flex justify-end">
        <button type="button" onClick={onClose} className={textButton}>
          Close
        </button>
      </div>
      {detail.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : detail.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(detail.error)}</p>
          <button
            type="button"
            onClick={() => void detail.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : (
        <div className="grid gap-6 2xl:grid-cols-2">
          <ExpenseFields expense={detail.data} />
          <ReceiptViewer receipts={detail.data.receipts} />
        </div>
      )}
    </section>
  );
}
