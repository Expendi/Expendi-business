"use client";

import type { FormEvent, JSX, ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleAlertIcon,
  EyeIcon,
  KeyRoundIcon,
  LockIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";

import type { Claim, ClaimDetail } from "@expendi-business/shared";
import {
  rejectClaimRequestSchema,
  REJECTION_REASON_MAX_LENGTH,
} from "@expendi-business/shared";

import {
  describeWarning,
  ETIMS_LABELS,
  firstName,
  personName,
  warningKey,
} from "~/app/(company)/expenses/_components/expense-labels";
import { ReceiptGallery } from "~/app/(company)/expenses/_components/receipt-gallery";
import { EntityMark, RowCheckbox } from "~/components/data/cells";
import {
  Callout,
  DetailItem,
  DetailList,
  ReadOnlyNote,
} from "~/components/data/detail-sheet";
import { Money } from "~/components/data/money";
import { Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { Button } from "~/components/ui/button";
import { Textarea } from "~/components/ui/textarea";
import { useAuth } from "~/contexts/auth-context";
import { describeApiError } from "~/lib/api";
import { formatIsoDate } from "~/lib/dates";
import { queryKeys } from "~/lib/query-keys";
import { blockedReason } from "./payment";

export type QueueTab = "waiting" | "failed";

/**
 * A reimbursement with its receipt beside it (spec §6.7 step 1): who and
 * how much, why its payment failed, what to check, and its details.
 * `detail` brings the receipts and the failed payment's reason.
 */
export function ClaimDetailBody({
  claim,
  tab,
  detail,
  detailFailed,
}: {
  claim: Claim;
  tab: QueueTab;
  detail: ClaimDetail | undefined;
  detailFailed: boolean;
}): JSX.Element {
  const blocked = tab === "waiting" ? blockedReason(claim) : null;
  const failure = detail?.payout?.failureReason ?? null;
  return (
    <div>
      <div className="flex items-start gap-3">
        <EntityMark name={personName(claim.submittedBy)} kind="person" />
        <div className="min-w-0 flex-1">
          <h2 className="text-lg leading-[26px] font-(--w-title) [overflow-wrap:anywhere]">
            {claim.merchant}
          </h2>
          <p className="text-muted-foreground">
            {claim.submittedBy.name
              ? `${claim.submittedBy.name} · ${claim.submittedBy.email}`
              : claim.submittedBy.email}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] whitespace-nowrap">
            <Money amount={claim.amountKes} currency="KES" />
          </p>
          <div className="mt-1 flex justify-end">
            {tab === "failed" ? (
              <StatusBadge tone="failed">Payment failed</StatusBadge>
            ) : (
              <StatusBadge tone="waiting">Waiting for approval</StatusBadge>
            )}
          </div>
        </div>
      </div>
      <div className="mt-5 grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] items-start gap-6 max-[1180px]:grid-cols-1">
        <div className="flex min-w-0 flex-col gap-4">
          {failure ? (
            <Callout tone="error" title="Payment failed">
              <p>{failure}</p>
            </Callout>
          ) : null}
          {claim.warnings.length > 0 ? (
            <Callout tone="warn" title="Check before approving">
              <ul className="mt-1 list-disc pl-[18px] [&>li+li]:mt-0.5">
                {claim.warnings.map((warning) => (
                  <li key={warningKey(warning)}>{describeWarning(warning)}</li>
                ))}
              </ul>
            </Callout>
          ) : null}
          {blocked ? (
            <Callout tone="neutral" icon={LockIcon}>
              <p>{blocked}</p>
            </Callout>
          ) : null}
          {claim.description ? (
            <p className="whitespace-pre-wrap text-secondary-foreground">
              {claim.description}
            </p>
          ) : null}
          <DetailList labelWidth="sm">
            <DetailItem label="Spent on">
              {formatIsoDate(claim.spentOn)}
            </DetailItem>
            <DetailItem label="Category">{claim.category.name}</DetailItem>
            <DetailItem label="M-Pesa code">
              {claim.mpesaCode ?? "None"}
            </DetailItem>
            <DetailItem
              label="eTIMS"
              sub={
                claim.etimsInvoiceNumber
                  ? `Invoice ${claim.etimsInvoiceNumber}`
                  : undefined
              }
            >
              {ETIMS_LABELS[claim.etimsStatus]}
            </DetailItem>
          </DetailList>
        </div>
        {detail ? (
          <ReceiptGallery receipts={detail.receipts} tall />
        ) : claim.receiptCount === 0 ? (
          <ReceiptGallery receipts={[]} tall />
        ) : detailFailed ? (
          <Callout tone="error" title="The receipt didn't load">
            <p>Check your connection, then try again.</p>
          </Callout>
        ) : (
          <Skel width="100%" height={340} />
        )}
      </div>
    </div>
  );
}

/** The bar under a reimbursement: what this admin can do with it. */
export function ClaimActions({
  claim,
  tab,
  canAct,
  canPay,
  busy,
  preparing,
  selected,
  selectionFull,
  rejecting,
  onApprove,
  onRetry,
  onToggleSelected,
  onStartReject,
  rejectForm,
}: {
  claim: Claim;
  tab: QueueTab;
  canAct: boolean;
  /** An admin with an approval passkey. */
  canPay: boolean;
  busy: boolean;
  /** This bar's Approve & pay or Retry is working out the cost. */
  preparing: boolean;
  selected: boolean;
  selectionFull: boolean;
  rejecting: boolean;
  onApprove: () => void;
  onRetry: () => void;
  onToggleSelected: () => void;
  onStartReject: () => void;
  rejectForm: ReactNode;
}): JSX.Element {
  if (!canAct) {
    return (
      <ReadOnlyNote icon={EyeIcon}>
        View only. Admins approve and pay.
      </ReadOnlyNote>
    );
  }
  if (rejecting) return <>{rejectForm}</>;
  if (tab === "failed") {
    return canPay ? (
      <Button disabled={busy} onClick={onRetry}>
        {preparing ? (
          "Working out the cost…"
        ) : (
          <>
            <RotateCcwIcon aria-hidden="true" />
            Retry payment
          </>
        )}
      </Button>
    ) : (
      <ReadOnlyNote icon={KeyRoundIcon}>
        Retrying needs your approval passkey.
      </ReadOnlyNote>
    );
  }
  const blocked = blockedReason(claim) !== null;
  return (
    <>
      {canPay ? (
        <Button disabled={blocked || busy} onClick={onApprove}>
          {preparing ? (
            "Working out the cost…"
          ) : (
            <>
              <CheckIcon aria-hidden="true" />
              Approve &amp; pay
            </>
          )}
        </Button>
      ) : null}
      <Button variant="outline" disabled={busy} onClick={onStartReject}>
        Reject
      </Button>
      {canPay && !blocked ? (
        <label className="ml-auto inline-flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
          <RowCheckbox
            checked={selected}
            disabled={busy || (!selected && selectionFull)}
            onChange={onToggleSelected}
          />
          Add to selection
        </label>
      ) : null}
    </>
  );
}

/** Rejecting needs a reason the person sees, so they know what to fix (spec §5). */
export function RejectForm({
  organizationId,
  claim,
  onCancel,
  onRejected,
}: {
  organizationId: string;
  claim: Claim;
  onCancel: () => void;
  onRejected: () => void;
}): JSX.Element {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const id = useId();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const [reason, setReason] = useState("");
  const [invalid, setInvalid] = useState<string | null>(null);
  const reject = useMutation({
    mutationFn: (valid: string) =>
      api.rejectClaim(organizationId, claim.id, valid),
    onSuccess: async () => {
      onRejected();
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: queryKeys.claims(organizationId),
        }),
        queryClient.invalidateQueries({
          queryKey: queryKeys.expenses(organizationId),
        }),
      ]);
    },
  });

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = rejectClaimRequestSchema.safeParse({ reason });
    if (!parsed.success) {
      setInvalid(parsed.error.issues[0]?.message ?? "Say why it's rejected.");
      textRef.current?.focus();
      return;
    }
    setInvalid(null);
    reject.mutate(parsed.data.reason);
  }

  const error =
    invalid ?? (reject.isError ? describeApiError(reject.error) : null);
  return (
    <form
      onSubmit={onSubmit}
      aria-label={`Reject ${claim.merchant}`}
      className="flex w-full flex-col gap-2"
    >
      <label htmlFor={`${id}-reason`} className="text-sm text-foreground">
        Why are you rejecting it? They&apos;ll see this.
      </label>
      <Textarea
        ref={textRef}
        id={`${id}-reason`}
        value={reason}
        onChange={(event) => {
          setReason(event.target.value);
          setInvalid(null);
        }}
        maxLength={REJECTION_REASON_MAX_LENGTH}
        rows={3}
        aria-invalid={invalid !== null || undefined}
        aria-describedby={`${id}-meta`}
        className="min-h-[88px]"
      />
      <div
        id={`${id}-meta`}
        className="flex justify-between gap-2 text-xs leading-4 text-muted-foreground"
      >
        <span>{firstName(claim.submittedBy)} gets this in the app.</span>
        <span className="tabular-nums">
          {reason.length}/{REJECTION_REASON_MAX_LENGTH}
        </span>
      </div>
      {error ? (
        <p
          role="alert"
          className="flex items-center gap-1.5 text-xs leading-4 text-destructive"
        >
          <CircleAlertIcon aria-hidden="true" className="size-3.5 shrink-0" />
          {error}
        </p>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" size="md" disabled={reject.isPending}>
          {reject.isPending ? "Rejecting…" : "Reject reimbursement"}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={onCancel}
          disabled={reject.isPending}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
