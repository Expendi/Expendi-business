"use client";

import type { JSX, ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CircleAlertIcon, ImageOffIcon } from "lucide-react";
import Link from "next/link";

import type { Expense, ExpenseReceipt } from "@expendi-business/shared";

import { TextLinkButton } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SectionLabel,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/contexts/auth-context";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { queryKeys } from "~/lib/query-keys";
import {
  describeWarning,
  ETIMS_LABELS,
  EXPENSE_STATUS,
  expenseKindLabel,
  personName,
  warningKey,
} from "./expense-labels";
import { ReceiptGallery } from "./receipt-gallery";

/** Who the expense belongs to, in the words its kind uses. */
function personLabel(expense: Expense): string {
  if (expense.kind === "card") return "Cardholder";
  if (expense.listKind === "company") return "Recorded by";
  return expense.kind === "float" ? "Float holder" : "Submitted by";
}

function eyebrowOf(expense: Expense): string {
  const label = expenseKindLabel(expense);
  return expense.kind === "claim" && expense.floatId
    ? `${label} · for what the float didn't cover`
    : label;
}

/** A reimbursement still to approve or pay again is acted on in Approvals. */
export function isInApprovals(expense: Expense): boolean {
  return (
    expense.kind === "claim" &&
    (expense.status === "submitted" || expense.status === "payout_failed")
  );
}

/**
 * An expense's details, as the side sheet shows them. `receipts` is the
 * receipt section: the files load with the detail, after the row.
 */
export function ExpenseDetails({
  expense,
  receipts,
}: {
  expense: Expense;
  receipts: ReactNode;
}): JSX.Element {
  return (
    <>
      {expense.warnings.length > 0 ? (
        <Callout tone="warn" title="Check before approving">
          <ul className="mt-1 list-disc pl-[18px]">
            {expense.warnings.map((warning) => (
              <li key={warningKey(warning)}>{describeWarning(warning)}</li>
            ))}
          </ul>
        </Callout>
      ) : null}
      {expense.rejectedReason ? (
        <Callout tone="warn" icon={CircleAlertIcon}>
          <p>
            <span className="font-(--w-ui)">Rejected: </span>
            {expense.rejectedReason}
          </p>
        </Callout>
      ) : null}
      {expense.noReceipt ? (
        <Callout tone="warn" icon={ImageOffIcon}>
          <p>
            No receipt
            {expense.noReceiptReason ? `: ${expense.noReceiptReason}` : "."}
          </p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label={personLabel(expense)}>
          {personName(expense.member)}
        </DetailItem>
        <DetailItem label="Date">{formatIsoDate(expense.spentOn)}</DetailItem>
        <DetailItem label="Category">{expense.category.name}</DetailItem>
        <DetailItem label="eTIMS">
          {ETIMS_LABELS[expense.etimsStatus]}
          {expense.etimsInvoiceNumber ? (
            <span className="block text-xs leading-4 text-muted-foreground">
              Invoice {expense.etimsInvoiceNumber}
            </span>
          ) : null}
          {expense.etimsSupplierPin ? (
            <span className="block text-xs leading-4 text-muted-foreground">
              Supplier PIN {expense.etimsSupplierPin}
            </span>
          ) : null}
        </DetailItem>
        {expense.mpesaCode ? (
          <DetailItem label="M-Pesa code">{expense.mpesaCode}</DetailItem>
        ) : null}
        {expense.paidFromAccount ? (
          <DetailItem label="Paid from">
            {expense.paidFromAccount.name}
          </DetailItem>
        ) : null}
        {expense.paidAt ? (
          <DetailItem label="Paid">
            {formatNairobiDate(expense.paidAt)}
          </DetailItem>
        ) : null}
        {expense.selfApproved ? (
          <DetailItem label="Approval">
            Approved by the person who submitted it
          </DetailItem>
        ) : null}
        {expense.source === "import" ? (
          <DetailItem label="Source">Imported history</DetailItem>
        ) : null}
      </DetailList>
      {expense.description ? (
        <p className="whitespace-pre-wrap text-secondary-foreground">
          {expense.description}
        </p>
      ) : null}
      <SectionLabel>
        {expense.receiptCount > 1 ? "Receipts" : "Receipt"}
      </SectionLabel>
      {receipts}
    </>
  );
}

function ReceiptSection({
  expense,
  receipts,
  failed,
  onRetry,
}: {
  expense: Expense;
  receipts: readonly ExpenseReceipt[] | undefined;
  failed: boolean;
  onRetry: () => void;
}): JSX.Element {
  if (receipts) return <ReceiptGallery receipts={receipts} />;
  if (expense.receiptCount === 0) return <ReceiptGallery receipts={[]} />;
  if (failed) {
    return (
      <Callout tone="error" title="The receipt didn't load">
        <p>
          Check your connection, then{" "}
          <TextLinkButton onClick={onRetry}>try again</TextLinkButton>.
        </p>
      </Callout>
    );
  }
  return <Skel width="100%" height={280} />;
}

/**
 * One expense in the right side sheet, stepping through the rows shown
 * (`rows`, in their sort). It opens from a row or from `?expenseId=`; an
 * expense that isn't loaded in the list still shows, from its detail.
 */
export function ExpenseSheet({
  organizationId,
  openId,
  rows,
  onOpen,
  onClose,
}: {
  organizationId: string;
  openId: string | null;
  rows: readonly Expense[];
  onOpen: (id: string) => void;
  onClose: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const detail = useQuery({
    queryKey: queryKeys.expense(organizationId, openId ?? ""),
    queryFn: () => api.getExpense(organizationId, openId ?? ""),
    enabled: openId !== null,
  });
  const ids = rows.map((row) => row.id);
  const index = openId ? ids.indexOf(openId) : -1;
  const expense = rows.find((row) => row.id === openId) ?? detail.data;
  const status = expense ? EXPENSE_STATUS[expense.status] : null;

  return (
    <DetailSheet
      open={openId !== null}
      onClose={onClose}
      eyebrow={expense ? eyebrowOf(expense) : "Expense"}
      title={expense?.merchant ?? "Loading…"}
      stepKey={openId ?? undefined}
      headerExtra={
        expense && status ? (
          <>
            <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
              <Money amount={expense.amountKes} currency="KES" />
            </p>
            <StatusBadge tone={status.tone} className="mt-2">
              {status.label}
            </StatusBadge>
          </>
        ) : null
      }
      stepper={{
        index,
        total: ids.length,
        onStep: (delta) => {
          const next = ids[index + delta];
          if (next) onOpen(next);
        },
        previousLabel: "Previous expense",
        nextLabel: "Next expense",
      }}
      footer={
        index >= 0 || (expense && isInApprovals(expense)) ? (
          <>
            {index >= 0 ? (
              <span className="text-muted-foreground tabular-nums">
                {index + 1} of {ids.length}
              </span>
            ) : null}
            {expense && isInApprovals(expense) ? (
              <div className="ml-auto">
                <Button asChild variant="outline" size="md">
                  <Link href="/approvals">
                    Open in Approvals
                    <ArrowRightIcon aria-hidden="true" />
                  </Link>
                </Button>
              </div>
            ) : null}
          </>
        ) : null
      }
    >
      {expense ? (
        <ExpenseDetails
          expense={expense}
          receipts={
            <ReceiptSection
              expense={expense}
              receipts={detail.data?.receipts}
              failed={detail.isError}
              onRetry={() => void detail.refetch()}
            />
          }
        />
      ) : detail.isError ? (
        <Callout tone="error" title="This expense didn't load">
          <p>
            Check your connection, then{" "}
            <TextLinkButton onClick={() => void detail.refetch()}>
              try again
            </TextLinkButton>
            .
          </p>
        </Callout>
      ) : (
        <>
          <Skel width="45%" height={20} />
          <Skel width="100%" height={280} />
        </>
      )}
    </DetailSheet>
  );
}
