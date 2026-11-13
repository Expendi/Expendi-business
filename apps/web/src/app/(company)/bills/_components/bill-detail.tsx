"use client";

import type { JSX, ReactNode } from "react";
import { BanIcon, KeyRoundIcon, PencilIcon, RotateCcwIcon } from "lucide-react";
import Link from "next/link";

import type { Bill, BillDetail, BillStatus } from "@expendi-business/shared";
import {
  describeSchedule,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import { TextLinkButton, textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { isPayable, unpayableReason } from "~/features/bills/bill-payment";
import {
  BillAmount,
  BillStatusBadge,
  headingLabel,
} from "~/features/bills/bill-status";
import { METHOD_LABELS } from "~/features/payees/payee-display";
import { formatIsoDate, formatNairobiDate } from "~/lib/dates";
import { BillFiles } from "./bill-files";

export type BillAction = "edit" | "paid_outside" | "cancel" | "invoice";

export const isUnpaid = (status: BillStatus): boolean =>
  (UNPAID_BILL_STATUSES as readonly BillStatus[]).includes(status);

export const needsAmount = (bill: Bill): boolean =>
  bill.currency === "usd" ? bill.amountUsdc === null : bill.amountKes === null;

/** "Recurring payment · variable amount", above the payee's name. */
export function billEyebrow(bill: Bill): string {
  const kind = bill.recurringItemId
    ? "Recurring payment"
    : bill.payrollRunId
      ? "Payroll"
      : "Bill";
  return bill.variable ? `${kind} · variable amount` : kind;
}

/** Under the sheet's title: the amount, then the status. */
export function BillSheetHeader({
  bill,
  rate,
}: {
  bill: Bill;
  rate: string | null;
}): JSX.Element {
  return (
    <>
      <div className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
        <BillAmount bill={bill} rate={rate} size="sheet" />
      </div>
      <BillStatusBadge status={bill.status} className="mt-2" />
    </>
  );
}

const personName = (who: BillDetail["markedPaidBy"]): string =>
  who ? (who.name ?? who.email) : "";

/**
 * One bill: why it can't be paid yet or why its payment failed, its
 * details, a link to its recurring payment, and its files.
 */
export function BillDetailBody({
  bill,
  error,
  errorAction,
  onSeeRecurring,
}: {
  bill: BillDetail;
  /** A payment that couldn't start, e.g. the network dropped. */
  error: string | null;
  /** Beside the error, e.g. the offer to move Treasury money to the wallet. */
  errorAction?: ReactNode;
  onSeeRecurring: (itemId: string) => void;
}): JSX.Element {
  const reason = unpayableReason(bill);
  const failure = bill.payout?.failureReason ?? null;
  return (
    <>
      {bill.cancelledReason ? (
        <Callout tone="neutral" icon={BanIcon}>
          <p>
            Cancelled
            {bill.cancelledBy
              ? ` by ${personName(bill.cancelledBy)}`
              : ""}: {bill.cancelledReason}
          </p>
        </Callout>
      ) : null}
      {bill.status === "payout_failed" ? (
        <Callout tone="error" title="Payment failed">
          {failure ? <p>{failure}</p> : null}
        </Callout>
      ) : null}
      {reason ? (
        <Callout tone="warn">
          <p>{reason}</p>
        </Callout>
      ) : null}
      {error ? (
        <Callout tone="error" action={errorAction}>
          <p>{error}</p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label="Due">{formatIsoDate(bill.dueOn)}</DetailItem>
        {bill.recurring ? (
          <DetailItem
            label="Schedule"
            sub={
              <TextLinkButton
                className="mt-0.5"
                onClick={() => {
                  if (bill.recurring) onSeeRecurring(bill.recurring.id);
                }}
              >
                See recurring payment
              </TextLinkButton>
            }
          >
            {describeSchedule(
              bill.recurring.schedule,
              bill.recurring.scheduleDay,
              bill.recurring.startsOn,
            )}
          </DetailItem>
        ) : null}
        <DetailItem label="Paid by">
          {bill.payee.method ? METHOD_LABELS[bill.payee.method] : "Not set"}
        </DetailItem>
        <DetailItem label="Overview heading">
          {headingLabel(bill.overviewHeading)}
        </DetailItem>
        <DetailItem label="Category">{bill.category.name}</DetailItem>
        {bill.reference ? (
          <DetailItem label="Reference">{bill.reference}</DetailItem>
        ) : null}
        {bill.paidOn ? (
          <DetailItem label="Paid on">{formatIsoDate(bill.paidOn)}</DetailItem>
        ) : null}
        {bill.paidFromAccount ? (
          <DetailItem label="Paid from">{bill.paidFromAccount.name}</DetailItem>
        ) : null}
        {bill.markedPaidBy ? (
          <DetailItem label="Marked paid by">
            {personName(bill.markedPaidBy)}
          </DetailItem>
        ) : null}
        {bill.paidOutsideNote ? (
          <DetailItem label="Payment note">{bill.paidOutsideNote}</DetailItem>
        ) : null}
        {bill.adjustmentReason ? (
          <DetailItem label="Why the amount changed">
            {bill.adjustmentReason}
          </DetailItem>
        ) : null}
        {bill.cancelledAt ? (
          <DetailItem label="Cancelled">
            {formatNairobiDate(bill.cancelledAt)}
          </DetailItem>
        ) : null}
      </DetailList>
      {bill.notes ? (
        <p className="whitespace-pre-wrap text-secondary-foreground">
          {bill.notes}
        </p>
      ) : null}
      <SectionLabel>{bill.files.length > 1 ? "Files" : "File"}</SectionLabel>
      <BillFiles files={bill.files} />
    </>
  );
}

/** While the bill loads: its details' shape. */
export function BillDetailSkeleton(): JSX.Element {
  return (
    <div aria-busy="true" className="flex flex-col gap-4">
      <p className="sr-only" role="status">
        Loading the bill…
      </p>
      {[0, 1, 2, 3, 4].map((row) => (
        <div key={row} className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3">
          <Skel width="60%" height={14} />
          <Skel width="45%" height={14} />
        </div>
      ))}
      <Skel width="100%" height={160} />
    </div>
  );
}

/**
 * An unpaid bill's actions for an admin: pay or retry it, edit it (a
 * variable bill's amount goes in here), add an invoice, mark it paid
 * outside Expendi or cancel it. Accountants see why there are none.
 */
export function BillDetailFooter({
  bill,
  canAct,
  canPay,
  needsPasskey,
  preparing,
  paymentBusy,
  index,
  total,
  onPay,
  onAction,
}: {
  bill: Bill;
  canAct: boolean;
  /** An admin with an approval passkey. */
  canPay: boolean;
  /** An admin who hasn't set up their approval passkey yet. */
  needsPasskey: boolean;
  /** Working out the cost of this bill's payment. */
  preparing: boolean;
  /** A payment is being prepared or reviewed, so Pay waits. */
  paymentBusy: boolean;
  index: number;
  total: number;
  onPay: () => void;
  onAction: (action: BillAction) => void;
}): JSX.Element {
  const position = <SheetPosition index={index} total={total} />;
  if (!canAct) {
    return (
      <>
        <ReadOnlyNote>View only. Only admins add and pay bills.</ReadOnlyNote>
        {position}
      </>
    );
  }
  if (bill.payrollRunId !== null) {
    return (
      <>
        <p className="text-sm text-muted-foreground">
          Paid with its payroll run, under{" "}
          <Link href="/payroll" className={textLinkClass}>
            Payroll
          </Link>
          .
        </p>
        {position}
      </>
    );
  }
  if (!isUnpaid(bill.status)) return position;

  const payable = isPayable(bill);
  const retry = bill.status === "payout_failed";
  return (
    <>
      <SheetActions kind="primary">
        {payable && canPay ? (
          <Button disabled={paymentBusy} onClick={onPay}>
            {preparing ? (
              "Working out the cost…"
            ) : retry ? (
              <>
                <RotateCcwIcon aria-hidden="true" />
                Retry payment
              </>
            ) : (
              <>
                <KeyRoundIcon aria-hidden="true" />
                Pay
              </>
            )}
          </Button>
        ) : null}
        <Button
          variant={payable ? "outline" : "default"}
          onClick={() => onAction("edit")}
        >
          <PencilIcon aria-hidden="true" />
          {needsAmount(bill) ? "Enter the amount" : "Edit bill"}
        </Button>
      </SheetActions>
      <SheetActions kind="secondary">
        <Button variant="ghost" size="md" onClick={() => onAction("invoice")}>
          Add invoice
        </Button>
        {needsAmount(bill) ? null : (
          <Button
            variant="ghost"
            size="md"
            onClick={() => onAction("paid_outside")}
          >
            Mark paid outside
          </Button>
        )}
        <Button variant="danger" size="md" onClick={() => onAction("cancel")}>
          Cancel bill
        </Button>
      </SheetActions>
      {payable && needsPasskey ? (
        <ReadOnlyNote icon={KeyRoundIcon} wide>
          Paying needs your approval passkey.
        </ReadOnlyNote>
      ) : null}
    </>
  );
}
