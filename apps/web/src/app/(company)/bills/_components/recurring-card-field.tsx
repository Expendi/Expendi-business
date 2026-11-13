"use client";

import type { JSX, KeyboardEvent } from "react";
import { KeyRoundIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import type {
  CardActionRequest,
  ExpendiCard,
  RecurringSchedule,
} from "@expendi-business/shared";
import {
  CARD_LIMIT_HEADROOM_PERCENT,
  CARD_NICKNAME_MAX_LENGTH,
  cardActionSchema,
  USDC_UNITS_PER_US_CENT,
} from "@expendi-business/shared";

import type { FieldErrors } from "~/app/(company)/payroll/_components/sheet-parts";
import {
  useCardProgram,
  useCompanyHeldCards,
  useIssueCompanyCard,
} from "~/app/(company)/cards/_components/cards-api";
import {
  CARD_STATE,
  formatUsd,
  maskedLastFour,
} from "~/app/(company)/cards/_components/cards-display";
import {
  errorsByField,
  focusFirstError,
} from "~/app/(company)/payroll/_components/sheet-parts";
import { useCategories } from "~/app/(company)/payroll/_components/use-categories";
import { textLinkClass } from "~/components/data/actions";
import { Callout } from "~/components/data/detail-sheet";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { FieldDescription } from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { parseTyped, toTyped } from "~/features/bills/bill-amount";
import {
  ChoiceGroup,
  ChoiceOption,
  FieldRow,
  FormField,
  PasskeySetupCallout,
  SheetNote,
} from "~/features/payment-ui";
import { useRecurringItems } from "~/features/recurring/recurring-api";
import {
  mostInOneMonthCents,
  otherCardPayments,
  suggestedCardLimitCents,
} from "~/features/recurring/recurring-draft";
import { describeApprovalError } from "~/lib/approval";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { LoadAgain } from "./load-again";

/** What the payment is, for the card's suggested limit and the new card's defaults. */
export interface CardPaymentContext {
  readonly payeeName: string | null;
  /** The estimate as typed, in USD; blank for none. */
  readonly estimate: string;
  readonly schedule: RecurringSchedule;
  readonly categoryId: string | null;
  /** The payment being edited, left out of its card's other payments. */
  readonly itemId: string | null;
}

/** "150.25" for 15025n, as the limit is typed. */
const typedUsd = (cents: bigint): string =>
  toTyped("usd", String(cents * USDC_UNITS_PER_US_CENT));

const estimateOf = (payment: CardPaymentContext) => ({
  amountUsdc: parseTyped("usd", payment.estimate),
  schedule: payment.schedule,
});

function paysLine(card: ExpendiCard): string {
  const names = card.recurringPayments.map((payment) => payment.payeeName);
  return names.length === 0
    ? "No recurring payments yet"
    : `Pays ${names.join(", ")}`;
}

/** A card issued from the form stays issued whether or not the payment is saved. */
export const issuedCardNote = (card: Pick<ExpendiCard, "lastFour">): string =>
  `Card ${maskedLastFour(card.lastFour)} was issued and is on the Cards page.`;

/**
 * Which company-held card pays a recurring payment (spec §6.20): one of the
 * company's cards that isn't closed, or a new one issued right here with
 * the admin's passkey, which is then picked.
 */
export function CompanyHeldCardField({
  organizationId,
  id,
  value,
  payment,
  issued,
  onChange,
  onIssued,
}: {
  organizationId: string;
  /** Goes on the first choice, so an error can move focus to it. */
  id: string;
  value: string | null;
  payment: CardPaymentContext;
  /** The card issued here during this edit, until the card list has it. */
  issued: ExpendiCard | null;
  onChange: (cardId: string | null) => void;
  onIssued: (card: ExpendiCard) => void;
}): JSX.Element {
  const name = useId();
  const program = useCardProgram(organizationId);
  const programOn = program.data?.status === "on";
  const cards = useCompanyHeldCards(organizationId, { enabled: programOn });
  const [issuing, setIssuing] = useState(false);

  if (program.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading cards…
      </p>
    );
  }
  if (program.isError) {
    return (
      <LoadAgain
        error={program.error}
        label="Load cards again"
        onRetry={() => void program.refetch()}
      />
    );
  }
  if (program.data.status === "off") {
    return (
      <FieldDescription>
        Company-held cards are Expendi cards, and cards aren&apos;t on for this
        company yet. Turn them on under{" "}
        <Link href="/cards" className={textLinkClass}>
          Cards
        </Link>
        , then come back to pick or issue one.
      </FieldDescription>
    );
  }
  if (cards.isPending) {
    return (
      <p role="status" className="text-muted-foreground">
        Loading cards…
      </p>
    );
  }
  if (cards.isError) {
    return (
      <LoadAgain
        error={cards.error}
        label="Load cards again"
        onRetry={() => void cards.refetch()}
      />
    );
  }

  const listed = cards.data.cards.filter(
    (card) => card.companyHeld && card.state !== "closed",
  );
  const choices =
    issued && !listed.some((card) => card.id === issued.id)
      ? [...listed, issued]
      : listed;
  const chosen = issuing
    ? undefined
    : choices.find((card) => card.id === value);
  const paused = program.data.paused;

  return (
    <div className="flex flex-col gap-2">
      <ChoiceGroup legend="Which card pays it">
        {choices.map((card, at) => (
          <ChoiceOption
            key={card.id}
            id={at === 0 ? id : undefined}
            name={name}
            value={card.id}
            checked={!issuing && value === card.id}
            title={card.nickname}
            badge={
              card.state === "frozen" ? (
                <StatusBadge tone={CARD_STATE.frozen.tone}>
                  {CARD_STATE.frozen.label}
                </StatusBadge>
              ) : null
            }
            description={`${maskedLastFour(card.lastFour)} · ${paysLine(card)}`}
            onChoose={() => {
              setIssuing(false);
              onChange(card.id);
            }}
          />
        ))}
        <ChoiceOption
          id={choices.length === 0 ? id : undefined}
          name={name}
          value="new"
          checked={issuing}
          disabled={paused}
          title="Issue a new card"
          description={
            paused
              ? "New cards are paused while Expendi has paused payouts for this company."
              : "A company-held card for this payment, confirmed with your passkey."
          }
          onChoose={() => {
            setIssuing(true);
            onChange(null);
          }}
        />
      </ChoiceGroup>
      {issued && chosen?.id === issued.id ? (
        <FieldDescription role="status">
          Card {maskedLastFour(issued.lastFour)} issued and selected.
        </FieldDescription>
      ) : null}
      {chosen?.state === "frozen" ? (
        <FieldDescription>
          This card is frozen: its Card purchases are declined until an admin
          unfreezes it under Cards.
        </FieldDescription>
      ) : null}
      {chosen ? (
        <LimitCheck
          organizationId={organizationId}
          card={chosen}
          payment={payment}
        />
      ) : null}
      {issuing ? (
        <IssueCompanyCard
          organizationId={organizationId}
          payment={payment}
          onIssued={(card) => {
            onIssued(card);
            setIssuing(false);
            onChange(card.id);
          }}
        />
      ) : null}
    </div>
  );
}

/** Says when the chosen card's limit won't cover the most its recurring payments can charge in a month. */
function LimitCheck({
  organizationId,
  card,
  payment,
}: {
  organizationId: string;
  card: ExpendiCard;
  payment: CardPaymentContext;
}): JSX.Element | null {
  const items = useRecurringItems(organizationId);
  if (!items.data) return null;
  const payments = [
    estimateOf(payment),
    ...otherCardPayments(items.data, card.id, payment.itemId),
  ];
  const most = mostInOneMonthCents(payments);
  const suggestion = suggestedCardLimitCents(payments);
  if (
    most === null ||
    suggestion === null ||
    BigInt(card.monthlyLimitUsdCents) >= most
  ) {
    return null;
  }
  return (
    <FieldDescription>
      Its monthly limit is {formatUsd(card.monthlyLimitUsdCents)}, but its
      recurring payments, this one included, can charge{" "}
      {formatUsd(most.toString())} in one month.{" "}
      {formatUsd(suggestion.toString())} is suggested. Raise it under{" "}
      <Link href={`/cards?id=${card.id}`} className={textLinkClass}>
        Cards
      </Link>
      .
    </FieldDescription>
  );
}

/**
 * A new company-held card, issued inside the recurring payment form: its
 * name (the payee's by default), a monthly limit suggested from the
 * estimate, and a default category (the payment's by default).
 */
export function IssueCompanyCard({
  organizationId,
  payment,
  onIssued,
}: {
  organizationId: string;
  payment: CardPaymentContext;
  onIssued: (card: ExpendiCard) => void;
}): JSX.Element {
  const action = useIssueCompanyCard(organizationId);
  const passkey = useApprovalPasskeyStatus();
  const categories = useCategories(organizationId);
  const ids = {
    nickname: useId(),
    monthlyLimitUsd: useId(),
    defaultCategoryId: useId(),
  };
  const [nickname, setNickname] = useState<string | null>(null);
  const [limit, setLimit] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});

  const suggestion = suggestedCardLimitCents([estimateOf(payment)]);
  const fields = {
    nickname: nickname ?? payment.payeeName ?? "",
    monthlyLimitUsd: limit ?? (suggestion === null ? "" : typedUsd(suggestion)),
    defaultCategoryId: category ?? payment.categoryId ?? "",
  };
  const ready = passkey.data?.enrolled === true;
  const busy = action.isPending;

  function clear(field: keyof typeof fields) {
    setErrors((current) => ({ ...current, [field]: undefined }));
  }

  function issue() {
    const request: CardActionRequest = {
      type: "issue_company_card",
      ...fields,
    };
    const parsed = cardActionSchema.safeParse(request);
    if (!parsed.success) {
      const found = errorsByField(parsed.error.issues);
      setErrors(found);
      focusFirstError(found, ids);
      return;
    }
    setErrors({});
    action.mutate(request, {
      onSuccess: (outcome) => {
        if (
          outcome.status === "approved" &&
          outcome.result.type === "issue_company_card"
        ) {
          onIssued(outcome.result.card);
        }
      },
    });
  }

  function issueOnEnter(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement)) {
      return;
    }
    // The fields sit inside the recurring payment's form; Enter issues the card instead.
    event.preventDefault();
    if (ready && !busy) issue();
  }

  return (
    <div
      role="group"
      aria-label="New company-held card"
      onKeyDown={issueOnEnter}
      className="flex flex-col gap-[18px] rounded-control bg-muted/60 px-4 py-3.5"
    >
      {passkey.data?.enrolled === false ? <PasskeySetupCallout /> : null}
      <FormField
        id={ids.nickname}
        label="Card name"
        help="Only your company sees this."
        error={errors.nickname}
      >
        <Input
          id={ids.nickname}
          maxLength={CARD_NICKNAME_MAX_LENGTH}
          autoComplete="off"
          value={fields.nickname}
          disabled={busy}
          aria-invalid={errors.nickname ? true : undefined}
          onChange={(event) => {
            setNickname(event.target.value);
            clear("nickname");
          }}
        />
      </FormField>
      <FieldRow>
        <FormField
          id={ids.monthlyLimitUsd}
          label="Monthly limit (USD)"
          help={
            suggestion === null
              ? "Spending stops at this amount each calendar month."
              : `Suggested: the most this payment can charge in one month, plus ${String(CARD_LIMIT_HEADROOM_PERCENT)}%.`
          }
          error={errors.monthlyLimitUsd}
        >
          <Input
            id={ids.monthlyLimitUsd}
            inputMode="decimal"
            autoComplete="off"
            placeholder="500.00"
            value={fields.monthlyLimitUsd}
            disabled={busy}
            className="tabular-nums"
            aria-invalid={errors.monthlyLimitUsd ? true : undefined}
            onChange={(event) => {
              setLimit(event.target.value);
              clear("monthlyLimitUsd");
            }}
          />
        </FormField>
        <FormField
          id={ids.defaultCategoryId}
          label="Default category"
          help="For a purchase that isn't one of its recurring payments."
          error={errors.defaultCategoryId}
        >
          <NativeSelect
            id={ids.defaultCategoryId}
            className="w-full"
            value={fields.defaultCategoryId}
            disabled={busy || categories.isPending}
            aria-invalid={errors.defaultCategoryId ? true : undefined}
            onChange={(event) => {
              setCategory(event.target.value);
              clear("defaultCategoryId");
            }}
          >
            <NativeSelectOption value="">Choose a category</NativeSelectOption>
            {(categories.data ?? []).map((option) => (
              <NativeSelectOption key={option.id} value={option.id}>
                {option.name}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </FormField>
      </FieldRow>
      <div>
        <Button
          type="button"
          size="md"
          disabled={!ready || busy}
          onClick={issue}
        >
          {busy ? (
            "Waiting for your passkey…"
          ) : (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Issue with passkey
            </>
          )}
        </Button>
      </div>
      {action.data?.status === "cancelled" ? (
        <SheetNote>Cancelled. No card was issued.</SheetNote>
      ) : null}
      {action.isError ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApprovalError(action.error)}</p>
          </Callout>
        </div>
      ) : null}
    </div>
  );
}
