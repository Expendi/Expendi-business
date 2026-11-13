"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { CheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";

import type { WalletHistoryItem } from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import type { SheetStepper } from "~/components/data/detail-sheet";
import {
  DetailItem,
  DetailList,
  DetailSheet,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { PaymentReceiptItems } from "~/components/data/payment-receipts";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { addressGroups, shortAddress } from "~/features/chain-display";
import { formatKes } from "~/lib/money";
import { approxKes, SignedUsdc } from "./balance-card";
import {
  approvedAlongside,
  happenedAt,
  nairobiTime,
  PAYOUT_STATUS,
  payoutPurpose,
  txKind,
  txTitle,
} from "./wallet-display";

/**
 * An address set out so it can be checked by eye: a Base address or a
 * 64-character NEAR account in groups of four, a named account whole.
 */
export function GroupedAddress({ address }: { address: string }): JSX.Element {
  const { prefix, groups } = addressGroups(address);
  return (
    <span className="flex flex-wrap gap-x-[7px] gap-y-0.5 tracking-[0.02em] [overflow-wrap:anywhere] tabular-nums">
      {prefix ? <span className="text-muted-foreground">{prefix}</span> : null}
      {groups.map((group, index) => (
        <span key={`${String(index)}-${group}`}>{group}</span>
      ))}
    </span>
  );
}

/** One movement in the wallet's history, in the side sheet. */
export function TxSheet({
  item,
  items,
  today,
  rate,
  stepper,
  onClose,
}: {
  item: WalletHistoryItem | null;
  /** Every loaded row, to find payments approved together. */
  items: readonly WalletHistoryItem[];
  today: string;
  rate: string | null;
  stepper: SheetStepper;
  onClose: () => void;
}): JSX.Element {
  const kind = item ? txKind(item) : null;
  const status = item?.payout ? PAYOUT_STATUS[item.payout.status] : null;
  const isPayment = kind === "payment" || kind === "salary";
  return (
    <DetailSheet
      open={item !== null}
      onClose={onClose}
      stepKey={item?.id}
      eyebrow={item ? eyebrowFor(item) : undefined}
      title={item ? sheetTitle(item) : ""}
      headerExtra={
        item ? (
          <div className="mt-1 flex flex-col items-start gap-1">
            <p className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
              <SignedUsdc amount={item.usdcAmount} tint />
            </p>
            {isPayment && status ? (
              <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
            ) : null}
          </div>
        ) : null
      }
      stepper={stepper}
      footer={
        item ? (
          <>
            <SheetActions kind="primary">{subjectLinks(item)}</SheetActions>
            <SheetPosition index={stepper.index} total={stepper.total} />
          </>
        ) : null
      }
    >
      {item ? (
        <TxDetails item={item} items={items} today={today} rate={rate} />
      ) : null}
    </DetailSheet>
  );
}

function eyebrowFor(item: WalletHistoryItem): string {
  switch (txKind(item)) {
    case "deposit":
      return "Deposit";
    case "topup":
      return "Top-up";
    case "withdrawal":
      return "Withdrawal";
    case "refund":
      return "Refund";
    case "to_treasury":
      return "Moved to Treasury";
    case "from_treasury":
      return "Moved to wallet";
    case "salary":
      return "Payroll payment";
    case "payment":
      return "Payment";
  }
}

function sheetTitle(item: WalletHistoryItem): string {
  switch (txKind(item)) {
    case "deposit":
    case "topup":
      return "Money in";
    case "refund":
      return `${item.payout?.recipientName ?? "A"} payment returned`;
    default:
      return item.payout?.recipientName ?? txTitle(item);
  }
}

function subjectLinks(item: WalletHistoryItem): ReactNode {
  const payout = item.payout;
  if (!payout || item.type !== "payout") return null;
  const links: { href: string; label: string }[] = [];
  if (payout.payrollRunId) {
    links.push({
      href: `/payroll?runId=${payout.payrollRunId}`,
      label: "Open payroll run",
    });
  } else if (payout.subjectType === "bill") {
    links.push({
      href: `/bills?billId=${payout.subjectId}`,
      label: "Open bill",
    });
  } else if (payout.subjectType === "claim") {
    links.push({
      href: `/approvals?claimId=${payout.subjectId}`,
      label: "Open reimbursement",
    });
  }
  return links.map((link) => (
    <Button key={link.href} asChild variant="outline" size="md">
      <Link href={link.href}>{link.label}</Link>
    </Button>
  ));
}

/** What the sheet says about one movement, by its kind. */
export function TxDetails({
  item,
  items,
  today,
  rate,
}: {
  item: WalletHistoryItem;
  items: readonly WalletHistoryItem[];
  today: string;
  rate: string | null;
}): JSX.Element {
  const payout = item.payout;
  const when = happenedAt(item.createdAt, today);
  const transaction = item.txHash ? (
    <DetailItem label={`${PAYEE_CHAIN_NAMES[item.chain]} transaction`}>
      {shortAddress(item.txHash)}
    </DetailItem>
  ) : null;
  switch (txKind(item)) {
    case "deposit":
    case "topup": {
      const kes = approxKes(item.usdcAmount, rate);
      return (
        <DetailList>
          {item.counterpartyAddress ? (
            <DetailItem label="From">
              <GroupedAddress address={item.counterpartyAddress} />
            </DetailItem>
          ) : null}
          <DetailItem label="Chain">{PAYEE_CHAIN_NAMES[item.chain]}</DetailItem>
          <DetailItem label="Received">{when}</DetailItem>
          {kes ? (
            <DetailItem label="About">
              KES {kes} at today&apos;s rate
            </DetailItem>
          ) : null}
          {transaction}
        </DetailList>
      );
    }
    case "withdrawal":
      return (
        <DetailList>
          <DetailItem label="To">
            {payout ? (
              <GroupedAddress address={payout.recipientDetail} />
            ) : (
              "An allowed address"
            )}
          </DetailItem>
          <DetailItem label="Payee chain">
            {PAYEE_CHAIN_NAMES[payout?.recipientChain ?? item.chain]}
          </DetailItem>
          <DetailItem label="Network fee">Paid by Expendi</DetailItem>
          <DetailItem label="Sent">{when}</DetailItem>
          {payout?.approvedAt ? (
            <DetailItem label="Approved">
              {happenedAt(payout.approvedAt, today)}, with passkey
            </DetailItem>
          ) : null}
          {payout?.failureReason ? (
            <DetailItem label="Why it failed">
              {payout.failureReason}
            </DetailItem>
          ) : null}
          {transaction}
        </DetailList>
      );
    case "to_treasury":
    case "from_treasury":
      return (
        <DetailList>
          <DetailItem label="Chain">{PAYEE_CHAIN_NAMES[item.chain]}</DetailItem>
          <DetailItem label="When">{when}</DetailItem>
          {transaction}
        </DetailList>
      );
    case "refund":
      return (
        <>
          <Note>
            The {payout?.recipientName ?? ""} payment failed, so the USDC came
            back to the wallet. Nothing else needs doing unless you want to pay
            it again.
          </Note>
          <DetailList>
            {payout?.failureReason ? (
              <DetailItem label="Why it failed">
                {payout.failureReason}
              </DetailItem>
            ) : null}
            <DetailItem label="Returned">{when}</DetailItem>
            {transaction}
          </DetailList>
        </>
      );
    case "payment":
    case "salary": {
      const alongside = approvedAlongside(item, items);
      return (
        <>
          <PaymentSteps item={item} />
          <DetailList>
            {payout ? (
              <DetailItem label="In KES">
                <span className="tabular-nums">
                  <span className="text-[0.72em] font-(--w-ui) tracking-[0.04em] text-muted-foreground">
                    KES
                  </span>{" "}
                  {formatKes(payout.amountKesCents)}
                </span>
              </DetailItem>
            ) : null}
            {payout?.rate ? (
              <DetailItem label="Rate">KES {payout.rate} per USDC</DetailItem>
            ) : null}
            {payout ? (
              <DetailItem label="Paid to">
                {payout.method === "usdc" ? (
                  <GroupedAddress address={payout.recipientDetail} />
                ) : (
                  payout.recipientDetail
                )}
              </DetailItem>
            ) : null}
            {payout?.recipientChain ? (
              <DetailItem label="Payee chain">
                {PAYEE_CHAIN_NAMES[payout.recipientChain]}
              </DetailItem>
            ) : null}
            {payoutPurpose(item) ? (
              <DetailItem label="For">{payoutPurpose(item)}</DetailItem>
            ) : null}
            {payout?.approvedAt ? (
              <DetailItem label="Approved">
                {happenedAt(payout.approvedAt, today)}
              </DetailItem>
            ) : null}
            {alongside > 0 ? (
              <DetailItem label="Approved with">
                {alongside === 1
                  ? "1 other payment, one passkey"
                  : `${String(alongside)} other payments, one passkey`}
              </DetailItem>
            ) : null}
            {payout?.paidAt ? (
              <DetailItem label="Paid">
                {happenedAt(payout.paidAt, today)}
              </DetailItem>
            ) : null}
            {payout ? (
              <PaymentReceiptItems receipts={payout.paymentReceipts} />
            ) : null}
            {transaction}
          </DetailList>
        </>
      );
    }
  }
}

function Note({ children }: { children: ReactNode }): JSX.Element {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <InfoIcon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <span>{children}</span>
    </p>
  );
}

type StepState = "done" | "current" | "pending" | "failed";

interface Step {
  readonly label: string;
  readonly state: StepState;
  readonly time: string | null;
  readonly sub?: string;
}

/** Approved, sending, on its way and paid, or where it failed. */
export function paymentSteps(item: WalletHistoryItem): Step[] {
  const payout = item.payout;
  if (!payout) return [];
  const approved = {
    label: "Approved",
    state: "done" as const,
    time: payout.approvedAt ? nairobiTime(payout.approvedAt) : null,
  };
  const sent = nairobiTime(item.createdAt);
  if (payout.status === "failed") {
    return [
      approved,
      { label: "Sending", state: "done", time: sent },
      {
        label: "Failed",
        state: "failed",
        time: null,
        sub: `${payout.failureReason ? `${payout.failureReason} ` : ""}The money came back to the wallet.`,
      },
    ];
  }
  const reached =
    payout.status === "paid"
      ? 4
      : payout.status === "paying" || payout.status === "needs_review"
        ? 2
        : 1;
  const steps: { label: string; time: string | null }[] = [
    approved,
    { label: "Sending", time: sent },
    {
      label: payout.status === "needs_review" ? "Being checked" : "On its way",
      time: null,
    },
    {
      label: "Paid",
      time: payout.paidAt ? nairobiTime(payout.paidAt) : null,
    },
  ];
  return steps.map((step, index) => ({
    ...step,
    state: index < reached ? "done" : index === reached ? "current" : "pending",
    time: index <= reached ? step.time : null,
  }));
}

function PaymentSteps({ item }: { item: WalletHistoryItem }): JSX.Element {
  const steps = paymentSteps(item);
  return (
    <ol aria-label="Payment progress" className="m-0 list-none p-0">
      {steps.map((step, index) => (
        <li
          key={step.label}
          className={cn(
            "relative grid grid-cols-[20px_minmax(0,1fr)_auto] gap-3 pb-[18px] last:pb-0",
            index < steps.length - 1 &&
              "before:absolute before:top-[22px] before:bottom-0.5 before:left-[9px] before:w-0.5 before:rounded-[1px]",
            index < steps.length - 1 &&
              (step.state === "done"
                ? "before:bg-muted-foreground"
                : "before:bg-border"),
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "inline-flex size-5 items-center justify-center rounded-full border-2",
              step.state === "done" &&
                "border-foreground bg-foreground text-background",
              step.state === "current" &&
                "border-primary bg-card after:size-2 after:rounded-full after:bg-primary",
              step.state === "pending" && "border-input bg-card",
              step.state === "failed" &&
                "border-warn-600 bg-warn-50 text-warn-700",
            )}
          >
            {step.state === "done" ? (
              <CheckIcon className="size-3" strokeWidth={2.5} />
            ) : step.state === "failed" ? (
              <TriangleAlertIcon className="size-3" strokeWidth={2.5} />
            ) : null}
          </span>
          <span
            className={cn(
              "text-sm leading-5",
              step.state === "pending" && "text-muted-foreground",
              step.state === "failed" && "font-(--w-ui) text-warn-700",
            )}
          >
            {step.label}
            <span className="sr-only">
              {step.state === "current"
                ? ", in progress"
                : step.state === "pending"
                  ? ", not yet"
                  : ""}
            </span>
          </span>
          <span className="text-xs leading-5 text-muted-foreground tabular-nums">
            {step.time ?? ""}
          </span>
          {step.sub ? (
            <p className="col-start-2 col-end-4 -mt-0.5 text-xs leading-4 text-muted-foreground">
              {step.sub}
            </p>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
