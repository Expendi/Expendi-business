"use client";

import type { UseMutationResult } from "@tanstack/react-query";
import type { JSX, ReactNode } from "react";
import { MessageCircleQuestionIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import type {
  CardPurchase,
  ExpendiCard,
  ReviewCardPurchaseRequest,
} from "@expendi-business/shared";
import {
  attachCardReceiptRequestSchema,
  MAX_RECEIPTS_PER_CLAIM,
  reviewCardPurchaseRequestSchema,
  waiveCardReceiptRequestSchema,
} from "@expendi-business/shared";

import type { ReviewPurchaseVariables } from "./cards-api";
import type { UploadedBillFile } from "~/app/(company)/bills/_components/bill-files-input";
import type { FieldErrors } from "~/app/(company)/payroll/_components/sheet-parts";
import { BillFilesInput } from "~/app/(company)/bills/_components/bill-files-input";
import {
  errorsByField,
  focusFirstError,
} from "~/app/(company)/payroll/_components/sheet-parts";
import { useCategories } from "~/app/(company)/payroll/_components/use-categories";
import { textLinkClass } from "~/components/data/actions";
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
import { FieldError } from "~/components/ui/field";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import {
  ChoiceGroup,
  ChoiceOption,
  FormField,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { STATE_LABELS } from "~/features/recurring/recurring-draft";
import { describeApiError } from "~/lib/api";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import {
  useAttachCardReceipt,
  useCards,
  useFreezeCard,
  useReviewCardPurchase,
  useWaiveCardReceipt,
} from "./cards-api";
import {
  ANSWER_LABELS,
  answerRequest,
  answerSavedText,
  asksForReceipt,
  canAddReceipt,
  canAnswer,
  canWaiveReceipt,
  cardLabel,
  CHANGED_AFTER_EXPENSE_NOTE,
  formatUsd,
  holderName,
  matchedPaymentOf,
  NEEDS_ANSWER,
  needsAnswer,
  paymentsDeclinedWhenFrozen,
  PURCHASE_STATUS,
  purchaseAmount,
  REFUND_NOTE,
} from "./cards-display";
import { Usd } from "./usd";

type Step = "details" | "waive" | "answer" | "receipt";

/** What the sheet says once an answer is saved; `freeze` offers to freeze the card next. */
interface Saved {
  readonly text: string;
  readonly freeze: boolean;
}

/**
 * One Card purchase or refund. Admins can waive a recorded Card expense's
 * missing receipt, add a company-held card purchase's receipt, and say
 * once what a company-held card's purchase from a new merchant is (spec
 * §6.25).
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
  const review = useReviewCardPurchase(organizationId);
  const freeze = useFreezeCard(organizationId);
  const attach = useAttachCardReceipt(organizationId);
  const cards = useCards(organizationId);
  const [step, setStep] = useState<Step>("details");
  const formId = useId();
  const answerFormId = useId();
  const receiptFormId = useId();
  const reasonId = useId();
  const categoryId = useId();
  const categories = useCategories(organizationId, {
    enabled: step === "waive" || step === "receipt",
  });
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [receipts, setReceipts] = useState<UploadedBillFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState<Saved | null>(null);

  const status = PURCHASE_STATUS[purchase.status];
  const amount = purchaseAmount(purchase);
  const refund = purchase.kind === "refund";
  const card = cards.data?.cards.find((one) => one.id === purchase.card.id);
  const matched = matchedPaymentOf(purchase);
  const busy =
    waive.isPending ||
    review.isPending ||
    freeze.isPending ||
    attach.isPending ||
    uploading;

  function goTo(next: Step) {
    waive.reset();
    review.reset();
    freeze.reset();
    attach.reset();
    setNotice(null);
    setSaved(null);
    setErrors({});
    setStep(next);
  }

  function startWaiver() {
    setReason("");
    setCategory(null);
    goTo("waive");
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
          setStep("details");
          setNotice("Saved. No receipt is needed for this purchase.");
        },
      },
    );
  }

  function startReceipt() {
    setReceipts([]);
    setCategory(null);
    goTo("receipt");
  }

  function submitReceipt() {
    const parsed = attachCardReceiptRequestSchema.safeParse({
      receiptFileIds: receipts.map((file) => file.id),
      categoryId:
        category && category !== purchase.category.id ? category : undefined,
    });
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(found, { categoryId });
      return;
    }
    setErrors({});
    attach.mutate(
      { purchaseId: purchase.id, ...parsed.data },
      {
        onSuccess: (withReceipt) => {
          setStep("details");
          setNotice(
            withReceipt.expenseId
              ? "Receipt added. Its Card expense can now reach the books."
              : "Receipt added. It goes on the Card expense once the purchase settles.",
          );
        },
      },
    );
  }

  function answered(
    request: ReviewCardPurchaseRequest,
    payeeName: string,
    answer: CardPurchase,
  ) {
    setStep("details");
    setSaved({
      text: answerSavedText(request, answer, payeeName),
      freeze:
        answer.match?.state === "not_recognised" && card?.state === "open",
    });
  }

  function freezeCard() {
    freeze.mutate(purchase.card.id, {
      onSuccess: () => {
        setSaved(null);
        setNotice("Card frozen. New purchases are declined.");
      },
    });
  }

  const position = <SheetPosition index={index} total={total} />;
  let footer: ReactNode = position;
  if (!canAct) {
    footer = (
      <>
        <ReadOnlyNote>
          {canAnswer(purchase)
            ? "View only. Only admins answer for purchases and waive receipts."
            : "View only. Only admins waive receipts."}
        </ReadOnlyNote>
        {position}
      </>
    );
  } else if (step === "waive") {
    footer = (
      <SheetActions kind="primary">
        <Button type="submit" form={formId} disabled={busy}>
          {waive.isPending ? "Saving…" : "Record no receipt"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => goTo("details")}
        >
          Back
        </Button>
      </SheetActions>
    );
  } else if (step === "answer") {
    footer = (
      <SheetActions kind="primary">
        <Button type="submit" form={answerFormId} disabled={busy}>
          {review.isPending ? "Saving…" : "Save answer"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => goTo("details")}
        >
          Back
        </Button>
      </SheetActions>
    );
  } else if (step === "receipt") {
    footer = (
      <SheetActions kind="primary">
        <Button
          type="submit"
          form={receiptFormId}
          disabled={busy || receipts.length === 0}
        >
          {attach.isPending ? "Saving…" : "Save receipt"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => goTo("details")}
        >
          Back
        </Button>
      </SheetActions>
    );
  } else if (
    canAnswer(purchase) ||
    canWaiveReceipt(purchase) ||
    canAddReceipt(purchase)
  ) {
    footer = (
      <>
        <SheetActions kind="primary">
          {canAnswer(purchase) ? (
            <Button
              variant={needsAnswer(purchase) ? "default" : "outline"}
              size="md"
              onClick={() => goTo("answer")}
            >
              {needsAnswer(purchase) ? "Answer" : "Change answer"}
            </Button>
          ) : null}
          {canAddReceipt(purchase) ? (
            <Button size="md" onClick={startReceipt}>
              Add receipt
            </Button>
          ) : null}
          {canWaiveReceipt(purchase) ? (
            <Button variant="outline" size="md" onClick={startWaiver}>
              No receipt
            </Button>
          ) : null}
        </SheetActions>
        {position}
      </>
    );
  }

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!busy}
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
            {needsAnswer(purchase) ? (
              <StatusBadge tone="waiting">{NEEDS_ANSWER}</StatusBadge>
            ) : null}
          </span>
        </>
      }
      stepper={{
        index,
        total,
        onStep: (delta) => {
          goTo("details");
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
      {saved ? (
        <SavedAnswer
          saved={saved}
          card={card}
          freezing={freeze.isPending}
          onFreeze={freezeCard}
        />
      ) : null}
      {freeze.isError ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApiError(freeze.error)}</p>
          </Callout>
        </div>
      ) : null}
      {needsAnswer(purchase) && step === "details" && !saved ? (
        <Callout
          tone="warn"
          icon={MessageCircleQuestionIcon}
          title={NEEDS_ANSWER}
        >
          <p>
            {cardLabel(purchase.card)} hadn&apos;t been charged by{" "}
            {purchase.merchant} before, so it went through and waits for an
            admin to say what it is.
          </p>
        </Callout>
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
      {asksForReceipt(purchase) && step !== "waive" && step !== "receipt" ? (
        <Callout tone="warn" title="Needs a receipt">
          <p>
            {purchase.expenseId
              ? purchase.companyHeld
                ? "Waiting for a receipt. It stays out of the books until it has one or an admin waives it."
                : `Waiting for ${holderName(purchase.holder)} to add one. It stays out of the books until it has one or an admin waives it.`
              : "It can be waived once it settles and its Card expense is recorded."}
          </p>
        </Callout>
      ) : null}

      <DetailList>
        <DetailItem label="Cardholder" sub={purchase.holder?.email}>
          {holderName(purchase.holder)}
        </DetailItem>
        <DetailItem label="Card">{cardLabel(purchase.card)}</DetailItem>
        {matched ? (
          <DetailItem
            label="Pays"
            sub={
              matched.billId ? (
                <Link
                  href={`/bills?billId=${matched.billId}`}
                  className={textLinkClass}
                >
                  Open the bill
                </Link>
              ) : (
                "Its bill is paid once the purchase settles."
              )
            }
          >
            {matched.payeeName}
          </DetailItem>
        ) : null}
        {purchase.match?.state === "one_off" ||
        purchase.match?.state === "not_recognised" ? (
          <DetailItem label="Answer">
            {ANSWER_LABELS[purchase.match.state]}
          </DetailItem>
        ) : null}
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
        {matched ? null : (
          <DetailItem label="Receipts">
            {purchase.receiptCount > 0
              ? String(purchase.receiptCount)
              : purchase.noReceiptReason
                ? "Waived"
                : "None"}
          </DetailItem>
        )}
        {purchase.noReceiptReason ? (
          <DetailItem label="Why no receipt">
            {purchase.noReceiptReason}
          </DetailItem>
        ) : null}
      </DetailList>

      {step === "answer" ? (
        <AnswerForm
          id={answerFormId}
          purchase={purchase}
          card={card}
          cardsLoading={cards.isPending}
          review={review}
          onAnswered={answered}
        />
      ) : null}

      {step === "receipt" ? (
        <SheetForm
          id={receiptFormId}
          label="Add receipt"
          onSubmit={submitReceipt}
        >
          <BillFilesInput
            organizationId={organizationId}
            label="Receipt"
            files={receipts}
            onChange={(files) => {
              setReceipts(files);
              setErrors((current) => ({
                ...current,
                receiptFileIds: undefined,
              }));
            }}
            onUploadingChange={setUploading}
            max={MAX_RECEIPTS_PER_CLAIM}
            disabled={attach.isPending}
            receipts
          />
          {errors.receiptFileIds ? (
            <FieldError>{errors.receiptFileIds}</FieldError>
          ) : null}
          <FormField
            id={categoryId}
            label="Category"
            help="You can change it now, with its first receipt. It can't change after this."
            error={errors.categoryId}
          >
            <NativeSelect
              id={categoryId}
              className="w-full"
              value={category ?? purchase.category.id}
              disabled={attach.isPending || categories.isPending}
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
          {attach.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApiError(attach.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      ) : null}

      {step === "waive" ? (
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

type Decision = ReviewCardPurchaseRequest["decision"];

/**
 * What a purchase from a merchant the card hadn't seen is: one of the
 * card's recurring payments, a one-off, or not recognised. The answer is
 * given once per merchant; a one-off can still change.
 */
export function AnswerForm({
  id,
  purchase,
  card,
  cardsLoading,
  review,
  onAnswered,
}: {
  id: string;
  purchase: CardPurchase;
  card: ExpendiCard | undefined;
  cardsLoading: boolean;
  review: UseMutationResult<CardPurchase, Error, ReviewPurchaseVariables>;
  /** With the purchase as the API saved it, which can differ from what was asked. */
  onAnswered: (
    request: ReviewCardPurchaseRequest,
    payeeName: string,
    answer: CardPurchase,
  ) => void;
}): JSX.Element {
  const name = useId();
  const paymentId = useId();
  const firstChoiceId = useId();
  const [decision, setDecision] = useState<Decision | null>(null);
  const [recurringItemId, setRecurringItemId] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const payments = (card?.recurringPayments ?? []).filter(
    (payment) => payment.state !== "ended",
  );
  const canLink = payments.length > 0;
  const canOneOff = purchase.match?.state !== "one_off";

  function choose(next: Decision) {
    setDecision(next);
    setErrors({});
  }

  function submit() {
    const parsed = reviewCardPurchaseRequestSchema.safeParse(
      answerRequest(decision, recurringItemId),
    );
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(found, {
        decision: firstChoiceId,
        recurringItemId: paymentId,
      });
      return;
    }
    setErrors({});
    const answer = parsed.data;
    const payee =
      answer.decision === "link"
        ? (payments.find((payment) => payment.id === answer.recurringItemId)
            ?.payeeName ?? "its recurring payment")
        : "";
    review.mutate(
      { purchaseId: purchase.id, review: answer },
      { onSuccess: (saved) => onAnswered(answer, payee, saved) },
    );
  }

  return (
    <SheetForm id={id} label="What this purchase is" onSubmit={submit}>
      <ChoiceGroup legend={`What is this purchase from ${purchase.merchant}?`}>
        <ChoiceOption
          id={canLink ? firstChoiceId : undefined}
          name={name}
          value="link"
          checked={decision === "link"}
          disabled={review.isPending || !canLink}
          title="It’s one of this card’s recurring payments"
          description={
            cardsLoading
              ? "Loading the card’s recurring payments…"
              : payments.length === 0
                ? "This card pays no recurring payment yet."
                : "It pays that payment’s bill, and later purchases from this merchant match on their own."
          }
          onChoose={() => choose("link")}
        />
        {decision === "link" ? (
          <FormField
            id={paymentId}
            label="Which recurring payment"
            error={errors.recurringItemId}
          >
            <NativeSelect
              id={paymentId}
              className="w-full"
              value={recurringItemId}
              disabled={review.isPending}
              aria-invalid={errors.recurringItemId ? true : undefined}
              onChange={(event) => {
                setRecurringItemId(event.target.value);
                setErrors({});
              }}
            >
              <NativeSelectOption value="">
                Choose a recurring payment
              </NativeSelectOption>
              {payments.map((payment) => (
                <NativeSelectOption key={payment.id} value={payment.id}>
                  {payment.payeeName}
                  {payment.state === "active"
                    ? ""
                    : ` (${STATE_LABELS[payment.state].label.toLowerCase()})`}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </FormField>
        ) : null}
        <ChoiceOption
          id={!canLink && canOneOff ? firstChoiceId : undefined}
          name={name}
          value="one_off"
          checked={decision === "one_off"}
          disabled={review.isPending || !canOneOff}
          title="It’s a one-off purchase"
          description="It stays a Card expense and needs a receipt."
          onChoose={() => choose("one_off")}
        />
        <ChoiceOption
          id={!canLink && !canOneOff ? firstChoiceId : undefined}
          name={name}
          value="not_recognised"
          checked={decision === "not_recognised"}
          disabled={review.isPending}
          title="I don’t recognise it"
          description="It stays a Card expense, and this merchant will be declined on this card from now on. You can freeze the card next."
          onChoose={() => choose("not_recognised")}
        />
      </ChoiceGroup>
      {errors.decision ? <FieldError>{errors.decision}</FieldError> : null}
      {review.isError ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApiError(review.error)}</p>
          </Callout>
        </div>
      ) : null}
    </SheetForm>
  );
}

/** The saved answer, and after "not recognised" the offer to freeze the card. */
export function SavedAnswer({
  saved,
  card,
  freezing,
  onFreeze,
}: {
  saved: Saved;
  card: ExpendiCard | undefined;
  freezing: boolean;
  onFreeze: () => void;
}): JSX.Element {
  const declined = card ? paymentsDeclinedWhenFrozen(card) : [];
  return (
    <div role="status">
      <Callout
        tone="success"
        action={
          saved.freeze ? (
            <Button
              variant="outline"
              size="md"
              disabled={freezing}
              onClick={onFreeze}
            >
              {freezing ? "Freezing…" : "Freeze this card"}
            </Button>
          ) : null
        }
      >
        <p>{saved.text}</p>
        {saved.freeze ? (
          <p>
            If it may have been misused, freeze the card.
            {declined.length > 0
              ? ` Freezing also declines its recurring payments: ${declined.map((payment) => payment.payeeName).join(", ")}.`
              : ""}
          </p>
        ) : null}
      </Callout>
    </div>
  );
}
