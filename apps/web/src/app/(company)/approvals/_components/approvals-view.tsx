"use client";

import type {
  InfiniteData,
  UseInfiniteQueryResult,
} from "@tanstack/react-query";
import type { JSX } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { cn } from "cn";
import { KeyRoundIcon } from "lucide-react";
import { useState, useSyncExternalStore } from "react";

import type {
  Claim,
  ClaimApproval,
  ClaimPaymentResult,
  ClaimsPage,
  ExpenseStatus,
} from "@expendi-business/shared";
import { CLAIM_APPROVAL_MAX_CLAIMS } from "@expendi-business/shared";

import type { QueueTab } from "./claim-detail";
import type { QueueState } from "./claim-queue";
import type { PaymentRequest, PreparedPayment } from "./payment";
import { firstName } from "~/app/(company)/expenses/_components/expense-labels";
import { Banner, Banners } from "~/components/data/banner";
import { DetailSheet, SheetActions } from "~/components/data/detail-sheet";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import { Skel } from "~/components/data/states";
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { navCountKeys } from "~/hooks/use-nav-counts";
import { describeApiError } from "~/lib/api";
import { isChallengeFresh } from "~/lib/approval";
import { useRefreshWhenSettled } from "~/lib/payment-poll";
import { queryKeys } from "~/lib/query-keys";
import {
  useApprovalPasskeyStatus,
  usePasskeyApproval,
} from "~/lib/use-approval";
import { ClaimActions, ClaimDetailBody, RejectForm } from "./claim-detail";
import { ClaimQueue } from "./claim-queue";
import {
  CostChangedError,
  describePaymentError,
  describePaymentResult,
  payingClaimsQuery,
  preparePayment,
  sameCost,
} from "./payment";
import { PaymentReview } from "./payment-review";

/** One passkey approves at most this many, so a page is one batch. */
const PAGE_SIZE = CLAIM_APPROVAL_MAX_CLAIMS;

/** Under this width the pane hides and a reimbursement opens in a side sheet. */
const NARROW = "(max-width: 1023px)";

function subscribeNarrow(onChange: () => void) {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function useNarrow(): boolean {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** A message under the header after something was done. */
type Notice =
  | { readonly kind: "paid"; readonly result: ClaimPaymentResult }
  | { readonly kind: "rejected"; readonly name: string };

/**
 * The approval queue (spec §6.7, §6.14): each reimbursement with its
 * receipt beside it. Admins with a passkey select up to 20 and confirm them
 * with one passkey, each paid on its own; reject with a reason; retry a
 * failed payment. Accountants see the same, with no actions.
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

type ClaimQueueResult = UseInfiniteQueryResult<InfiniteData<ClaimsPage>>;

function useClaimQueue(
  organizationId: string,
  status: ExpenseStatus,
): ClaimQueueResult {
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

function queueState(queue: ClaimQueueResult): QueueState {
  return {
    isPending: queue.isPending,
    isError: queue.isError,
    hasNextPage: queue.hasNextPage,
    isFetchingNextPage: queue.isFetchingNextPage,
    refetch: () => void queue.refetch(),
    fetchNextPage: () => void queue.fetchNextPage(),
  };
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
  const passkey = useApprovalPasskeyStatus(canAct);
  const canPay = canAct && passkey.data?.enrolled === true;
  const summary = useQuery({
    queryKey: navCountKeys.claimsSummary(organizationId),
    queryFn: () => api.getClaimsSummary(organizationId),
  });
  const waiting = useClaimQueue(organizationId, "submitted");
  const failed = useClaimQueue(organizationId, "payout_failed");

  const [claimId, setClaimId] = useDeepLinkParam("claimId");
  const narrow = useNarrow();
  const [chosenTab, setChosenTab] = useState<QueueTab>("waiting");
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [prepared, setPrepared] = useState<PreparedPayment | null>(null);
  const [costChanged, setCostChanged] = useState(false);
  const [preparingFrom, setPreparingFrom] = useState<"bar" | "row">("row");
  const [notice, setNotice] = useState<Notice | null>(null);

  const waitingClaims =
    waiting.data?.pages.flatMap((page) => page.claims) ?? [];
  const failedClaims = failed.data?.pages.flatMap((page) => page.claims) ?? [];
  const failedCount =
    summary.data?.payoutFailed.count ?? (failed.data ? failedClaims.length : 0);
  const showFailed = failedCount > 0 || failedClaims.length > 0;
  const linkedTab: QueueTab | null = waitingClaims.some(
    (claim) => claim.id === claimId,
  )
    ? "waiting"
    : failedClaims.some((claim) => claim.id === claimId)
      ? "failed"
      : null;
  const tab: QueueTab =
    linkedTab ?? (chosenTab === "failed" && showFailed ? "failed" : "waiting");
  const queue = tab === "waiting" ? waiting : failed;
  const claims = tab === "waiting" ? waitingClaims : failedClaims;
  const linked = claims.find((claim) => claim.id === claimId);
  const active = linked ?? claims[0];

  const detail = useQuery({
    queryKey: queryKeys.claim(organizationId, active?.id ?? ""),
    queryFn: () => api.getClaim(organizationId, active?.id ?? ""),
    enabled: active !== undefined,
  });

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({
        queryKey: queryKeys.claims(organizationId),
      }),
      queryClient.invalidateQueries({
        queryKey: queryKeys.expenses(organizationId),
      }),
    ]);
  const paying = useQuery(payingClaimsQuery(api, organizationId));
  useRefreshWhenSettled(paying.data?.claims.length ?? 0, refresh);

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
      setNotice({ kind: "paid", result: paid });
      setPrepared(null);
      setSelected([]);
      setClaimId(null);
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
      setCostChanged(false);
      setPrepared(payment);
      setNotice(null);
    },
  });

  function startPayment(request: PaymentRequest, from: "bar" | "row") {
    setPreparingFrom(from);
    prepare.mutate(request);
  }

  function onPay(payment: PreparedPayment) {
    pay.mutate(payment, {
      onError: (error) => {
        if (error instanceof CostChangedError) {
          setCostChanged(true);
          setPrepared({
            ...payment,
            approval: error.fresh,
            preparedAt: Date.now(),
          });
          pay.reset();
          return;
        }
        // The confirmation may have reached the API; show where things stand.
        setPrepared(null);
        void refresh();
      },
    });
  }

  function closeReview() {
    pay.reset();
    setPrepared(null);
    setCostChanged(false);
  }

  function activate(next: string) {
    setChosenTab(tab);
    setClaimId(next);
    setRejectingId(null);
  }

  function changeTab(next: QueueTab) {
    setChosenTab(next);
    setClaimId(null);
    setRejectingId(null);
  }

  const busy = prepare.isPending || pay.isPending || prepared !== null;
  const actionError = prepare.isError
    ? describePaymentError(prepare.error)
    : pay.isError
      ? describePaymentError(pay.error)
      : null;
  const showPane = queue.isPending || (!queue.isError && claims.length > 0);

  function actionsFor(claim: Claim) {
    return (
      <ClaimActions
        claim={claim}
        tab={tab}
        canAct={canAct}
        canPay={canPay}
        busy={busy}
        preparing={
          prepare.isPending &&
          preparingFrom === "row" &&
          requestIncludes(prepare.variables, claim.id)
        }
        selected={selected.includes(claim.id)}
        selectionFull={selected.length >= CLAIM_APPROVAL_MAX_CLAIMS}
        rejecting={rejectingId === claim.id}
        onApprove={() =>
          startPayment({ kind: "approve", claimIds: [claim.id] }, "row")
        }
        onRetry={() =>
          startPayment({ kind: "retry", claimId: claim.id }, "row")
        }
        onToggleSelected={() =>
          setSelected((now) =>
            now.includes(claim.id)
              ? now.filter((id) => id !== claim.id)
              : now.length < CLAIM_APPROVAL_MAX_CLAIMS
                ? [...now, claim.id]
                : now,
          )
        }
        onStartReject={() => setRejectingId(claim.id)}
        rejectForm={
          <RejectForm
            organizationId={organizationId}
            claim={claim}
            onCancel={() => setRejectingId(null)}
            onRejected={() => {
              setRejectingId(null);
              setClaimId(null);
              setSelected((now) => now.filter((id) => id !== claim.id));
              setNotice({
                kind: "rejected",
                name: firstName(claim.submittedBy),
              });
            }}
          />
        }
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Approvals"
        subtitle={
          canAct
            ? `Check each receipt, then approve and pay up to ${String(CLAIM_APPROVAL_MAX_CLAIMS)} reimbursements with one passkey. Each one is paid on its own.`
            : "Reimbursements waiting for an admin, and payments that failed. Only admins approve and pay."
        }
      />

      <div className="mt-5">
        <KindTabs<QueueTab>
          label="Queues"
          variant="page"
          controls="approval-queue"
          value={tab}
          onChange={changeTab}
          tabs={[
            {
              value: "waiting",
              label: "Waiting for approval",
              count: summary.data?.waiting.count,
            },
            ...(showFailed
              ? [
                  {
                    value: "failed" as const,
                    label: "Payment failed",
                    count: summary.data?.payoutFailed.count,
                    tone: "error" as const,
                  },
                ]
              : []),
          ]}
        />
      </div>

      <Banners>
        {canAct && passkey.data && !passkey.data.enrolled ? (
          <Banner
            role="note"
            icon={KeyRoundIcon}
            title="Set up your approval passkey first"
          >
            Paying needs your approval passkey. Set it up in the Expendi
            Business app; then confirm here with “use a phone or tablet” in your
            browser&apos;s passkey prompt.
          </Banner>
        ) : null}
        {canAct && passkey.isError ? (
          <Banner
            role="alert"
            tone="warn"
            title="Your approval passkey couldn't be checked"
            actions={
              <Button
                variant="outline"
                size="md"
                onClick={() => void passkey.refetch()}
              >
                Try again
              </Button>
            }
          >
            {describeApiError(passkey.error)}
          </Banner>
        ) : null}
        {notice ? (
          <NoticeBanner notice={notice} onDone={() => setNotice(null)} />
        ) : null}
        {actionError ? (
          <Banner
            role="alert"
            tone="warn"
            title={actionError}
            actions={
              <Button
                variant="outline"
                size="md"
                onClick={() => {
                  prepare.reset();
                  pay.reset();
                }}
              >
                Done
              </Button>
            }
          />
        ) : null}
      </Banners>

      <div
        className={cn(
          "mt-4 grid items-start gap-4",
          showPane
            ? "grid-cols-[minmax(0,440px)_minmax(0,1fr)] max-[1023px]:grid-cols-1"
            : "grid-cols-1",
        )}
      >
        <section
          id="approval-queue"
          aria-label="Reimbursements"
          className="flex flex-col overflow-clip rounded-xl border border-border bg-card shadow-xs [animation-delay:60ms] motion-safe:animate-rise"
        >
          <ClaimQueue
            tab={tab}
            claims={claims}
            queue={queueState(queue)}
            total={
              summary.data
                ? tab === "waiting"
                  ? summary.data.waiting
                  : summary.data.payoutFailed
                : undefined
            }
            activeId={active?.id ?? null}
            onActivate={activate}
            canPay={canPay}
            busy={busy}
            selected={selected}
            onSelectedChange={setSelected}
            onApproveSelected={() =>
              startPayment({ kind: "approve", claimIds: selected }, "bar")
            }
            preparing={prepare.isPending && preparingFrom === "bar"}
          />
        </section>
        {showPane ? (
          <section
            aria-label="Reimbursement details"
            aria-live="polite"
            className="sticky top-4 flex max-h-[calc(100dvh-32px)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-xs [animation-delay:120ms] max-[1023px]:hidden motion-safe:animate-rise"
          >
            {active ? (
              <>
                <div
                  key={active.id}
                  className="flex-1 overflow-y-auto px-6 py-5 motion-safe:animate-fade max-[600px]:px-4"
                >
                  <ClaimDetailBody
                    claim={active}
                    tab={tab}
                    detail={detail.data}
                    detailFailed={detail.isError}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2 border-t border-border bg-card px-6 py-3.5 max-[600px]:px-4">
                  {actionsFor(active)}
                </div>
              </>
            ) : (
              <div aria-busy="true" className="px-6 py-5">
                <Skel width="45%" height={20} />
                <Skel width="30%" height={14} style={{ marginTop: 8 }} />
                <Skel width="100%" height={340} style={{ marginTop: 24 }} />
              </div>
            )}
          </section>
        ) : null}
      </div>

      <DetailSheet
        open={narrow && linked !== undefined && prepared === null}
        onClose={() => setClaimId(null)}
        eyebrow={tab === "failed" ? "Payment failed" : "Reimbursement"}
        title={linked?.merchant ?? ""}
        stepKey={linked?.id}
        footer={linked ? actionsFor(linked) : null}
      >
        {linked ? (
          <ClaimDetailBody
            claim={linked}
            tab={tab}
            detail={detail.data?.id === linked.id ? detail.data : undefined}
            detailFailed={detail.isError}
          />
        ) : null}
      </DetailSheet>

      <DetailSheet
        open={prepared !== null}
        onClose={closeReview}
        dismissible={!pay.isPending}
        eyebrow={
          prepared?.request.kind === "retry" ? "Payment failed" : "Approvals"
        }
        title={prepared ? reviewTitle(prepared) : ""}
        footer={
          prepared ? (
            <SheetActions kind="primary">
              <Button
                disabled={
                  prepared.approval.wallet.topUpKes !== null || pay.isPending
                }
                onClick={() => onPay(prepared)}
              >
                {pay.isPending ? (
                  "Waiting for your passkey…"
                ) : (
                  <>
                    <KeyRoundIcon aria-hidden="true" />
                    Pay with passkey
                  </>
                )}
              </Button>
              <Button
                variant="outline"
                disabled={pay.isPending}
                onClick={closeReview}
              >
                Cancel
              </Button>
            </SheetActions>
          ) : null
        }
      >
        {prepared ? (
          <PaymentReview
            approval={prepared.approval}
            merchantOf={(claimId) =>
              [...waitingClaims, ...failedClaims].find(
                (claim) => claim.id === claimId,
              )?.merchant
            }
            costChanged={costChanged}
            cancelled={pay.data?.status === "cancelled"}
          />
        ) : null}
      </DetailSheet>
    </div>
  );
}

function requestIncludes(
  request: PaymentRequest | undefined,
  claimId: string,
): boolean {
  if (!request) return false;
  return request.kind === "retry"
    ? request.claimId === claimId
    : request.claimIds.length === 1 && request.claimIds[0] === claimId;
}

function reviewTitle(prepared: PreparedPayment): string {
  if (prepared.request.kind === "retry") return "Retry the payment";
  const count = prepared.approval.claims.length;
  return `Approve & pay ${String(count)} ${count === 1 ? "reimbursement" : "reimbursements"}`;
}

function NoticeBanner({
  notice,
  onDone,
}: {
  notice: Notice;
  onDone: () => void;
}): JSX.Element {
  const done = (
    <Button variant="outline" size="md" onClick={onDone}>
      Done
    </Button>
  );
  if (notice.kind === "rejected") {
    return (
      <Banner
        role="status"
        tone="success"
        title={`Rejected. ${notice.name} will see why.`}
        actions={done}
      />
    );
  }
  const summary = describePaymentResult(notice.result);
  const warn = summary.outcome === "failed" || summary.outcome === "review";
  return (
    <Banner
      role="status"
      tone={warn ? "warn" : "success"}
      title={summary.title}
      actions={done}
    >
      <p>{summary.body}</p>
      {summary.failureReason ? <p>{summary.failureReason}</p> : null}
    </Banner>
  );
}
