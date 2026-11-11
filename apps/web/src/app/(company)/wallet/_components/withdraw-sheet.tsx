"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { cn } from "cn";
import {
  CheckIcon,
  CircleAlertIcon,
  InfoIcon,
  KeyRoundIcon,
  LandmarkIcon,
  PlusIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useState } from "react";

import type {
  ActiveWallet,
  Withdrawal,
  WithdrawalAddress,
} from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES } from "@expendi-business/shared";

import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { Button } from "~/components/ui/button";
import { addressOnChain, shortAddress } from "~/features/chain-display";
import { describeApiError } from "~/lib/api";
import { describeApprovalError } from "~/lib/approval";
import { formatUsdc } from "~/lib/money";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { approxKes } from "./balance-card";
import { GroupedAddress } from "./tx-sheet";
import { parseUsdcAmount } from "./usdc-amount";
import {
  useWithdraw,
  useWithdrawalAddresses,
  WithdrawalMismatchError,
} from "./wallet-api";
import { maxWithdrawal } from "./wallet-display";

interface Draft {
  /** New for each review, so retrying the same review is the same withdrawal. */
  readonly requestId: string;
  readonly address: WithdrawalAddress;
  readonly amountUsdc: string;
}

type Step =
  | { readonly kind: "form" }
  | { readonly kind: "review"; readonly draft: Draft }
  | { readonly kind: "result"; readonly withdrawal: Withdrawal };

function describeWithdrawError(error: unknown): string {
  return error instanceof WithdrawalMismatchError
    ? error.message
    : describeApprovalError(error);
}

/**
 * Withdraws to an allowlisted address (spec §6.9), as the app does: choose
 * the address and amount, review it, confirm with the approval passkey.
 * It can't be closed while the passkey prompt is open.
 */
export function WithdrawSheet({
  open,
  organizationId,
  wallet,
  onClose,
  onAddAddress,
}: {
  open: boolean;
  organizationId: string;
  wallet: ActiveWallet;
  onClose: () => void;
  onAddAddress: () => void;
}): JSX.Element {
  const addresses = useWithdrawalAddresses(organizationId);
  const passkey = useApprovalPasskeyStatus();
  const withdraw = useWithdraw(organizationId);
  const rate = wallet.kesEquivalent?.rate ?? null;
  const formId = useId();
  const [step, setStep] = useState<Step>({ kind: "form" });
  const [addressId, setAddressId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open && step.kind === "result") setStep({ kind: "form" });
  }

  const list = addresses.data ?? [];
  const chosen = list.find((address) => address.id === addressId) ?? list[0];

  function review(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!chosen) {
      setError("Choose where to send the USDC.");
      return;
    }
    const parsed = parseUsdcAmount(amount, wallet.usdcBalance);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    withdraw.reset();
    setStep({
      kind: "review",
      draft: {
        requestId: crypto.randomUUID(),
        address: chosen,
        amountUsdc: parsed.baseUnits,
      },
    });
  }

  function confirm(draft: Draft) {
    withdraw.mutate(
      {
        requestId: draft.requestId,
        addressId: draft.address.id,
        amountUsdc: draft.amountUsdc,
        chain: draft.address.chain,
        address: draft.address.address,
      },
      {
        onSuccess: (outcome) => {
          if (outcome.status === "approved") {
            setStep({ kind: "result", withdrawal: outcome.result });
            setAmount("");
          }
        },
      },
    );
  }

  const gate = passkeyGate(passkey);
  let title = "Withdraw USDC";
  let eyebrow = "USDC wallet";
  let headerExtra: ReactNode = null;
  let body: ReactNode;
  let footer: ReactNode = null;

  if (gate) {
    body = gate;
  } else if (addresses.isPending) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skel width="100%" height={60} />
        <Skel width="100%" height={56} />
      </div>
    );
  } else if (addresses.isError) {
    body = (
      <Callout
        tone="error"
        action={
          <Button
            variant="outline"
            size="md"
            onClick={() => void addresses.refetch()}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(addresses.error)}
      </Callout>
    );
  } else if (list.length === 0) {
    body = (
      <p className="rounded-control border border-dashed border-input p-4 text-center text-sm text-muted-foreground">
        Withdrawals go only to addresses on the company&apos;s allowlist. Add
        one first.
      </p>
    );
    footer = (
      <SheetActions kind="primary">
        <Button onClick={onAddAddress}>
          <PlusIcon aria-hidden="true" />
          Add address
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </SheetActions>
    );
  } else if (step.kind === "form") {
    const parsed = amount.trim()
      ? parseUsdcAmount(amount, wallet.usdcBalance)
      : null;
    const estimate =
      parsed?.ok === true ? approxKes(parsed.baseUnits, rate) : null;
    body = (
      <WithdrawForm
        formId={formId}
        addresses={list}
        chosenId={chosen?.id ?? null}
        onChoose={setAddressId}
        amount={amount}
        onAmount={(value) => {
          setAmount(value);
          setError(null);
        }}
        balance={wallet.usdcBalance}
        estimate={estimate}
        error={error}
        onSubmit={review}
      />
    );
    footer = (
      <SheetActions kind="primary">
        <Button type="submit" form={formId}>
          Review
        </Button>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
      </SheetActions>
    );
  } else if (step.kind === "review") {
    const { draft } = step;
    const kes = approxKes(draft.amountUsdc, rate);
    const left = (
      BigInt(wallet.usdcBalance) - BigInt(draft.amountUsdc)
    ).toString();
    eyebrow = "Withdraw USDC";
    title = "Review the withdrawal";
    headerExtra = (
      <p className="mt-1 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] tabular-nums">
        {formatUsdc(draft.amountUsdc)}{" "}
        <span className="text-[0.6em] font-(--w-ui) tracking-[0.04em] text-muted-foreground">
          USDC
        </span>
      </p>
    );
    body = (
      <>
        <DetailList>
          <DetailItem label="To">{draft.address.label}</DetailItem>
          <DetailItem label="Address">
            <GroupedAddress address={draft.address.address} />
          </DetailItem>
          <DetailItem label="Payee chain">
            {PAYEE_CHAIN_NAMES[draft.address.chain]}
          </DetailItem>
          {kes ? <DetailItem label="About">KES {kes}</DetailItem> : null}
          <DetailItem label="Left after">{formatUsdc(left)} USDC</DetailItem>
        </DetailList>
        <p className="flex items-start gap-2 text-sm text-muted-foreground">
          <InfoIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
          />
          Expendi pays the network fees, so exactly this amount arrives. Your
          browser asks for your approval passkey. To use the one on your phone,
          choose “use a phone or tablet”.
        </p>
        {withdraw.data?.status === "cancelled" ? (
          <p role="status" className="text-sm text-muted-foreground">
            Cancelled. Nothing was sent.
          </p>
        ) : null}
        {withdraw.isError ? (
          <Callout tone="error">
            {describeWithdrawError(withdraw.error)}
          </Callout>
        ) : null}
      </>
    );
    footer = (
      <SheetActions kind="primary">
        <Button disabled={withdraw.isPending} onClick={() => confirm(draft)}>
          {withdraw.isPending ? (
            "Waiting for your passkey…"
          ) : (
            <>
              <KeyRoundIcon aria-hidden="true" />
              Withdraw with passkey
            </>
          )}
        </Button>
        <Button
          variant="outline"
          disabled={withdraw.isPending}
          onClick={() => {
            withdraw.reset();
            setStep({ kind: "form" });
          }}
        >
          Change
        </Button>
      </SheetActions>
    );
  } else {
    const result = resultFor(step.withdrawal);
    eyebrow = "Withdraw USDC";
    title = result.title;
    body = (
      <div
        role="status"
        className="flex flex-col items-center gap-2 px-2 pt-6 pb-2 text-center"
      >
        <span
          aria-hidden="true"
          className={cn(
            "flex size-12 items-center justify-center rounded-full",
            result.ok
              ? "bg-success-50 text-success-700"
              : "bg-warn-50 text-warn-700",
          )}
        >
          {result.ok ? (
            <CheckIcon className="size-6" />
          ) : (
            <TriangleAlertIcon className="size-6" />
          )}
        </span>
        <p className="text-lg leading-[26px] font-(--w-title) tabular-nums">
          {formatUsdc(step.withdrawal.amountUsdc)} USDC to{" "}
          {step.withdrawal.label}
        </p>
        <p className="max-w-[34ch] text-muted-foreground">
          {result.sent
            ? `It's on its way on ${PAYEE_CHAIN_NAMES[step.withdrawal.chain]} and shows in the history.`
            : result.body}
        </p>
        {step.withdrawal.failureReason ? (
          <p className="max-w-[34ch] text-muted-foreground">
            {step.withdrawal.failureReason}
          </p>
        ) : null}
        {step.withdrawal.txHash ? (
          <p className="text-xs text-muted-foreground tabular-nums">
            Transaction {shortAddress(step.withdrawal.txHash)}
          </p>
        ) : null}
      </div>
    );
    footer = (
      <SheetActions kind="primary">
        <Button onClick={onClose}>Done</Button>
      </SheetActions>
    );
  }

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      dismissible={!withdraw.isPending}
      eyebrow={eyebrow}
      title={title}
      headerExtra={headerExtra}
      footer={footer}
    >
      {body}
    </DetailSheet>
  );
}

const RESULTS = {
  sent: { ok: true, sent: true, title: "Withdrawal sent", body: null },
  failed: {
    ok: false,
    sent: false,
    title: "Withdrawal failed",
    body: "Nothing was sent.",
  },
  review: {
    ok: false,
    sent: false,
    title: "We're checking this withdrawal",
    body: "Its outcome isn't clear yet, so Expendi is checking it. Don't send it again.",
  },
} as const;

function resultFor(withdrawal: Withdrawal) {
  if (withdrawal.status === "failed") return RESULTS.failed;
  if (withdrawal.status === "needs_review") return RESULTS.review;
  return RESULTS.sent;
}

/** What the approval passkey check shows instead of the form, if anything. */
function passkeyGate(
  status: ReturnType<typeof useApprovalPasskeyStatus>,
): ReactNode {
  if (status.isPending) {
    return (
      <p className="text-sm text-muted-foreground">
        Checking your approval passkey…
      </p>
    );
  }
  if (status.isError) {
    return (
      <Callout
        tone="error"
        action={
          <Button
            variant="outline"
            size="md"
            onClick={() => void status.refetch()}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(status.error)}
      </Callout>
    );
  }
  if (!status.data.enrolled) {
    return (
      <Callout tone="neutral" title="Set up your approval passkey first">
        Paying needs your approval passkey. Set it up in the Expendi Business
        app; then confirm here with “use a phone or tablet” in your
        browser&apos;s passkey prompt.
      </Callout>
    );
  }
  return null;
}

function WithdrawForm({
  formId,
  addresses,
  chosenId,
  onChoose,
  amount,
  onAmount,
  balance,
  estimate,
  error,
  onSubmit,
}: {
  formId: string;
  addresses: readonly WithdrawalAddress[];
  chosenId: string | null;
  onChoose: (id: string) => void;
  amount: string;
  onAmount: (value: string) => void;
  balance: string;
  estimate: string | null;
  error: string | null;
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
      aria-label="Withdraw USDC"
      className="flex flex-col gap-5"
    >
      <fieldset className="m-0 flex min-w-0 flex-col gap-2 border-0 p-0">
        <legend className="mb-2 p-0 text-xs leading-4 font-(--w-ui) text-muted-foreground">
          Send to
        </legend>
        {addresses.map((address) => (
          <label
            key={address.id}
            className="relative grid cursor-pointer grid-cols-[32px_minmax(0,1fr)] items-center gap-3 rounded-control border border-border p-3 transition-colors duration-150 hover:border-muted-foreground/50 has-checked:border-primary has-checked:bg-accent has-checked:shadow-[inset_0_0_0_1px_var(--primary)] has-focus-visible:outline-2 has-focus-visible:outline-offset-2 has-focus-visible:outline-ring"
          >
            <input
              type="radio"
              name="addressId"
              value={address.id}
              checked={address.id === chosenId}
              onChange={() => onChoose(address.id)}
              className="absolute inset-0 m-0 cursor-pointer opacity-0"
            />
            <span
              aria-hidden="true"
              className="inline-flex size-8 items-center justify-center rounded-control border border-border bg-card text-muted-foreground"
            >
              <LandmarkIcon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm leading-5 font-(--w-name)">
                {address.label}
              </span>
              <span className="block text-xs leading-4 text-muted-foreground tabular-nums">
                {addressOnChain(address.chain, address.address)}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
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
            error ? "border-destructive" : "border-input",
          )}
        >
          <input
            id={amountId}
            name="amount"
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            value={amount}
            onChange={(event) => onAmount(event.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${helpId} ${errorId}` : helpId}
            className="min-w-0 flex-1 border-0 bg-transparent text-2xl leading-8 font-(--w-heading) tabular-nums outline-none placeholder:text-muted-foreground/50"
          />
          <span className="text-sm font-(--w-ui) tracking-[0.04em] text-muted-foreground">
            USDC
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onAmount(maxWithdrawal(balance))}
          >
            Max
          </Button>
        </div>
        <p
          id={helpId}
          className="flex justify-between gap-2 text-xs leading-4 text-muted-foreground tabular-nums"
        >
          <span>Available: {formatUsdc(balance)} USDC</span>
          {estimate ? <span>≈ KES {estimate}</span> : null}
        </p>
        {error ? (
          <p
            id={errorId}
            role="alert"
            className="flex items-center gap-1.5 text-xs leading-4 text-destructive"
          >
            <CircleAlertIcon aria-hidden="true" className="size-3.5" />
            {error}
          </p>
        ) : null}
      </div>
    </form>
  );
}
