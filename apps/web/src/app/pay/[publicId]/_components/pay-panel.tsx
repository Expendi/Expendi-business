"use client";

import type { JSX, ReactNode } from "react";
import { cn } from "cn";
import {
  CheckIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CopyIcon,
  LoaderCircleIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import QRCode from "react-qr-code";

import type {
  FundInChain,
  PublicInvoice,
  PublicPayQuote,
} from "@expendi-business/shared";
import { FUND_IN_CHAIN_NAMES } from "@expendi-business/shared";

import { Button } from "~/components/ui/button";
import { formatCountdown, formatUsdcAmount } from "./pay-format";

export type PayState =
  | { kind: "idle" }
  | { kind: "creating"; chain: FundInChain }
  | { kind: "failed"; chain: FundInChain; message: string }
  | { kind: "quote"; quote: PublicPayQuote };

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function selectedChain(state: PayState): FundInChain | null {
  return state.kind === "idle"
    ? null
    : state.kind === "quote"
      ? state.quote.chain
      : state.chain;
}

/** "Pay with USDC": pick a chain, then send the exact amount to the address. */
export function PayPanel({
  invoice,
  state,
  receiptEmail,
  onChoose,
}: {
  invoice: PublicInvoice;
  state: PayState;
  receiptEmail: string;
  onChoose: (chain: FundInChain) => void;
}): JSX.Element {
  const chosen = selectedChain(state);
  const quote = state.kind === "quote" ? state.quote : null;
  const finished = quote?.status === "paid";

  return (
    <section
      aria-labelledby="pay-heading"
      className="rounded-panel border border-gray-200 bg-surface p-5 shadow-panel sm:p-8 print:hidden"
    >
      <h2
        id="pay-heading"
        className="text-lg leading-[26px] font-(--w-title) text-gray-900"
      >
        Pay with USDC
      </h2>

      {finished ? null : (
        <>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose the network you are sending from.
          </p>
          <div
            role="group"
            aria-label="Network"
            className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4"
          >
            {invoice.chains.map((chain) => (
              <Button
                key={chain}
                variant="outline"
                aria-pressed={chain === chosen}
                disabled={state.kind === "creating"}
                className={cn(
                  chain === chosen &&
                    "border-primary bg-accent text-accent-foreground hover:bg-accent",
                )}
                onClick={() => {
                  if (chain !== chosen || state.kind === "failed") {
                    onChoose(chain);
                  }
                }}
              >
                {FUND_IN_CHAIN_NAMES[chain]}
              </Button>
            ))}
          </div>
        </>
      )}

      {state.kind === "creating" ? (
        <p
          role="status"
          className="mt-6 flex items-center gap-2 text-sm text-gray-700"
        >
          <LoaderCircleIcon
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
          Getting your {FUND_IN_CHAIN_NAMES[state.chain]} deposit address
        </p>
      ) : null}

      {state.kind === "failed" ? (
        <p
          role="alert"
          className="mt-6 flex items-start gap-2 text-sm text-error-700"
        >
          <CircleAlertIcon
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0"
          />
          {state.message}
        </p>
      ) : null}

      {quote === null ? null : (
        <QuoteDetails
          quote={quote}
          from={invoice.from.name}
          receiptEmail={receiptEmail}
          onNewAddress={() => onChoose(quote.chain)}
        />
      )}
    </section>
  );
}

function QuoteDetails({
  quote,
  from,
  receiptEmail,
  onNewAddress,
}: {
  quote: PublicPayQuote;
  from: string;
  receiptEmail: string;
  onNewAddress: () => void;
}): JSX.Element {
  switch (quote.status) {
    case "awaiting_deposit":
      return <DepositInstructions quote={quote} />;
    case "processing":
      return (
        <Outcome
          icon={
            <LoaderCircleIcon
              aria-hidden="true"
              className="size-5 motion-safe:animate-spin"
            />
          }
          title="Payment received, confirming"
        >
          This usually takes a minute or two. You can keep this page open.
        </Outcome>
      );
    case "paid":
      return (
        <Outcome
          tone="success"
          icon={<CircleCheckIcon aria-hidden="true" className="size-5" />}
          title={`Paid. A receipt is on its way to ${receiptEmail}`}
        />
      );
    case "needs_attention":
      return (
        <Outcome
          tone="error"
          icon={<CircleAlertIcon aria-hidden="true" className="size-5" />}
          title="We received a payment that didn't match"
        >
          {from} will confirm it with you.
        </Outcome>
      );
    case "expired":
      return (
        <Outcome
          tone="error"
          icon={<CircleAlertIcon aria-hidden="true" className="size-5" />}
          title="This address expired"
          action={<Button onClick={onNewAddress}>Get a new address</Button>}
        >
          Don&apos;t send anything to it. Get a new address to pay.
        </Outcome>
      );
  }
}

function Outcome({
  icon,
  title,
  tone = "neutral",
  action,
  children,
}: {
  icon: ReactNode;
  title: string;
  tone?: "neutral" | "success" | "error";
  action?: ReactNode;
  children?: ReactNode;
}): JSX.Element {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "mt-6 flex items-start gap-3 rounded-control p-4",
        tone === "success" && "bg-success-50 text-success-700",
        tone === "error" && "bg-error-50 text-error-700",
        tone === "neutral" && "bg-gray-50 text-gray-900",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <div className="flex min-w-0 flex-col items-start gap-1">
        <p className="text-base leading-6 font-(--w-title)">{title}</p>
        {children ? <p className="text-sm">{children}</p> : null}
        {action ? <div className="mt-3">{action}</div> : null}
      </div>
    </div>
  );
}

function DepositInstructions({
  quote,
}: {
  quote: PublicPayQuote;
}): JSX.Element {
  const network = FUND_IN_CHAIN_NAMES[quote.chain];
  const now = useNow(true);
  const deadlineMs = Date.parse(quote.deadline);
  const countdown = formatCountdown(deadlineMs - now);

  return (
    <div className="mt-6 flex flex-col gap-6">
      <p
        role="status"
        className="flex items-center gap-2 text-sm font-(--w-ui) text-gray-900"
      >
        <LoaderCircleIcon
          aria-hidden="true"
          className="size-4 motion-safe:animate-spin"
        />
        Waiting for your payment
      </p>

      <div className="flex flex-col items-center gap-6 sm:flex-row sm:items-start">
        <div
          className="shrink-0 rounded-panel border border-gray-200 bg-white p-3"
          role="img"
          aria-label={`QR code of the ${network} deposit address`}
        >
          <QRCode value={quote.depositAddress} size={160} level="M" />
        </div>
        <dl className="flex w-full min-w-0 flex-col gap-4">
          <Field label="Send exactly">
            <span className="text-2xl leading-8 text-gray-900 tabular-nums">
              {formatUsdcAmount(quote.amountIn)}{" "}
              <span className="text-base text-muted-foreground">USDC</span>
            </span>
          </Field>
          <Field label="Network">
            <span className="text-base text-gray-900">{network}</span>
          </Field>
          <Field label="Deposit address">
            <span className="font-mono text-sm break-all text-gray-900">
              {quote.depositAddress}
            </span>
            <CopyButton value={quote.depositAddress} />
          </Field>
          <Field label="Address expires in">
            <span
              className="text-base text-gray-900 tabular-nums"
              data-testid="countdown"
            >
              {countdown ?? "Expired"}
            </span>
          </Field>
        </dl>
      </div>

      <ul className="flex list-disc flex-col gap-1 rounded-control bg-warn-50 py-3 pr-4 pl-8 text-sm text-warn-700">
        <li>
          Send only USDC on {network}. Other tokens or networks will not be
          credited.
        </li>
        <li>Send exactly this amount, in one transfer.</li>
        <li>
          A different amount, token or network won&apos;t mark the invoice paid.
        </li>
      </ul>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1">
      <dt className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
        {label}
      </dt>
      <dd className="flex min-w-0 flex-col items-start gap-2">{children}</dd>
    </div>
  );
}

type CopyState = "idle" | "copied" | "failed";

function CopyButton({ value }: { value: string }): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Button variant="outline" size="md" onClick={() => void copy()}>
      {state === "copied" ? (
        <CheckIcon aria-hidden="true" />
      ) : (
        <CopyIcon aria-hidden="true" />
      )}
      <span aria-live="polite">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Copy failed, select the address"
            : "Copy address"}
      </span>
    </Button>
  );
}
