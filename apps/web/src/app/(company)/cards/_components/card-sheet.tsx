"use client";

import type { JSX, ReactNode } from "react";
import { KeyRoundIcon, TriangleAlertIcon } from "lucide-react";
import { useId, useState } from "react";

import type { ExpendiCard } from "@expendi-business/shared";

import type { PasskeyState } from "~/features/payment-ui";
import { personName } from "~/app/(company)/expenses/_components/expense-labels";
import { TextLinkButton } from "~/components/data/actions";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
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
  limitChangeOf,
  maskedLastFour,
} from "./cards-display";
import { Usd } from "./usd";

type Step = "details" | "limit" | "close";

/**
 * One card in the right side sheet. Admins raise the limit and unfreeze
 * with their passkey; lowering the limit, freezing and closing need none.
 * Everyone here sees only the last four digits.
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
      onSuccess: () => setNotice("Card frozen. New purchases are declined."),
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
              onClick={freezeCard}
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
      eyebrow="Expendi card"
      title={card.nickname}
      stepKey={card.id}
      headerExtra={
        <>
          <p className="mt-0.5 text-gray-600 tabular-nums">
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
          <p>
            Closing {card.nickname} ({maskedLastFour(card.lastFour)}) stops it
            for good. It can&apos;t be reopened; {personName(card.holder)} would
            need a new card.
          </p>
        </Callout>
      ) : null}

      <DetailList>
        <DetailItem label="Cardholder" sub={card.holder.email}>
          {personName(card.holder)}
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

      {step === "details" ? (
        <>
          {card.state === "frozen" && canAct && passkey === "missing" ? (
            <PasskeySetupCallout />
          ) : null}
          <p className="text-gray-600">
            Only the last four digits show here. The cardholder sees the full
            number in the app.{" "}
            <TextLinkButton onClick={onViewPurchases}>
              See this card&apos;s purchases
            </TextLinkButton>
          </p>
        </>
      ) : null}
    </DetailSheet>
  );
}
