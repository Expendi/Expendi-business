"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import { KeyRoundIcon, SnowflakeIcon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";

import type { ExpendiCard } from "@expendi-business/shared";

import type { PasskeyState } from "~/features/payment-ui";
import { TextLinkButton, textLinkClass } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  FormField,
  PasskeySetupCallout,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { STATE_LABELS } from "~/features/recurring/recurring-draft";
import { describeApprovalError } from "~/lib/approval";
import { formatNairobiDate } from "~/lib/dates";
import {
  useCardAction,
  useCloseCard,
  useFreezeCard,
  useLowerCardLimit,
} from "./cards-api";
import {
  CARD_STATE,
  formatUsd,
  holderName,
  limitChangeOf,
  maskedLastFour,
  paymentsDeclinedWhenFrozen,
} from "./cards-display";
import { RevealCardNumber } from "./reveal-card-number";
import { Usd } from "./usd";

type Step = "details" | "limit" | "close" | "freeze";

/**
 * One card in the right side sheet. Admins raise the limit and unfreeze
 * with their passkey; lowering the limit, freezing and closing need none.
 * A person's card shows only its last four digits here; a company-held
 * card's number is shown to any admin with a fresh passkey, and its sheet
 * lists the recurring payments it pays.
 */
export function CardSheet({
  organizationId,
  card,
  canAct,
  passkey,
  index,
  total,
  onStep,
  onClose,
  onViewPurchases,
}: {
  organizationId: string;
  card: ExpendiCard;
  canAct: boolean;
  passkey: PasskeyState;
  index: number;
  total: number;
  onStep: (delta: -1 | 1) => void;
  onClose: () => void;
  onViewPurchases: () => void;
}): JSX.Element {
  const action = useCardAction(organizationId);
  const freeze = useFreezeCard(organizationId);
  const close = useCloseCard(organizationId);
  const lower = useLowerCardLimit(organizationId);
  const formId = useId();
  const limitId = useId();
  const [step, setStep] = useState<Step>("details");
  const [typed, setTyped] = useState("");
  const [limitError, setLimitError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const busy =
    action.isPending || freeze.isPending || close.isPending || lower.isPending;
  const failure =
    action.error ?? freeze.error ?? close.error ?? lower.error ?? null;
  const state = CARD_STATE[card.state];
  const change =
    typed.trim() === ""
      ? null
      : limitChangeOf(card.monthlyLimitUsdCents, typed);
  const raising = change?.ok === true && change.direction === "raise";
  const declinedWhenFrozen = paymentsDeclinedWhenFrozen(card);

  function resetAttempts() {
    action.reset();
    freeze.reset();
    close.reset();
    lower.reset();
  }

  function goTo(next: Step) {
    resetAttempts();
    setNotice(null);
    setLimitError(null);
    setTyped("");
    setStep(next);
  }

  function freezeCard() {
    resetAttempts();
    setNotice(null);
    freeze.mutate(card.id, {
      onSuccess: () => {
        setNotice("Card frozen. New purchases are declined.");
        setStep("details");
      },
    });
  }

  function unfreezeCard() {
    resetAttempts();
    setNotice(null);
    action.mutate(
      { type: "unfreeze_card", cardId: card.id },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "approved") setNotice("Card unfrozen.");
        },
      },
    );
  }

  function closeCard() {
    resetAttempts();
    close.mutate(card.id, {
      onSuccess: () => {
        setNotice("Card closed.");
        setStep("details");
      },
    });
  }

  function limitSaved(cents: string) {
    setTyped("");
    setNotice(`The monthly limit is now ${formatUsd(cents)}.`);
    setStep("details");
  }

  function submitLimit() {
    const next = limitChangeOf(card.monthlyLimitUsdCents, typed);
    if (!next.ok) {
      setLimitError(next.error);
      document.getElementById(limitId)?.focus();
      return;
    }
    setLimitError(null);
    resetAttempts();
    if (next.direction === "lower") {
      lower.mutate(
        { cardId: card.id, monthlyLimitUsd: typed },
        {
          onSuccess: (updated) => limitSaved(updated.monthlyLimitUsdCents),
        },
      );
      return;
    }
    action.mutate(
      { type: "raise_limit", cardId: card.id, monthlyLimitUsd: typed },
      {
        onSuccess: (outcome) => {
          if (
            outcome.status === "approved" &&
            outcome.result.type === "raise_limit"
          ) {
            limitSaved(outcome.result.card.monthlyLimitUsdCents);
          }
        },
      },
    );
  }

  const position = <SheetPosition index={index} total={total} />;
  let footer: ReactNode;
  if (!canAct) {
    footer = (
      <>
        <ReadOnlyNote>View only. Only admins change cards.</ReadOnlyNote>
        {position}
      </>
    );
  } else if (card.state === "closed") {
    footer = position;
  } else if (step === "limit") {
    footer = (
      <SheetActions kind="primary">
        <Button
          type="submit"
          form={formId}
          disabled={busy || (raising && passkey !== "ready")}
        >
          {action.isPending ? (
            "Waiting for your passkey…"
          ) : lower.isPending ? (
            "Saving…"
          ) : raising ? (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Raise with passkey
            </>
          ) : (
            "Change limit"
          )}
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
  } else if (step === "close") {
    footer = (
      <SheetActions kind="primary">
        <Button variant="danger" disabled={busy} onClick={closeCard}>
          {close.isPending ? "Closing…" : "Close card for good"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => goTo("details")}
        >
          Keep the card
        </Button>
      </SheetActions>
    );
  } else if (step === "freeze") {
    footer = (
      <SheetActions kind="primary">
        <Button disabled={busy} onClick={freezeCard}>
          {freeze.isPending ? "Freezing…" : "Freeze card"}
        </Button>
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => goTo("details")}
        >
          Keep it open
        </Button>
      </SheetActions>
    );
  } else {
    footer = (
      <>
        <SheetActions kind="primary">
          {card.state === "frozen" ? (
            <Button
              size="md"
              disabled={busy || passkey !== "ready"}
              onClick={unfreezeCard}
            >
              {action.isPending ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Unfreeze with passkey
                </>
              )}
            </Button>
          ) : (
            <Button
              variant="outline"
              size="md"
              disabled={busy}
              onClick={
                declinedWhenFrozen.length > 0
                  ? () => goTo("freeze")
                  : freezeCard
              }
            >
              {freeze.isPending ? "Freezing…" : "Freeze"}
            </Button>
          )}
          <Button
            variant="outline"
            size="md"
            disabled={busy}
            onClick={() => goTo("limit")}
          >
            Change limit
          </Button>
        </SheetActions>
        <SheetActions kind="secondary">
          <Button
            variant="danger"
            size="md"
            disabled={busy}
            onClick={() => goTo("close")}
          >
            Close card
          </Button>
        </SheetActions>
      </>
    );
  }

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!busy}
      eyebrow={card.companyHeld ? "Company-held card" : "Expendi card"}
      title={card.nickname}
      stepKey={card.id}
      headerExtra={
        <>
          <p className="mt-0.5 text-muted-foreground tabular-nums">
            {maskedLastFour(card.lastFour)}
          </p>
          <StatusBadge tone={state.tone} className="mt-2">
            {state.label}
          </StatusBadge>
        </>
      }
      stepper={{
        index,
        total,
        onStep: (delta) => {
          goTo("details");
          onStep(delta);
        },
        previousLabel: "Previous card",
        nextLabel: "Next card",
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
      {failure ? (
        <div role="alert">
          <Callout tone="error">
            <p>{describeApprovalError(failure)}</p>
          </Callout>
        </div>
      ) : null}
      {action.data?.status === "cancelled" ? (
        <SheetNote>Cancelled. Nothing changed.</SheetNote>
      ) : null}

      {step === "close" ? (
        <Callout
          tone="warn"
          icon={TriangleAlertIcon}
          title="This can't be undone"
        >
          {card.holder === null ? (
            <p>
              Closing {card.nickname} ({maskedLastFour(card.lastFour)}) stops it
              for good. It can&apos;t be reopened. A recurring payment it still
              pays has to move to another card or way of paying first.
            </p>
          ) : (
            <p>
              Closing {card.nickname} ({maskedLastFour(card.lastFour)}) stops it
              for good. It can&apos;t be reopened; {holderName(card.holder)}{" "}
              would need a new card.
            </p>
          )}
        </Callout>
      ) : null}

      {step === "freeze" ? <FreezeConfirm card={card} /> : null}

      <DetailList>
        <DetailItem
          label="Cardholder"
          sub={
            card.holder === null
              ? "Pays recurring payments. It doesn't close when anyone leaves."
              : card.holder.email
          }
        >
          {holderName(card.holder)}
        </DetailItem>
        <DetailItem label="Card">{maskedLastFour(card.lastFour)}</DetailItem>
        <DetailItem label="Monthly limit">
          <Usd cents={card.monthlyLimitUsdCents} />
        </DetailItem>
        <DetailItem label="Spent this month">
          <Usd cents={card.spentThisMonthUsdCents} />
        </DetailItem>
        <DetailItem label="Default category">
          {card.defaultCategory.name}
        </DetailItem>
        <DetailItem label="Issued">
          {formatNairobiDate(card.issuedAt)}
        </DetailItem>
        {card.closedAt ? (
          <DetailItem label="Closed">
            {formatNairobiDate(card.closedAt)}
          </DetailItem>
        ) : null}
      </DetailList>

      {step === "limit" ? (
        <SheetForm id={formId} label="Change the limit" onSubmit={submitLimit}>
          <FormField
            id={limitId}
            label="New monthly limit (USD)"
            help="Raising it takes your passkey. Lowering it doesn't."
            error={limitError}
          >
            <Input
              id={limitId}
              inputMode="decimal"
              autoComplete="off"
              placeholder="500.00"
              value={typed}
              disabled={busy}
              aria-invalid={limitError ? true : undefined}
              onChange={(event) => {
                setTyped(event.target.value);
                setLimitError(null);
              }}
            />
          </FormField>
          {raising && passkey === "missing" ? <PasskeySetupCallout /> : null}
        </SheetForm>
      ) : null}

      {card.companyHeld ? <CardRecurringPayments card={card} /> : null}

      {step === "details" ? (
        <>
          {card.state === "frozen" && canAct && passkey === "missing" ? (
            <PasskeySetupCallout />
          ) : null}
          {card.companyHeld ? (
            <>
              <p className="text-muted-foreground">
                Any admin can see its full number with a fresh passkey, e.g. to
                enter it at a merchant.{" "}
                <TextLinkButton onClick={onViewPurchases}>
                  See this card&apos;s purchases
                </TextLinkButton>
              </p>
              {canAct && card.state !== "closed" ? (
                <RevealCardNumber
                  organizationId={organizationId}
                  cardId={card.id}
                />
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              Only the last four digits show here. The cardholder sees the full
              number in the app.{" "}
              <TextLinkButton onClick={onViewPurchases}>
                See this card&apos;s purchases
              </TextLinkButton>
            </p>
          )}
        </>
      ) : null}
    </DetailSheet>
  );
}

/** Before a company-held card is frozen: the recurring payments whose Card purchases it will decline. */
export function FreezeConfirm({ card }: { card: ExpendiCard }): JSX.Element {
  return (
    <Callout
      tone="warn"
      icon={SnowflakeIcon}
      title="Its recurring payments will be declined"
    >
      <p>
        While {card.nickname} is frozen, every Card purchase on it is declined,
        including these recurring payments:
      </p>
      <ul className="mt-1 list-disc pl-5">
        {paymentsDeclinedWhenFrozen(card).map((payment) => (
          <li key={payment.id}>{payment.payeeName}</li>
        ))}
      </ul>
      <p className="mt-1">
        Their bills stay owed, and go overdue if nothing pays them.
      </p>
    </Callout>
  );
}

/** The recurring payments a company-held card pays, each linking to it under Bills. */
function CardRecurringPayments({ card }: { card: ExpendiCard }): JSX.Element {
  return (
    <section
      aria-label="Recurring payments it pays"
      className="flex flex-col gap-2"
    >
      <SectionLabel>Recurring payments it pays</SectionLabel>
      {card.recurringPayments.length === 0 ? (
        <p className="rounded-control border border-dashed border-input px-4 py-3.5 text-muted-foreground">
          None yet. Pick this card when you set up a recurring payment under
          Bills.
        </p>
      ) : (
        <ul className="flex flex-col rounded-control border border-border">
          {card.recurringPayments.map((payment) => {
            const state = STATE_LABELS[payment.state];
            return (
              <li
                key={payment.id}
                className="flex items-center justify-between gap-3 border-t border-border px-4 py-3 first:border-t-0"
              >
                <Link
                  href={`/bills?recurring=${payment.id}`}
                  className={cn(
                    "min-w-0 [overflow-wrap:anywhere]",
                    textLinkClass,
                  )}
                >
                  {payment.payeeName}
                </Link>
                <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
