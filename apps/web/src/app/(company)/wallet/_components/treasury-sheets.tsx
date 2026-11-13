"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { cn } from "cn";
import { CheckIcon, CircleAlertIcon, KeyRoundIcon } from "lucide-react";
import { useEffect, useId, useState } from "react";

import type {
  TreasuryMoveDirection,
  TreasuryMovePreview,
  TreasuryMoveSummary,
} from "@expendi-business/shared";

import type { MovePrefill } from "./treasury-display";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { Checkbox } from "~/components/ui/checkbox";
import { describeApprovalError } from "~/lib/approval";
import { formatUsdc } from "~/lib/money";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { passkeyGate } from "./passkey-gate";
import {
  useMovePreview,
  useStartTreasuryMove,
  useTurnOnTreasury,
} from "./treasury-api";
import {
  formatDuration,
  formatRate,
  MOVE_TITLES,
  parseMoveAmount,
} from "./treasury-display";

/** Typed amounts are asked about once the admin pauses. */
const PREVIEW_DELAY_MS = 350;

function useDebounced<T>(value: T, delayMs: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return settled;
}

/** What the admin ticks before turning Treasury on (spec §5, "Turning Treasury on"). */
export const TURN_ON_ACKNOWLEDGEMENT = [
  "Yield is not guaranteed and the rate changes.",
  "Money in Treasury can lose value.",
  "The vault is run by a third party, not by Expendi.",
  "Moving money back takes a few minutes, and can be delayed when the vault is short of cash.",
] as const;

export const RATE_WARNING = "changes daily, not guaranteed";

/** Turns Treasury on: the acknowledgement, then the approval passkey. No money moves. */
export function TurnOnSheet({
  open,
  organizationId,
  rateBps,
  onClose,
}: {
  open: boolean;
  organizationId: string;
  rateBps: number | null;
  onClose: () => void;
}): JSX.Element {
  const passkey = useApprovalPasskeyStatus();
  const turnOn = useTurnOnTreasury(organizationId);
  const [acknowledged, setAcknowledged] = useState(false);
  const [done, setDone] = useState(false);
  const checkId = useId();
  const gate = passkeyGate(passkey);

  let body: ReactNode;
  let footer: ReactNode;
  if (done) {
    body = (
      <MoveResult
        title="Treasury is on"
        text="No money has moved. Use Move to Treasury when you have USDC you don't need for payments."
      />
    );
    footer = (
      <SheetActions kind="primary">
        <Button onClick={onClose}>Done</Button>
      </SheetActions>
    );
  } else {
    body = gate ?? (
      <>
        <p className="text-secondary-foreground">
          Treasury is a separate account for USDC the company doesn&apos;t need
          to spend right now. It collects yield
          {rateBps === null
            ? "."
            : `, currently ${formatRate(rateBps)} a year (${RATE_WARNING}).`}{" "}
          It can&apos;t be spent until an admin moves it back to the wallet.
        </p>
        <div className="flex items-start gap-3 rounded-control border border-border p-3.5">
          <Checkbox
            id={checkId}
            checked={acknowledged}
            onCheckedChange={(next) => setAcknowledged(next === true)}
            className="mt-0.5"
          />
          <label htmlFor={checkId} className="min-w-0 cursor-pointer">
            <span className="block font-(--w-ui)">
              I understand the risks of using Treasury
            </span>
            <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
              {TURN_ON_ACKNOWLEDGEMENT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </label>
        </div>
        {turnOn.data?.status === "cancelled" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cancelled. Treasury is still off.
          </p>
        ) : null}
        {turnOn.isError ? (
          <Callout tone="error">{describeApprovalError(turnOn.error)}</Callout>
        ) : null}
      </>
    );
    footer = gate ? null : (
      <SheetActions kind="primary">
        <Button
          disabled={!acknowledged || turnOn.isPending}
          onClick={() =>
            turnOn.mutate(undefined, {
              onSuccess: (outcome) => {
                if (outcome.status === "approved") setDone(true);
              },
            })
          }
        >
          {turnOn.isPending ? (
            "Waiting for your passkey…"
          ) : (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Turn on with passkey
            </>
          )}
        </Button>
        <Button variant="outline" disabled={turnOn.isPending} onClick={onClose}>
          Cancel
        </Button>
      </SheetActions>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      dismissible={!turnOn.isPending}
      eyebrow="Treasury"
      title="Turn on Treasury"
      footer={footer}
    >
      {body}
    </DetailSheet>
  );
}

export type PreviewState =
  | { readonly kind: "idle" }
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly preview: TreasuryMovePreview }
  | { readonly kind: "refused"; readonly message: string };

/**
 * Moves money between the company wallet and Treasury, in either
 * direction: the amount, what it would cost and take, then the approval
 * passkey. The sheet is keyed by its opener, so each opening starts fresh.
 */
export function MoveSheet({
  open,
  organizationId,
  direction,
  rateBps,
  prefill,
  onClose,
}: {
  open: boolean;
  organizationId: string;
  direction: TreasuryMoveDirection;
  rateBps: number | null;
  prefill?: MovePrefill | null;
  onClose: () => void;
}): JSX.Element {
  const passkey = useApprovalPasskeyStatus();
  const start = useStartTreasuryMove(organizationId);
  const formId = useId();
  const [amount, setAmount] = useState(prefill?.amount ?? "");
  const [all, setAll] = useState(prefill?.all ?? false);
  const [result, setResult] = useState<TreasuryMoveSummary | null>(null);

  const parsed = parseMoveAmount(direction, amount, all);
  const typed = all || amount.trim() !== "";
  const asked = useDebounced(
    parsed.ok ? parsed.request : null,
    PREVIEW_DELAY_MS,
  );
  const settled =
    parsed.ok &&
    asked?.direction === parsed.request.direction &&
    asked.amountUsdc === parsed.request.amountUsdc;
  const query = useMovePreview(organizationId, parsed.ok ? asked : null);
  const preview: PreviewState = !parsed.ok
    ? { kind: "idle" }
    : !settled || query.isPending
      ? { kind: "loading" }
      : query.isError
        ? { kind: "refused", message: describeApprovalError(query.error) }
        : { kind: "ready", preview: query.data };

  const gate = passkeyGate(passkey);
  const title = MOVE_TITLES[direction];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsed.ok || preview.kind !== "ready") return;
    start.reset();
    start.mutate(parsed.request, {
      onSuccess: (outcome) => {
        if (outcome.status === "approved") setResult(outcome.result);
      },
    });
  }

  let body: ReactNode;
  let footer: ReactNode = null;
  if (result) {
    body = (
      <MoveResult
        title="Move started"
        text={
          direction === "to_treasury"
            ? `${formatUsdc(result.requestedUsdc)} USDC is on its way to Treasury. Treasury shows its progress and the move appears in the history.`
            : `${result.isAll ? "All of Treasury" : `${formatUsdc(result.requestedUsdc)} USDC`} is on its way to your wallet. It can be spent once it arrives.`
        }
      />
    );
    footer = (
      <SheetActions kind="primary">
        <Button onClick={onClose}>Done</Button>
      </SheetActions>
    );
  } else if (gate) {
    body = gate;
  } else {
    body = (
      <MoveForm
        formId={formId}
        direction={direction}
        amount={amount}
        onAmount={(value) => {
          setAmount(value);
          setAll(false);
          start.reset();
        }}
        all={all}
        onAll={() => {
          setAll(!all);
          setAmount("");
          start.reset();
        }}
        amountError={typed && !parsed.ok ? parsed.error : null}
        preview={preview}
        rateBps={rateBps}
        onSubmit={submit}
      />
    );
    footer = (
      <SheetActions kind="primary">
        <Button
          type="submit"
          form={formId}
          disabled={preview.kind !== "ready" || start.isPending}
        >
          {start.isPending ? (
            "Waiting for your passkey…"
          ) : (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Move with passkey
            </>
          )}
        </Button>
        <Button variant="outline" disabled={start.isPending} onClick={onClose}>
          Cancel
        </Button>
      </SheetActions>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      dismissible={!start.isPending}
      eyebrow="Treasury"
      title={title}
      footer={footer}
    >
      {body}
      {!result && start.data?.status === "cancelled" ? (
        <p role="status" className="text-sm text-muted-foreground">
          Cancelled. Nothing moved.
        </p>
      ) : null}
      {!result && start.isError ? (
        <Callout tone="error">{describeApprovalError(start.error)}</Callout>
      ) : null}
    </DetailSheet>
  );
}

/** The amount, the live preview and, for a move to Treasury, the rate warning. */
export function MoveForm({
  formId,
  direction,
  amount,
  onAmount,
  all,
  onAll,
  amountError,
  preview,
  rateBps,
  onSubmit,
}: {
  formId: string;
  direction: TreasuryMoveDirection;
  amount: string;
  onAmount: (value: string) => void;
  all: boolean;
  onAll: () => void;
  amountError: string | null;
  preview: PreviewState;
  rateBps: number | null;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}): JSX.Element {
  const amountId = useId();
  const helpId = useId();
  const errorId = useId();
  return (
    <form
      id={formId}
      noValidate
      onSubmit={onSubmit}
      aria-label={MOVE_TITLES[direction]}
      className="flex flex-col gap-5"
    >
      <div className="flex flex-col gap-2">
        <label
          htmlFor={amountId}
          className="text-xs leading-4 font-(--w-ui) text-muted-foreground"
        >
          Amount
        </label>
        <div
          className={cn(
            "flex h-14 items-center gap-2 rounded-control border bg-card pr-2 pl-3.5 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-ring",
            amountError ? "border-destructive" : "border-input",
          )}
        >
          <input
            id={amountId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder={all ? "All of Treasury" : "0.00"}
            value={all ? "" : amount}
            disabled={all}
            onChange={(event) => onAmount(event.target.value)}
            aria-invalid={amountError ? true : undefined}
            aria-describedby={amountError ? `${helpId} ${errorId}` : helpId}
            className="min-w-0 flex-1 border-0 bg-transparent text-2xl leading-8 font-(--w-heading) tabular-nums outline-none placeholder:text-muted-foreground/50"
          />
          <span className="text-sm font-(--w-ui) tracking-[0.04em] text-muted-foreground">
            USDC
          </span>
          {direction === "to_wallet" ? (
            <Button
              type="button"
              variant={all ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={all}
              onClick={onAll}
            >
              All
            </Button>
          ) : null}
        </div>
        <p id={helpId} className="text-xs leading-4 text-muted-foreground">
          The least is 10 USDC
          {direction === "to_wallet" ? ", unless you move all of it." : "."}
        </p>
        {amountError ? (
          <p
            id={errorId}
            role="alert"
            className="flex items-center gap-1.5 text-xs leading-4 text-destructive"
          >
            <CircleAlertIcon aria-hidden="true" className="size-3.5" />
            {amountError}
          </p>
        ) : null}
      </div>
      <MovePreviewPanel direction={direction} preview={preview} />
      {direction === "to_treasury" ? (
        <Callout tone="neutral">
          <p>
            {rateBps === null
              ? "The yearly rate"
              : `Treasury pays ${formatRate(rateBps)} a year now. The rate`}{" "}
            {RATE_WARNING}.
          </p>
        </Callout>
      ) : null}
    </form>
  );
}

/** What the move would do, from the API's preview: its parts stay out of sight. */
export function MovePreviewPanel({
  direction,
  preview,
}: {
  direction: TreasuryMoveDirection;
  preview: PreviewState;
}): JSX.Element | null {
  if (preview.kind === "idle") return null;
  if (preview.kind === "loading") {
    return (
      <div className="flex flex-col gap-2" aria-busy="true">
        <Skel width="100%" height={20} />
        <Skel width="70%" height={20} />
      </div>
    );
  }
  if (preview.kind === "refused") {
    return (
      <div role="alert">
        <Callout tone="error">{preview.message}</Callout>
      </div>
    );
  }
  const { preview: move } = preview;
  return (
    <section aria-label="What this move does">
      <DetailList>
        <DetailItem label="Amount">
          {formatUsdc(move.amountUsdc)} USDC
          {move.isAll ? " (all of Treasury)" : ""}
        </DetailItem>
        <DetailItem label="Estimated cost">
          About {formatUsdc(move.estimatedCostUsdc)} USDC
        </DetailItem>
        <DetailItem label="Time">
          {direction === "to_treasury"
            ? `Arrives in ${formatDuration(move.estimatedSeconds)}`
            : `Reaches your wallet in ${formatDuration(move.estimatedSeconds)}`}
        </DetailItem>
        <DetailItem label="Available in wallet">
          {formatUsdc(move.availableUsdc)} USDC
        </DetailItem>
        {move.inTreasuryUsdc !== undefined ? (
          <DetailItem label="In Treasury">
            {formatUsdc(move.inTreasuryUsdc)} USDC
          </DetailItem>
        ) : null}
      </DetailList>
    </section>
  );
}

function MoveResult({
  title,
  text,
}: {
  title: string;
  text: string;
}): JSX.Element {
  return (
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
      <p className="text-lg leading-[26px] font-(--w-title)">{title}</p>
      <p className="max-w-[34ch] text-muted-foreground">{text}</p>
    </div>
  );
}
