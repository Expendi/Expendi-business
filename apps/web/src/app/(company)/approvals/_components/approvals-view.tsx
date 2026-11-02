"use client";

import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";

import type {
  ClaimApproval,
  ClaimPaymentResult,
  ClaimsPage,
  ExpenseStatus,
} from "@expendi-business/shared";
import { CLAIM_APPROVAL_MAX_CLAIMS } from "@expendi-business/shared";

import type { PaymentRequest, PreparedPayment } from "./payment";
import { ApprovalPasskeyGate } from "~/components/approval-passkey-gate";
import {
  alertClass,
  primaryButton,
  secondaryButton,
  textButton,
} from "~/components/styles";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { isChallengeFresh } from "~/lib/approval";
import { formatKesCents, sumUnits } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";
import { usePasskeyApproval } from "~/lib/use-approval";
import { ClaimCard, RejectClaim } from "./claim-card";
import {
  blockedReason,
  CostChangedError,
  describePaymentError,
  preparePayment,
  sameCost,
  toggleSelection,
} from "./payment";
import { PaymentResultNotice, PaymentReview } from "./payment-review";

/** One passkey approves at most this many, so a page is one batch. */
const PAGE_SIZE = CLAIM_APPROVAL_MAX_CLAIMS;

/**
 * The approval queue (spec §6.7, §6.14): each claim with its receipt
 * beside it. Admins select up to 20 and confirm them with one passkey,
 * each paid as its own payout; reject with a reason; retry a failed
 * payment. Accountants see the same, with no actions.
 */
export function ApprovalsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyApprovals
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

type ClaimQueue = UseInfiniteQueryResult<InfiniteData<ClaimsPage>>;

function useClaimQueue(
  organizationId: string,
  status: ExpenseStatus,
): ClaimQueue {
  const { api } = useAuth();
  return useInfiniteQuery({
    queryKey: queryKeys.claimQueue(organizationId, status),
    queryFn: ({ pageParam }) =>
      api.listClaims(organizationId, {
        status,
        limit: PAGE_SIZE,
        cursor: pageParam ?? undefined,
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });
}

function CompanyApprovals({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const { api } = useAuth();
  const queryClient = useQueryClient();
  const waiting = useClaimQueue(organizationId, "submitted");
  const failed = useClaimQueue(organizationId, "payout_failed");
  const [selected, setSelected] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [result, setResult] = useState<ClaimPaymentResult | null>(null);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.claims(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.expenses(organizationId),
      }),
    ]);

  const pay = usePasskeyApproval<
    PreparedPayment,
    ClaimApproval,
    ClaimPaymentResult
  >({
    request: async ({ request, approval, preparedAt }) => {
      if (isChallengeFresh(preparedAt, Date.now())) return approval;
      const fresh = await preparePayment(api, organizationId, request);
      if (!sameCost(approval, fresh)) throw new CostChangedError(fresh);
      return fresh;
    },
    confirm: (challenge, assertion) =>
      api.confirmClaimApproval(
        organizationId,
        challenge.challengeId,
        assertion,
      ),
    onApproved: async (paid) => {
      setResult(paid);
      setPrepared(null);
      setSelected([]);
      await refresh();
    },
  });

  const prepare = useMutation({
    mutationFn: async (request: PaymentRequest): Promise<PreparedPayment> => ({
      request,
      approval: await preparePayment(api, organizationId, request),
      preparedAt: Date.now(),
    }),
    onSuccess: (payment) => {
      pay.reset();
      setPrepared(payment);
      setResult(null);
    },
  });

  function onPay(payment: PreparedPayment) {
    pay.mutate(payment, {
      onError: (error) => {
        if (error instanceof CostChangedError) {
          setPrepared({
            ...payment,
            approval: error.fresh,
            preparedAt: Date.now(),
          });
          return;
        }
        // The confirmation may have reached the API; show where things stand.
        setPrepared(null);
        void refresh();
      },
    });
  }

  const waitingClaims =
    waiting.data?.pages.flatMap((page) => page.claims) ?? [];
  const selectedClaims = waitingClaims.filter((claim) =>
    selected.includes(claim.id),
  );
  const busy = prepare.isPending || pay.isPending || prepared !== null;
  const actionError = prepare.isError
    ? describePaymentError(prepare.error)
    : pay.isError
      ? describePaymentError(pay.error)
      : null;

  return (
    <section className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Approvals</h1>
        <p className="mt-1 text-sm text-stone-600">
          {canAct
            ? `Check each receipt, then approve and pay up to ${String(CLAIM_APPROVAL_MAX_CLAIMS)} claims with one passkey. Each claim is paid on its own.`
            : "Claims waiting for an admin, and payments that failed. Only admins approve and pay."}
        </p>
      </div>

      {result ? (
        <PaymentResultNotice
          result={result}
          onDismiss={() => setResult(null)}
        />
      ) : null}

      {canAct ? (
        <ApprovalPasskeyGate>
          {prepared ? (
            <PaymentReview
              approval={prepared.approval}
              isRetry={prepared.request.kind === "retry"}
              paying={pay.isPending}
              onPay={() => onPay(prepared)}
              onCancel={() => {
                pay.reset();
                setPrepared(null);
              }}
            />
          ) : (
            <div className="flex flex-wrap items-center gap-4 rounded-lg border border-stone-200 bg-white p-4">
              <p className="text-sm text-stone-700">
                {selectedClaims.length === 0
                  ? "Select claims to approve and pay."
                  : `${String(selectedClaims.length)} selected · KES ${formatKesCents(sumUnits(selectedClaims.map((claim) => claim.amountKes)))} claimed`}
              </p>
              <button
                type="button"
                disabled={selectedClaims.length === 0 || prepare.isPending}
                onClick={() =>
                  prepare.mutate({
                    kind: "approve",
                    claimIds: selectedClaims.map((claim) => claim.id),
                  })
                }
                className={primaryButton}
              >
                {prepare.isPending ? "Working out the cost…" : "Approve & pay"}
              </button>
              {selectedClaims.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSelected([])}
                  className={textButton}
                >
                  Clear selection
                </button>
              ) : null}
            </div>
          )}
        </ApprovalPasskeyGate>
      ) : null}

      {pay.data?.status === "cancelled" && prepared ? (
        <p className="text-sm text-stone-600">Cancelled. Nothing was sent.</p>
      ) : null}
      {actionError ? (
        <p className={alertClass} role="alert">
          {actionError}
        </p>
      ) : null}

      <QueueSection
        title="Waiting for approval"
        empty="Nothing to approve. New claims show up here."
        queue={waiting}
        renderClaim={(claim) => {
          const blocked = blockedReason(claim);
          const checked = selected.includes(claim.id);
          return (
            <ClaimCard
              key={claim.id}
              organizationId={organizationId}
              claim={claim}
              blockedReason={blocked}
              selection={
                canAct
                  ? {
                      checked,
                      disabled:
                        busy ||
                        blocked !== null ||
                        (!checked &&
                          selected.length >= CLAIM_APPROVAL_MAX_CLAIMS),
                      onToggle: () =>
                        setSelected((current) =>
                          toggleSelection(current, claim.id),
                        ),
                    }
                  : null
              }
              actions={
                canAct ? (
                  <RejectClaim
                    organizationId={organizationId}
                    claimId={claim.id}
                    disabled={busy}
                    onRejected={() =>
                      setSelected((current) =>
                        current.filter((id) => id !== claim.id),
                      )
                    }
                  />
                ) : null
              }
            />
          );
        }}
      />

      <QueueSection
        title="Payment failed"
        empty={null}
        queue={failed}
        renderClaim={(claim) => (
          <ClaimCard
            key={claim.id}
            organizationId={organizationId}
            claim={claim}
            blockedReason={null}
            selection={null}
            actions={
              canAct ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    prepare.mutate({ kind: "retry", claimId: claim.id })
                  }
                  className={secondaryButton}
                >
                  Retry payment
                </button>
              ) : null
            }
          />
        )}
      />
    </section>
  );
}

function QueueSection({
  title,
  empty,
  queue,
  renderClaim,
}: {
  title: string;
  /** Null hides the section while it's empty. */
  empty: string | null;
  queue: ClaimQueue;
  renderClaim: (claim: ClaimsPage["claims"][number]) => JSX.Element;
}): JSX.Element | null {
  const claims = queue.data?.pages.flatMap((page) => page.claims) ?? [];
  if (queue.isSuccess && claims.length === 0 && empty === null) return null;

  return (
    <section aria-label={title} className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {queue.isPending ? (
        <p className="text-sm text-stone-500">Loading…</p>
      ) : queue.isError ? (
        <div className="text-sm text-error-700" role="alert">
          <p>{describeApiError(queue.error)}</p>
          <button
            type="button"
            onClick={() => void queue.refetch()}
            className={`mt-2 ${secondaryButton}`}
          >
            Try again
          </button>
        </div>
      ) : claims.length === 0 ? (
        <p className="rounded-lg border border-dashed border-stone-300 bg-white p-6 text-sm text-stone-600">
          {empty}
        </p>
      ) : (
        <>
          {claims.map(renderClaim)}
          {queue.hasNextPage ? (
            <button
              type="button"
              onClick={() => void queue.fetchNextPage()}
              disabled={queue.isFetchingNextPage}
              className={secondaryButton}
            >
              {queue.isFetchingNextPage ? "Loading…" : "Load more"}
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
