"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FileTextIcon,
  KeyRoundIcon,
  PlusIcon,
  RepeatIcon,
  TriangleAlertIcon,
  UploadIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";

import type {
  BillDetail,
  BillListView,
  BillPaymentResult,
  BillsSummary,
} from "@expendi-business/shared";
import {
  BILL_PAYMENT_MAX_BILLS,
  billPaymentSchema,
} from "@expendi-business/shared";

import type { LocalSheet, PaymentStep, SheetLink } from "./bills-sheet";
import type { BillFilterParam, BillSortKey } from "~/features/bills/bill-list";
import type { BillPaymentRequest } from "~/features/bills/bill-payment";
import type { PreparedBillPayment } from "~/features/bills/bills-api";
import { TreasuryOfferButton } from "~/app/(company)/wallet/_components/treasury-offer";
import { Banner, Banners } from "~/components/data/banner";
import { KesTotal } from "~/components/data/money";
import { PageHeader } from "~/components/data/page-header";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/contexts/auth-context";
import { useDashboard } from "~/contexts/dashboard-context";
import { nairobiIsoDate } from "~/features/bills/bill-dates";
import {
  BILL_FILTER_PARAMS,
  DEFAULT_BILL_SORT,
  filtersFromParams,
  firstSortDir,
  historySettledFrom,
  sortBills,
  summaryParams,
  viewFromParam,
  viewOfStatus,
} from "~/features/bills/bill-list";
import {
  CostChangedError,
  describePaymentError,
  holdFrom,
  toggleSelection,
} from "~/features/bills/bill-payment";
import {
  useBill,
  useBills,
  useBillsSummary,
  useInvalidateBills,
  useKesRate,
  usePayBills,
  usePrepareBillPayment,
} from "~/features/bills/bills-api";
import { ACTIVE_PAYEES, usePayees } from "~/features/payees/payees-api";
import { describeApiError } from "~/lib/api";
import { approxKesTotal } from "~/lib/money";
import { queryKeys } from "~/lib/query-keys";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { PaymentResultBanner } from "./bill-payment-review";
import { BillsResults } from "./bills-results";
import { BillsSheet, NO_LOCAL_SHEET } from "./bills-sheet";
import { canSelect } from "./columns";

type BillParam = "view" | BillFilterParam | "billId" | "recurring" | "new";

const NEW_BILL: LocalSheet = { kind: "new-bill" };

const NO_FILTER_PARAMS: Readonly<Record<BillFilterParam, null>> = {
  status: null,
  payee: null,
  category: null,
  heading: null,
  method: null,
  source: null,
};

/**
 * Bills (spec §6.14, §6.20): money still owed to suppliers, to pay, being
 * paid, and the last six months' history, never salaries. Admins add and
 * change bills, upload invoices (PDFs too), and pay up to 20 at once with
 * one passkey, each as its own payout. Recurring payments live in the
 * side sheet. Accountants see the same, with no actions.
 */
export function BillsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyBills
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyBills({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const { api } = useAuth();
  const [param, setParams] = useDeepLinkParams<BillParam>();
  const view = viewFromParam(param("view"));
  const filters = filtersFromParams(view, param);
  const billId = param("billId");
  const recurring = billId ? null : param("recurring");
  const [today] = useState(() => nairobiIsoDate(new Date()));

  const bills = useBills(organizationId, view, filters);
  const summary = useBillsSummary(
    organizationId,
    summaryParams(filters, historySettledFrom(today)),
  );
  const rate = useKesRate(organizationId);
  const passkey = useApprovalPasskeyStatus(canAct);
  const canPay = canAct && passkey.data?.enrolled === true;
  const needsPasskey = canAct && passkey.data?.enrolled === false;
  const payees = usePayees(organizationId, ACTIVE_PAYEES);
  const categories = useQuery({
    queryKey: queryKeys.categories(organizationId),
    queryFn: () => api.listCategories(organizationId),
  });

  const [sorts, setSorts] = useState<
    Partial<Record<BillListView, { key: BillSortKey; dir: "asc" | "desc" }>>
  >({});
  const sort = sorts[view] ?? DEFAULT_BILL_SORT[view];
  const rows = useMemo(
    () => sortBills(bills.data ?? [], view, sort, rate),
    [bills.data, view, sort, rate],
  );

  const [selected, setSelected] = useState<string[]>([]);
  const selectable = view === "open" && canPay;
  const chosen = selectable
    ? selected.filter((id) =>
        rows.some((bill) => bill.id === id && canSelect(bill)),
      )
    : [];
  const newParam = param("new");
  const [local, setLocal] = useState<LocalSheet>(() =>
    newParam !== null && canAct ? NEW_BILL : NO_LOCAL_SHEET,
  );
  const [newLinked, setNewLinked] = useState(newParam !== null);
  if ((newParam !== null) !== newLinked) {
    setNewLinked(newParam !== null);
    if (newParam !== null && canAct) setLocal(NEW_BILL);
  }
  const [payment, setPayment] = useState<PaymentStep | null>(null);
  const [result, setResult] = useState<BillPaymentResult | null>(null);
  const refresh = useInvalidateBills(organizationId);
  const prepare = usePrepareBillPayment(organizationId);
  const pay = usePayBills(organizationId);

  useEffect(() => {
    if (newParam !== null) setParams({ new: null });
  }, [newParam, setParams]);

  useLinkedBillTab(organizationId, billId, view, (tab) =>
    setParams({ view: tab === "open" ? null : tab, status: null }),
  );

  function navigate(link: SheetLink, next: LocalSheet = NO_LOCAL_SHEET) {
    setLocal(next);
    setParams(link);
  }

  function closeSheet() {
    if (pay.isPending) return;
    if (payment) {
      pay.reset();
      prepare.reset();
      setPayment(null);
    }
    navigate({ billId: null, recurring: null, new: null });
  }

  function startPayment(request: BillPaymentRequest) {
    pay.reset();
    setResult(null);
    prepare.mutate(request, {
      onSuccess: (prepared) => setPayment({ step: "review", prepared }),
      onError: (error) => {
        const hold = holdFrom(error);
        setPayment(
          hold && !request.secondConfirmation
            ? { step: "hold", request, hold }
            : null,
        );
      },
    });
  }

  function onPay(prepared: PreparedBillPayment) {
    pay.mutate(prepared, {
      onSuccess: (outcome) => {
        if (outcome.status !== "approved") return;
        setResult(outcome.result);
        setPayment(null);
        setSelected([]);
        navigate({ billId: null, recurring: null, status: null });
      },
      onError: (error) => {
        const fresh =
          error instanceof CostChangedError
            ? billPaymentSchema.safeParse(error.fresh)
            : null;
        if (fresh?.success) {
          setPayment({
            step: "review",
            prepared: {
              ...prepared,
              payment: fresh.data,
              preparedAt: Date.now(),
            },
          });
          return;
        }
        // The confirmation may have reached the API; show where things stand.
        setPayment(null);
        void refresh();
      },
    });
  }

  function showView(next: BillListView) {
    if (next === view) return;
    setSelected([]);
    setParams({ view: next === "open" ? null : next, status: null });
  }

  const holdShown = payment?.step === "hold";
  const costChanged = pay.error instanceof CostChangedError;
  const paymentFailure: unknown =
    prepare.isError && !holdShown
      ? prepare.error
      : pay.isError && !costChanged
        ? pay.error
        : null;
  const paymentError = paymentFailure
    ? describePaymentError(paymentFailure)
    : null;
  const preparing = prepare.isPending;
  const busy = preparing || pay.isPending || payment !== null;

  return (
    <div>
      <PageHeader
        title="Bills"
        subtitle={
          canAct
            ? `Suppliers, rent, utilities, subscriptions and statutory payments. Pay up to ${String(BILL_PAYMENT_MAX_BILLS)} bills with one passkey; each is paid on its own.`
            : "Suppliers, rent, utilities, subscriptions and statutory payments. Only admins add and pay bills."
        }
        actions={
          <>
            {canAct ? (
              <Button variant="outline" size="md" asChild>
                <Link href="/imports?kind=bill">
                  <UploadIcon aria-hidden="true" />
                  Import spreadsheet
                </Link>
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="md"
              aria-haspopup="dialog"
              onClick={() => navigate({ billId: null, recurring: "all" })}
            >
              <RepeatIcon aria-hidden="true" />
              Recurring payments
            </Button>
            {canAct ? (
              <Button
                size="md"
                aria-haspopup="dialog"
                onClick={() =>
                  navigate({ billId: null, recurring: null }, NEW_BILL)
                }
              >
                <PlusIcon aria-hidden="true" />
                New bill
              </Button>
            ) : null}
          </>
        }
      />

      <Banners>
        {needsPasskey ? (
          <Banner
            icon={KeyRoundIcon}
            role="note"
            title="Set up your approval passkey first"
          >
            Paying needs your approval passkey. Set it up in the Expendi
            Business app; then confirm here with “use a phone or tablet” in your
            browser&apos;s passkey prompt.
          </Banner>
        ) : null}
        {canAct && passkey.isError ? (
          <Banner
            tone="warn"
            role="alert"
            title={describeApiError(passkey.error)}
            actions={
              <Button
                variant="outline"
                size="md"
                onClick={() => void passkey.refetch()}
              >
                Try again
              </Button>
            }
          />
        ) : null}
        {result ? (
          <PaymentResultBanner
            result={result}
            showBeingPaid={view !== "paying"}
            onRetry={(failedId) =>
              startPayment({
                billIds: [failedId],
                retry: true,
                secondConfirmation: false,
              })
            }
            onSeeBeingPaid={() => showView("paying")}
            onDismiss={() => setResult(null)}
          />
        ) : null}
        {paymentError && payment === null ? (
          <Banner
            tone="warn"
            role="alert"
            title={paymentError}
            actions={
              <>
                <TreasuryOfferButton error={paymentFailure} />
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
              </>
            }
          />
        ) : null}
      </Banners>

      <BillStats
        summary={summary.data}
        loading={summary.isPending}
        failed={summary.isError && summary.data === undefined}
        rate={rate}
      />

      <BillsResults
        view={view}
        onView={showView}
        counts={summary.data?.views}
        filters={filters}
        onFilter={(name, value) =>
          setParams({ [BILL_FILTER_PARAMS[name]]: value })
        }
        onClearAll={() => setParams(NO_FILTER_PARAMS)}
        payees={payees.data ?? []}
        categories={categories.data ?? []}
        rows={rows}
        loading={bills.isPending}
        failed={bills.isError}
        refreshing={bills.isPlaceholderData}
        onRetry={() => void bills.refetch()}
        sort={sort}
        onSort={(key) =>
          setSorts((current) => ({
            ...current,
            [view]:
              sort.key === key
                ? { key, dir: sort.dir === "asc" ? "desc" : "asc" }
                : { key, dir: firstSortDir(key, view) },
          }))
        }
        rate={rate}
        today={today}
        openId={billId}
        onOpen={(id) => navigate({ billId: id, recurring: null })}
        selection={
          selectable
            ? {
                selected: chosen,
                busy,
                preparing: preparing && payment === null && billId === null,
                onToggle: (id) => setSelected(toggleSelection(chosen, id)),
                onSelect: setSelected,
                onPay: () =>
                  startPayment({
                    billIds: chosen,
                    retry: false,
                    secondConfirmation: false,
                  }),
              }
            : null
        }
      />

      <BillsSheet
        organizationId={organizationId}
        canAct={canAct}
        canPay={canPay}
        needsPasskey={needsPasskey}
        rate={rate}
        rows={rows}
        billId={billId}
        recurring={recurring}
        local={local}
        payment={{
          step: payment,
          preparing,
          paying: pay.isPending,
          costChanged,
          cancelled: pay.data?.status === "cancelled" && payment !== null,
          error: paymentError,
          failure: paymentFailure,
          onPayBill: (bill) =>
            startPayment({
              billIds: [bill.id],
              retry: bill.status === "payout_failed",
              secondConfirmation: false,
            }),
          onConfirmHold: () => {
            if (payment?.step === "hold") {
              startPayment({ ...payment.request, secondConfirmation: true });
            }
          },
          onPay: () => {
            if (payment?.step === "review") onPay(payment.prepared);
          },
          onCancel: () => {
            pay.reset();
            prepare.reset();
            setPayment(null);
            navigate({ billId: null, recurring: null });
          },
        }}
        onNavigate={navigate}
        onLocal={setLocal}
        onClose={closeSheet}
        onBillCreated={(bill: BillDetail) =>
          navigate({
            ...NO_FILTER_PARAMS,
            view: null,
            recurring: null,
            billId: bill.id,
          })
        }
      />
    </div>
  );
}

/**
 * A bill opened from a link (`?billId=` on arrival) shows under its own
 * tab: once its details load, the page moves to that tab if it isn't on it.
 */
function useLinkedBillTab(
  organizationId: string,
  billId: string | null,
  view: BillListView,
  onTab: (tab: BillListView) => void,
): void {
  const [linked] = useState(billId);
  const detail = useBill(organizationId, linked ?? "", {
    enabled: linked !== null,
  });
  const done = useRef(false);
  const status = detail.data?.status;
  useEffect(() => {
    if (done.current || status === undefined) return;
    done.current = true;
    const tab = viewOfStatus(status);
    if (tab !== view) onTab(tab);
  }, [status, view, onTab]);
}

function CountCard({
  label,
  icon,
  tone,
  totals,
  rate,
}: {
  label: string;
  icon: LucideIcon;
  tone: "attention" | "danger";
  totals: BillsSummary["overdue"];
  rate: string | null;
}): JSX.Element {
  const any = totals.count > 0;
  return (
    <StatCard
      icon={any ? icon : CheckIcon}
      tone={any ? tone : "clear"}
      label={label}
      value={totals.count}
      sub={
        any ? (
          <KesTotal
            total={approxKesTotal({
              kes: totals.totalKes,
              usd: totals.totalUsdc,
              rate,
            })}
          />
        ) : (
          "All clear"
        )
      }
    />
  );
}

/** Company-wide numbers: what's to pay, overdue, due today and failed. */
function BillStats({
  summary,
  loading,
  failed,
  rate,
}: {
  summary: BillsSummary | undefined;
  loading: boolean;
  failed: boolean;
  rate: string | null;
}): JSX.Element | null {
  if (failed) return null;
  if (loading || summary === undefined) {
    return (
      <StatCards>
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatCards>
    );
  }
  const { toPay } = summary;
  const bills = `${String(toPay.count)} ${toPay.count === 1 ? "bill" : "bills"}`;
  return (
    <StatCards>
      <StatCard
        icon={FileTextIcon}
        tone="total"
        label="To pay"
        value={
          <KesTotal
            total={approxKesTotal({
              kes: toPay.totalKes,
              usd: toPay.totalUsdc,
              rate,
            })}
          />
        }
        sub={
          toPay.withoutAmount > 0
            ? `${bills} · ${String(toPay.withoutAmount)} without an amount`
            : bills
        }
      />
      <CountCard
        label="Overdue"
        icon={TriangleAlertIcon}
        tone="danger"
        totals={summary.overdue}
        rate={rate}
      />
      <CountCard
        label="Due today"
        icon={ClockIcon}
        tone="attention"
        totals={summary.dueToday}
        rate={rate}
      />
      <CountCard
        label="Payment failed"
        icon={CircleAlertIcon}
        tone="danger"
        totals={summary.payoutFailed}
        rate={rate}
      />
    </StatCards>
  );
}
