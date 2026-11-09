"use client";

import type { JSX, ReactNode } from "react";
import { useId, useState } from "react";

import type { CardPurchase } from "@expendi-business/shared";
import { waiveCardReceiptRequestSchema } from "@expendi-business/shared";

import type { FieldErrors } from "~/app/(company)/payroll/_components/sheet-parts";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import {
  errorsByField,
  focusFirstError,
} from "~/app/(company)/payroll/_components/sheet-parts";
import { useCategories } from "~/app/(company)/payroll/_components/use-categories";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import { FormField, SheetForm, SheetNote } from "~/features/payment-ui";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useWaiveCardReceipt } from "./cards-api";
import {
  canWaiveReceipt,
  cardLabel,
  CHANGED_AFTER_EXPENSE_NOTE,
  formatUsd,
  PURCHASE_STATUS,
  purchaseAmount,
  REFUND_NOTE,
} from "./cards-display";
import { Usd } from "./usd";

/**
 * One Card purchase or refund. Admins can waive a recorded Card expense's
 * missing receipt; the waiver is the one thing that changes here.
 */
export function PurchaseSheet({
  organizationId,
  purchase,
  canAct,
  index,
  total,
  onStep,
  onClose,
}: {
  organizationId: string;
  purchase: CardPurchase;
  canAct: boolean;
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
}): JSX.Element {
  const waive = useWaiveCardReceipt(organizationId);
  const [waiving, setWaiving] = useState(false);
  const formId = useId();
  const reasonId = useId();
  const categoryId = useId();
  const categories = useCategories(organizationId, { enabled: waiving });
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);

  const status = PURCHASE_STATUS[purchase.status];
  const amount = purchaseAmount(purchase);
  const refund = purchase.kind === "refund";

  function startWaiver() {
    waive.reset();
    setNotice(null);
    setErrors({});
    setReason("");
    setCategory(null);
    setWaiving(true);
  }

  function submitWaiver() {
    const parsed = waiveCardReceiptRequestSchema.safeParse({
      reason,
      categoryId:
        category && category !== purchase.category.id ? category : undefined,
    });
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(found, { reason: reasonId, categoryId });
      return;
    }
    setErrors({});
    waive.mutate(
      { purchaseId: purchase.id, ...parsed.data },
      {
        onSuccess: () => {
          setWaiving(false);
          setNotice("Saved. No receipt is needed for this purchase.");
        },
      },
    );
  }

  let footer: ReactNode = <SheetPosition index={index} total={total} />;
  if (!canAct) {
    footer = (
      <>
        <ReadOnlyNote>View only. Only admins waive receipts.</ReadOnlyNote>
        <SheetPosition index={index} total={total} />
      </>
    );
  } else if (waiving) {
    footer = (
      <SheetActions kind="primary">
        <Button type="submit" form={formId} disabled={waive.isPending}>
          {waive.isPending ? "Saving…" : "Record no receipt"}
        </Button>
        <Button
          variant="outline"
          disabled={waive.isPending}
          onClick={() => setWaiving(false)}
        >
          Back
        </Button>
      </SheetActions>
    );
  } else if (canWaiveReceipt(purchase)) {
    footer = (
      <>
        <SheetActions kind="primary">
          <Button variant="outline" size="md" onClick={startWaiver}>
            No receipt
          </Button>
        </SheetActions>
        <SheetPosition index={index} total={total} />
      </>
    );
  }

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!waive.isPending}
      eyebrow={refund ? "Refund" : "Card purchase"}
      title={purchase.merchant}
      stepKey={purchase.id}
      headerExtra={
        <>
          <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
            <Usd
              cents={amount.cents}
              plus={refund}
              className={refund ? "text-success-700" : undefined}
            />
          </p>
          <span className="mt-2 flex flex-wrap items-center gap-1">
            {refund ? <StatusBadge tone="moving">Refund</StatusBadge> : null}
            <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
          </span>
        </>
      }
      stepper={{
        index,
        total,
        onStep: (delta) => {
          setWaiving(false);
          setNotice(null);
          onStep(delta);
        },
        previousLabel: "Previous purchase",
        nextLabel: "Next purchase",
      }}
      footer={footer}
    >
      {notice ? (
        <div role="status">
          <Callout tone="success">
            <p>{notice}</p>
          </Callout>
        </div>
      ) : null}
      {refund ? (
        <Callout tone="neutral" title="Refund">
          <p>{REFUND_NOTE}</p>
        </Callout>
      ) : null}
      {purchase.changedAfterExpense ? (
        <Callout tone="warn" title="Changed after it was recorded">
          <p>{CHANGED_AFTER_EXPENSE_NOTE}</p>
        </Callout>
      ) : null}
      {purchase.needsReceipt && !waiving ? (
        <Callout tone="warn" title="Needs a receipt">
          <p>
            {purchase.expenseId
              ? `Waiting for ${personName(purchase.holder)} to add one. It stays out of the books until it has one or an admin waives it.`
              : "It can be waived once it settles and its Card expense is recorded."}
          </p>
        </Callout>
      ) : null}

      <DetailList>
        <DetailItem label="Cardholder" sub={purchase.holder.email}>
          {personName(purchase.holder)}
        </DetailItem>
        <DetailItem label="Card">{cardLabel(purchase.card)}</DetailItem>
        <DetailItem label="Date">
          {formatNairobiDateTime(purchase.authorizedAt)}
        </DetailItem>
        <DetailItem label="Category">{purchase.category.name}</DetailItem>
        <DetailItem label="Merchant code">{purchase.mcc}</DetailItem>
        {BigInt(purchase.holdUsdCents) > 0n ? (
          <DetailItem label="On hold">
            {formatUsd(purchase.holdUsdCents)}
          </DetailItem>
        ) : null}
        <DetailItem label="Settled">
          {formatUsd(purchase.settledUsdCents)}
        </DetailItem>
        {purchase.amountKes !== null ? (
          <DetailItem
            label="In KES"
            sub={
              purchase.usdKesRate
                ? `At KES ${purchase.usdKesRate} per USD`
                : undefined
            }
          >
            <Money amount={purchase.amountKes} currency="KES" />
          </DetailItem>
        ) : null}
        {purchase.declineReason ? (
          <DetailItem label="Why it was declined">
            {purchase.declineReason}
          </DetailItem>
        ) : null}
        <DetailItem label="Receipts">
          {purchase.receiptCount > 0
            ? String(purchase.receiptCount)
            : purchase.noReceiptReason
              ? "Waived"
              : "None"}
        </DetailItem>
        {purchase.noReceiptReason ? (
          <DetailItem label="Why no receipt">
            {purchase.noReceiptReason}
          </DetailItem>
        ) : null}
      </DetailList>

      {waiving ? (
        <SheetForm id={formId} label="No receipt" onSubmit={submitWaiver}>
          <FormField
            id={reasonId}
            label="Why there's no receipt"
            error={errors.reason}
          >
            <Textarea
              id={reasonId}
              value={reason}
              disabled={waive.isPending}
              aria-invalid={errors.reason ? true : undefined}
              onChange={(event) => {
                setReason(event.target.value);
                setErrors((current) => ({ ...current, reason: undefined }));
              }}
            />
          </FormField>
          <FormField
            id={categoryId}
            label="Category"
            help="You can change it now, once. It can't change after this."
            error={errors.categoryId}
          >
            <NativeSelect
              id={categoryId}
              className="w-full"
              value={category ?? purchase.category.id}
              disabled={waive.isPending || categories.isPending}
              onChange={(event) => setCategory(event.target.value)}
            >
              <NativeSelectOption value={purchase.category.id}>
                {purchase.category.name}
              </NativeSelectOption>
              {(categories.data ?? [])
                .filter((option) => option.id !== purchase.category.id)
                .map((option) => (
                  <NativeSelectOption key={option.id} value={option.id}>
                    {option.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
          </FormField>
          <SheetNote>
            The Card expense can then reach the books without a receipt.
          </SheetNote>
          {waive.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(waive.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      ) : null}
    </DetailSheet>
  );
}
