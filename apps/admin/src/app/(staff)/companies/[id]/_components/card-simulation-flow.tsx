"use client";

import type { FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
  CardSimulationResult,
  StaffCardPaidPayment,
} from "@expendi-business/shared";
import { usdCentsAmountSchema } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { StatusBadge } from "~/components/data/status-badge";
import { PageError } from "~/components/page-state";
import {
  inputClass,
  primaryButton,
  secondaryButton,
} from "~/components/styles";
import { useStaffAuth } from "~/contexts/staff-auth-context";
import { ApiError, describeApiError } from "~/lib/api";
import { formatUsdCents } from "~/lib/format";
import { queryKeys } from "~/lib/query-keys";

export const CARD_SIMULATION_COPY = {
  button: "Simulate purchase",
  hint: "Asks Lithic's sandbox for the Card purchase this payment's merchant would make. The purchase check and the webhook then handle it like any other.",
  confirm: "Confirm: make the purchase",
} as const;

/**
 * The API refuses only the amount with a 400 here, e.g. one over the
 * card's monthly limit, so staff fix it at the field; anything else, such
 * as the hourly limit, stays in the review.
 */
export function isAmountRefusal(error: unknown): boolean {
  return error instanceof ApiError && error.status === 400;
}

/** What the amount field starts with: the bill still owed, else the estimate. */
export function defaultAmount(payment: StaffCardPaidPayment): string {
  const cents = payment.nextBill?.amountUsdCents ?? payment.estimateUsdCents;
  if (cents === null) return "";
  const digits = cents.padStart(3, "0");
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/** Why this purchase is likely to be declined, if it is. */
function expectedDecline(payment: StaffCardPaidPayment): string | null {
  if (payment.state === "paused") {
    return "This payment is paused, so the purchase check should decline it.";
  }
  if (payment.card.state === "frozen") {
    return "The card is frozen, so the purchase check should decline it.";
  }
  return null;
}

/** The step before anything happens: what the purchase will be. */
export function SimulationReview({
  payment,
  amountUsdCents,
  newMerchant,
  pending,
  error,
  onConfirm,
  onBack,
}: {
  payment: StaffCardPaidPayment;
  amountUsdCents: string;
  newMerchant: boolean;
  pending: boolean;
  error: string | null;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const decline = expectedDecline(payment);
  return (
    <div
      role="region"
      aria-label="Simulate a purchase"
      className="mt-4 rounded-xl border border-warn-600 bg-warn-50 p-4 sm:p-6"
    >
      <h4 className="text-sm font-semibold">Simulate a purchase</h4>
      <p className="mt-2 text-sm">
        Pretend to be{" "}
        {newMerchant
          ? "a merchant this card has never seen"
          : `${payment.payeeName}'s usual merchant`}{" "}
        and charge {formatUsdCents(amountUsdCents)} to {payment.card.nickname}{" "}
        ··{payment.card.lastFour}.
      </p>
      <p className="mt-2 text-sm">
        {newMerchant
          ? "Admins are asked what this merchant is."
          : "If it's approved, it settles at once and pays the bill still owed."}{" "}
        It spends from the company&apos;s Card balance in the sandbox.
      </p>
      {decline ? <p className="mt-2 text-sm font-medium">{decline}</p> : null}
      {error ? <PageError>{error}</PageError> : null}
      <div className="mt-4 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={onConfirm}
          disabled={pending}
          className={primaryButton}
        >
          {pending ? "Making the purchase…" : CARD_SIMULATION_COPY.confirm}
        </button>
        <button
          type="button"
          onClick={onBack}
          disabled={pending}
          className={secondaryButton}
        >
          Back
        </button>
      </div>
    </div>
  );
}

const OUTCOMES: Record<
  CardSimulationResult["result"],
  { readonly tone: StatusTone; readonly label: string }
> = {
  approved: { tone: "paid", label: "Approved" },
  declined: { tone: "failed", label: "Declined" },
  unknown: { tone: "waiting", label: "Not seen yet" },
};

/** What Lithic's sandbox did with the purchase. */
export function SimulationOutcome({
  result,
  onDone,
}: {
  result: CardSimulationResult;
  onDone: () => void;
}) {
  const outcome = OUTCOMES[result.result];
  return (
    <div
      role="status"
      className="mt-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <StatusBadge tone={outcome.tone}>{outcome.label}</StatusBadge>
        <span className="wrap-anywhere">From {result.merchant}</span>
      </p>
      {result.result === "unknown" ? (
        <p className="mt-2 text-sm">
          Lithic made the purchase but didn&apos;t say whether the purchase
          check approved it, so it wasn&apos;t settled. Check the company&apos;s
          Card purchases before running it again.
        </p>
      ) : null}
      <p className="mt-1 font-mono text-xs break-all text-muted-foreground">
        {result.transactionToken}
      </p>
      <button
        type="button"
        onClick={onDone}
        className={`${secondaryButton} mt-3`}
      >
        Done
      </button>
    </div>
  );
}

type Step =
  | { readonly kind: "closed" }
  | { readonly kind: "editing" }
  | { readonly kind: "reviewing"; readonly amountUsdCents: string }
  | { readonly kind: "done"; readonly result: CardSimulationResult };

/**
 * Staff play the merchant for one card-paid recurring payment (spec
 * §6.25): an amount and whether the merchant is a new one, a review of
 * what will happen, then Lithic's answer. Only shown to ops admins; the
 * API refuses anyone else regardless.
 */
export function CardSimulationFlow({
  organizationId,
  payment,
}: {
  organizationId: string;
  payment: StaffCardPaidPayment;
}) {
  const { api } = useStaffAuth();
  const queryClient = useQueryClient();
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [amount, setAmount] = useState(() => defaultAmount(payment));
  const [newMerchant, setNewMerchant] = useState(false);
  const [amountError, setAmountError] = useState<string | null>(null);

  const simulate = useMutation({
    mutationFn: () =>
      api.ops.runCardSimulation(organizationId, {
        recurringItemId: payment.id,
        amountUsd: amount,
        newMerchant,
      }),
    onSuccess: async (result) => {
      setStep({ kind: "done", result });
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companyCardSimulations(organizationId),
      });
    },
    onError: async (error) => {
      if (isAmountRefusal(error)) {
        setAmountError(describeApiError(error));
        setStep({ kind: "editing" });
      }
      // A refusal may still have recorded an attempt Lithic never confirmed.
      await queryClient.invalidateQueries({
        queryKey: queryKeys.companyCardSimulations(organizationId),
      });
    },
  });

  function close() {
    setStep({ kind: "closed" });
    setAmount(defaultAmount(payment));
    setNewMerchant(false);
    setAmountError(null);
    simulate.reset();
  }

  function onReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = usdCentsAmountSchema.safeParse(amount);
    if (!parsed.success) {
      setAmountError(
        parsed.error.issues[0]?.message ?? "Enter an amount in US dollars.",
      );
      return;
    }
    setAmountError(null);
    setStep({ kind: "reviewing", amountUsdCents: parsed.data.toString() });
  }

  if (step.kind === "closed") {
    return (
      <div className="mt-4">
        <p className="text-sm text-muted-foreground">
          {CARD_SIMULATION_COPY.hint}
        </p>
        <button
          type="button"
          onClick={() => setStep({ kind: "editing" })}
          className={`${primaryButton} mt-2`}
        >
          {CARD_SIMULATION_COPY.button}
        </button>
      </div>
    );
  }

  if (step.kind === "reviewing") {
    return (
      <SimulationReview
        payment={payment}
        amountUsdCents={step.amountUsdCents}
        newMerchant={newMerchant}
        pending={simulate.isPending}
        error={
          simulate.isError && !isAmountRefusal(simulate.error)
            ? describeApiError(simulate.error)
            : null
        }
        onConfirm={() => simulate.mutate()}
        onBack={() => {
          setStep({ kind: "editing" });
          simulate.reset();
        }}
      />
    );
  }

  if (step.kind === "done") {
    return <SimulationOutcome result={step.result} onDone={close} />;
  }

  const hasDefault = defaultAmount(payment) !== "";
  return (
    <form
      onSubmit={onReview}
      className="mt-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <label className="block text-sm font-medium">
        Amount in US dollars
        {hasDefault ? null : " (required: this payment has no estimate)"}
        <input
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          inputMode="decimal"
          autoComplete="off"
          required
          aria-invalid={amountError !== null}
          className={inputClass}
        />
      </label>
      {amountError ? <PageError>{amountError}</PageError> : null}
      <label className="mt-4 flex min-h-11 items-start gap-3 text-sm">
        <input
          type="checkbox"
          className="mt-1 size-4 shrink-0 accent-primary"
          checked={newMerchant}
          onChange={(event) => setNewMerchant(event.target.checked)}
        />
        New merchant: one this card has never seen, so admins are asked what it
        is.
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button type="submit" className={primaryButton}>
          Review
        </button>
        <button type="button" onClick={close} className={secondaryButton}>
          Cancel
        </button>
      </div>
    </form>
  );
}
