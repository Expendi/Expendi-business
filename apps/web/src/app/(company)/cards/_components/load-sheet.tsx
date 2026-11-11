"use client";

import type { JSX } from "react";
import { CheckIcon, KeyRoundIcon } from "lucide-react";
import { useId, useState } from "react";

import type { CardLoad } from "@expendi-business/shared";
import { cardActionSchema } from "@expendi-business/shared";

import type { PasskeyState } from "~/features/payment-ui";
import {
  Callout,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  FormField,
  PasskeySetupCallout,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { describeApprovalError } from "~/lib/approval";
import { formatKes } from "~/lib/money";
import { useCardAction } from "./cards-api";
import { formatUsd } from "./cards-display";
import { Usd } from "./usd";

/**
 * A Card load (spec §6.25): moves the Card balance up with the admin's
 * passkey. In the sandbox it's only a record: no USDC leaves the wallet.
 */
export function LoadSheet({
  organizationId,
  passkey,
  availableUsdCents,
  onClose,
}: {
  organizationId: string;
  passkey: PasskeyState;
  availableUsdCents: string;
  onClose: () => void;
}): JSX.Element {
  const action = useCardAction(organizationId);
  const formId = useId();
  const amountId = useId();
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<CardLoad | null>(null);

  function submit() {
    const request = { type: "load_balance", amountUsd: amount } as const;
    const parsed = cardActionSchema.safeParse(request);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter an amount.");
      document.getElementById(amountId)?.focus();
      return;
    }
    setError(null);
    action.mutate(request, {
      onSuccess: (outcome) => {
        if (
          outcome.status === "approved" &&
          outcome.result.type === "load_balance"
        ) {
          setLoaded(outcome.result.load);
        }
      },
    });
  }

  if (loaded) {
    return (
      <DetailSheet
        open
        onClose={onClose}
        eyebrow="Card balance"
        title="Card load recorded"
        footer={
          <SheetActions kind="primary">
            <Button onClick={onClose}>Done</Button>
          </SheetActions>
        }
      >
        <div
          role="status"
          className="flex flex-col items-center gap-2 px-2 pt-6 pb-2 text-center"
        >
          <span
            aria-hidden="true"
            className="flex size-12 items-center justify-center rounded-full bg-success-50 text-success-700"
          >
            <CheckIcon className="size-6" />
          </span>
          <p className="text-lg leading-[26px] font-(--w-title) tabular-nums">
            <Usd cents={loaded.amountUsdCents} />
          </p>
          <p className="max-w-[34ch] text-muted-foreground">
            KES {formatKes(loaded.amountKes)} at KES {loaded.usdKesRate} per
            USD, counted against today&apos;s limit. It shows in Loads.
          </p>
        </div>
      </DetailSheet>
    );
  }

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!action.isPending}
      eyebrow="Card balance"
      title="Load the Card balance"
      footer={
        passkey === "ready" ? (
          <SheetActions kind="primary">
            <Button type="submit" form={formId} disabled={action.isPending}>
              {action.isPending ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Load with passkey
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={action.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
          </SheetActions>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <Callout tone="neutral" title="Sandbox: no real money moves">
        <p>The Card balance goes up. No USDC leaves the wallet.</p>
      </Callout>
      {passkey === "missing" ? <PasskeySetupCallout /> : null}
      {passkey === "checking" ? <Skel width="100%" height={72} /> : null}
      {passkey === "ready" ? (
        <SheetForm id={formId} label="Load the Card balance" onSubmit={submit}>
          <FormField
            id={amountId}
            label="Amount (USD)"
            help={`Available now: ${formatUsd(availableUsdCents)}`}
            error={error}
          >
            <Input
              id={amountId}
              inputMode="decimal"
              autoComplete="off"
              placeholder="250.00"
              value={amount}
              disabled={action.isPending}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setAmount(event.target.value);
                setError(null);
              }}
            />
          </FormField>
          <SheetNote>
            It counts against the company&apos;s daily limit at today&apos;s
            Paycrest rate, together with today&apos;s payouts. Money can&apos;t
            be moved back out of the Card balance.
          </SheetNote>
          {action.data?.status === "cancelled" ? (
            <SheetNote>Cancelled. Nothing was loaded.</SheetNote>
          ) : null}
          {action.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApprovalError(action.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      ) : null}
    </DetailSheet>
  );
}
