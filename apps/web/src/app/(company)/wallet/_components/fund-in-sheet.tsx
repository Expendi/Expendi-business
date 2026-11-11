"use client";

import type { FormEvent, JSX } from "react";
import { ArrowDownLeftIcon } from "lucide-react";
import { useId, useState } from "react";

import type {
  FundIn,
  FundInChain,
  FundInRequest,
} from "@expendi-business/shared";
import { FUND_IN_CHAIN_NAMES, FUND_IN_CHAINS } from "@expendi-business/shared";

import type { FundInFieldErrors } from "./fund-in-display";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  SectionLabel,
  SheetActions,
} from "~/components/data/detail-sheet";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { describeApiError } from "~/lib/api";
import { formatUsdc } from "~/lib/money";
import { CopyButton } from "./copy-button";
import { FUND_IN_STATUS, fundInDraft } from "./fund-in-display";
import { RailRow } from "./rail-cards";
import { GroupedAddress } from "./tx-sheet";
import { useFundIn, useFundIns, useStartFundIn } from "./wallet-api";
import { happenedAt, nairobiDay } from "./wallet-display";

const RECENT_FUND_INS = 5;

/**
 * Fund-in from another chain: the admin says which chain the USDC comes
 * from and how much, and gets a one-time deposit
 * address. The sheet then follows the fund-in until it reaches the company
 * wallet, is refunded, or expires.
 */
export function FundInSheet({
  open,
  organizationId,
  onClose,
}: {
  open: boolean;
  organizationId: string;
  onClose: () => void;
}): JSX.Element {
  const formId = useId();
  const start = useStartFundIn(organizationId);
  const [fundInId, setFundInId] = useState<string | null>(null);

  return (
    <DetailSheet
      open={open}
      onClose={onClose}
      dismissible={!start.isPending}
      eyebrow={fundInId ? "Fund-in" : "Company wallet"}
      title="Fund in from another chain"
      footer={
        fundInId ? (
          <SheetActions kind="primary">
            <Button onClick={onClose}>Done</Button>
            <Button
              variant="outline"
              onClick={() => {
                start.reset();
                setFundInId(null);
              }}
            >
              Start another
            </Button>
          </SheetActions>
        ) : (
          <SheetActions kind="primary">
            <Button type="submit" form={formId} disabled={start.isPending}>
              {start.isPending ? "Getting the address…" : "Get deposit address"}
            </Button>
            <Button
              variant="outline"
              disabled={start.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
          </SheetActions>
        )
      }
    >
      {fundInId ? (
        <FundInProgress organizationId={organizationId} fundInId={fundInId} />
      ) : (
        <>
          <FundInForm
            formId={formId}
            busy={start.isPending}
            onStart={(request) =>
              start.mutate(request, {
                onSuccess: (fundIn) => setFundInId(fundIn.id),
              })
            }
          />
          {start.isError ? (
            <Callout tone="error">{describeApiError(start.error)}</Callout>
          ) : null}
          <RecentFundIns organizationId={organizationId} onOpen={setFundInId} />
        </>
      )}
    </DetailSheet>
  );
}

function FundInForm({
  formId,
  busy,
  onStart,
}: {
  formId: string;
  busy: boolean;
  onStart: (request: FundInRequest) => void;
}): JSX.Element {
  const chainId = useId();
  const amountId = useId();
  const [chain, setChain] = useState<FundInChain>("base");
  const [amount, setAmount] = useState("");
  const [errors, setErrors] = useState<FundInFieldErrors>({});

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const draft = fundInDraft(chain, amount);
    if (!draft.ok) {
      setErrors(draft.errors);
      return;
    }
    setErrors({});
    onStart(draft.request);
  }

  return (
    <form
      id={formId}
      noValidate
      onSubmit={onSubmit}
      aria-label="Fund in from another chain"
      className="flex flex-col gap-[18px]"
    >
      <Field>
        <FieldLabel htmlFor={chainId}>
          Chain you&apos;re sending from
        </FieldLabel>
        <NativeSelect
          id={chainId}
          className="w-full"
          value={chain}
          disabled={busy}
          onChange={(event) => {
            const next = FUND_IN_CHAINS.find(
              (candidate) => candidate === event.target.value,
            );
            if (next) {
              setChain(next);
              setErrors({});
            }
          }}
        >
          {FUND_IN_CHAINS.map((candidate) => (
            <NativeSelectOption key={candidate} value={candidate}>
              {FUND_IN_CHAIN_NAMES[candidate]}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Field>
        <FieldLabel htmlFor={amountId}>Amount (USDC)</FieldLabel>
        <Input
          id={amountId}
          inputMode="decimal"
          placeholder="0.00"
          autoComplete="off"
          value={amount}
          disabled={busy}
          onChange={(event) => setAmount(event.target.value)}
          className="tabular-nums"
          aria-invalid={errors.amount ? true : undefined}
        />
        <FieldDescription>
          If the fund-in can&apos;t be completed, the USDC comes back to your
          company wallet.
        </FieldDescription>
        {errors.amount ? <FieldError>{errors.amount}</FieldError> : null}
      </Field>
    </form>
  );
}

function fundInTitle(fundIn: FundIn): string {
  return `${formatUsdc(fundIn.amountIn)} USDC from ${FUND_IN_CHAIN_NAMES[fundIn.chain]}`;
}

/** The latest fund-ins, so one can be reopened after the sheet was closed. */
function RecentFundIns({
  organizationId,
  onOpen,
}: {
  organizationId: string;
  onOpen: (fundInId: string) => void;
}): JSX.Element | null {
  const fundIns = useFundIns(organizationId);
  const today = nairobiDay(new Date());
  if (fundIns.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skel width="70%" height={14} />
        <Skel width="55%" height={14} />
      </div>
    );
  }
  if (fundIns.isError) {
    return (
      <Callout
        tone="error"
        action={
          <Button
            variant="outline"
            size="md"
            onClick={() => void fundIns.refetch()}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(fundIns.error)}
      </Callout>
    );
  }
  if (fundIns.data.length === 0) return null;
  return (
    <section aria-label="Recent fund-ins">
      <SectionLabel>Recent fund-ins</SectionLabel>
      <ul className="m-0 mt-2 list-none p-0">
        {fundIns.data.slice(0, RECENT_FUND_INS).map((fundIn) => (
          <RailRow
            key={fundIn.id}
            icon={ArrowDownLeftIcon}
            title={fundInTitle(fundIn)}
            detail={`${FUND_IN_STATUS[fundIn.status].label} · ${happenedAt(fundIn.createdAt, today)}`}
            action={
              <Button
                variant="ghost"
                size="sm"
                aria-label={`Open ${fundInTitle(fundIn)}`}
                onClick={() => onOpen(fundIn.id)}
              >
                Open
              </Button>
            }
          />
        ))}
      </ul>
    </section>
  );
}

/** One fund-in: what to send where, and how far it has got. */
function FundInProgress({
  organizationId,
  fundInId,
}: {
  organizationId: string;
  fundInId: string;
}): JSX.Element {
  const fundIn = useFundIn(organizationId, fundInId);
  if (fundIn.isPending) {
    return (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skel width="100%" height={60} />
        <Skel width="100%" height={56} />
      </div>
    );
  }
  if (!fundIn.data) {
    return (
      <Callout
        tone="error"
        action={
          <Button
            variant="outline"
            size="md"
            onClick={() => void fundIn.refetch()}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(fundIn.error)}
      </Callout>
    );
  }
  return <FundInDetails fundIn={fundIn.data} />;
}

export function FundInDetails({ fundIn }: { fundIn: FundIn }): JSX.Element {
  const status = FUND_IN_STATUS[fundIn.status];
  const chainName = FUND_IN_CHAIN_NAMES[fundIn.chain];
  const awaiting = fundIn.status === "awaiting_deposit";
  return (
    <>
      <div className="flex flex-col items-start gap-1">
        <p className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] tabular-nums">
          {formatUsdc(fundIn.amountIn)}{" "}
          <span className="text-[0.6em] font-(--w-ui) tracking-[0.04em] text-gray-500">
            USDC
          </span>
        </p>
        <StatusBadge tone={status.tone}>{status.label}</StatusBadge>
      </div>
      <p role="status" className="text-sm text-gray-600">
        {status.note}
      </p>
      <DetailList>
        <DetailItem label="Send exactly">
          {formatUsdc(fundIn.amountIn)} USDC
        </DetailItem>
        <DetailItem label="On">{chainName}</DetailItem>
        <DetailItem label="To this address">
          <GroupedAddress address={fundIn.depositAddress} />
        </DetailItem>
        <DetailItem label="Arrives in the wallet">
          {formatUsdc(fundIn.amountOut)} USDC
        </DetailItem>
        <DetailItem label="Send by">
          {happenedAt(fundIn.deadline, nairobiDay(new Date()))}
        </DetailItem>
      </DetailList>
      {awaiting ? (
        <>
          <CopyButton value={fundIn.depositAddress} label="Copy address" />
          <Callout tone="warn">
            Send only USDC on {chainName}, in one transfer of exactly this
            amount. This address works once: if the fund-in can&apos;t be
            completed, the USDC comes back to your company wallet.
          </Callout>
        </>
      ) : null}
    </>
  );
}
