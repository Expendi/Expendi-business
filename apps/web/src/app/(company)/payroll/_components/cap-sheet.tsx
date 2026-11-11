"use client";

import type { JSX } from "react";
import { KeyRoundIcon } from "lucide-react";
import { useState } from "react";

import type { PasskeyState } from "~/features/payment-ui";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  FormField,
  PasskeySetupCallout,
  SheetForm,
  SheetNote,
} from "~/features/payment-ui";
import { useChangePayrollMargin } from "~/features/payroll/payroll-api";
import { parseMarginPct } from "~/features/payroll/payroll-payment";
import { describeApprovalError } from "~/lib/approval";

const FORM_ID = "payroll-cap-form";
const MARGIN_ID = "payroll-margin";

/**
 * The payroll cap's margin (spec §7.4): a run can pay at most its drafted
 * salaries plus this. Changing it needs the admin's passkey.
 */
export function CapSheet({
  organizationId,
  marginPct,
  passkey,
  onClose,
}: {
  organizationId: string;
  marginPct: number | null;
  passkey: PasskeyState;
  onClose: () => void;
}): JSX.Element {
  const change = useChangePayrollMargin(organizationId);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const canChange = passkey === "ready" && marginPct !== null;

  function submit() {
    if (marginPct === null) return;
    const next = parseMarginPct(typed);
    const problem =
      next === null
        ? "Enter the margin as a whole percentage, 0 to 100."
        : next === marginPct
          ? `The margin is already ${String(marginPct)}%.`
          : null;
    setError(problem);
    if (next === null || problem) {
      document.getElementById(MARGIN_ID)?.focus();
      return;
    }
    setSaved(null);
    change.mutate(next, {
      onSuccess: (outcome) => {
        if (outcome.status !== "approved") return;
        setTyped("");
        setSaved(outcome.result.marginPct);
      },
    });
  }

  return (
    <DetailSheet
      open
      onClose={onClose}
      dismissible={!change.isPending}
      eyebrow="Payroll"
      title="Payroll cap"
      footer={
        canChange ? (
          <SheetActions kind="primary">
            <Button type="submit" form={FORM_ID} disabled={change.isPending}>
              {change.isPending ? (
                "Waiting for your passkey…"
              ) : (
                <>
                  <KeyRoundIcon aria-hidden="true" />
                  Change with passkey
                </>
              )}
            </Button>
            <Button
              variant="outline"
              disabled={change.isPending}
              onClick={onClose}
            >
              Close
            </Button>
          </SheetActions>
        ) : (
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        )
      }
    >
      <p className="text-muted-foreground">
        A payroll run can pay at most the salaries drafted into it plus this
        margin, so a mistake or a misuse can’t pay far more than the payroll
        that’s set up.
      </p>
      {saved !== null ? (
        <div role="status">
          <Callout tone="success">
            <p>Saved. The margin is now {String(saved)}%.</p>
          </Callout>
        </div>
      ) : null}
      <DetailList>
        <DetailItem label="Margin">
          {marginPct === null ? "Loading…" : `${String(marginPct)}%`}
        </DetailItem>
      </DetailList>
      {passkey === "missing" ? <PasskeySetupCallout /> : null}
      {canChange ? (
        <SheetForm id={FORM_ID} label="Change the margin" onSubmit={submit}>
          <FormField id={MARGIN_ID} label="New margin (%)" error={error}>
            <Input
              id={MARGIN_ID}
              inputMode="numeric"
              maxLength={4}
              autoComplete="off"
              placeholder={String(marginPct)}
              value={typed}
              disabled={change.isPending}
              aria-invalid={error ? true : undefined}
              onChange={(event) => {
                setTyped(event.target.value);
                setError(null);
              }}
            />
          </FormField>
          <SheetNote>
            You confirm the change with your passkey. Every admin gets an email,
            and draft payroll runs use the new margin at once.
          </SheetNote>
          {change.data?.status === "cancelled" ? (
            <SheetNote>Cancelled. Nothing changed.</SheetNote>
          ) : null}
          {change.isError ? (
            <div role="alert">
              <Callout tone="error">
                <p>{describeApprovalError(change.error)}</p>
              </Callout>
            </div>
          ) : null}
        </SheetForm>
      ) : null}
    </DetailSheet>
  );
}
