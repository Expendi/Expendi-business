"use client";

import type { JSX } from "react";
import { useState } from "react";

import { ErrorState, Skel } from "~/components/data/states";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import {
  nairobiMonth,
  shiftMonth,
} from "../../reports/_components/report-month";
import { CaughtUp, Inbox } from "./inbox";
import { Insights } from "./insights";
import {
  useOpenFloats,
  useOverview,
  useSpendingTrend,
  useViewerName,
} from "./overview-api";
import {
  comingUp,
  greeting,
  inboxGroups,
  inboxTitle,
  nairobiHour,
} from "./overview-display";
import { ComingUpCard, FloatsCard, WalletCard } from "./rail";

/**
 * The home page (spec §6.24): what needs someone today, the wallet against
 * the next 30 days of payments, and how a month went. Every figure is the
 * API's. Accountants see it all, with View in place of Pay.
 */
export function OverviewView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyOverview
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

/** The month the charts open on: last month, the latest complete one. */
export function defaultOverviewMonth(now: Date): string {
  return shiftMonth(nairobiMonth(now), -1);
}

function CompanyOverview({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [now] = useState(() => new Date());
  const thisMonth = nairobiMonth(now);
  const [month, setMonth] = useState(() => defaultOverviewMonth(now));
  const overview = useOverview(organizationId, month);
  const trend = useSpendingTrend(organizationId, month);
  const floats = useOpenFloats(organizationId);
  const name = useViewerName();

  if (overview.isPending) return <OverviewSkeleton />;
  if (overview.isError) {
    return (
      <div className="rounded-xl border border-border bg-card shadow-xs">
        <ErrorState
          title="The overview didn't load"
          onRetry={() => void overview.refetch()}
        >
          {describeApiError(overview.error)}
        </ErrorState>
      </div>
    );
  }

  const data = overview.data;
  const groups = inboxGroups(data);
  const count = groups.reduce((sum, group) => sum + group.items.length, 0);
  return (
    <>
      <div className="grid grid-cols-[minmax(0,1fr)_352px] items-start gap-x-12 gap-y-10 max-[1120px]:grid-cols-[minmax(0,1fr)]">
        <section aria-labelledby="inbox-title">
          <p className="text-base leading-6 text-muted-foreground motion-safe:animate-rise">
            {greeting(nairobiHour(now), name)}
          </p>
          <h1
            id="inbox-title"
            className="mt-0.5 text-[32px] leading-10 font-(--w-display) tracking-[-0.025em] motion-safe:animate-rise"
          >
            {inboxTitle(count, canAct)}
          </h1>
          {count === 0 ? (
            <CaughtUp next={comingUp(data.cash)[0]} />
          ) : (
            <Inbox groups={groups} canAct={canAct} />
          )}
        </section>
        <aside
          aria-label="Wallet and balances"
          className="sticky top-6 flex flex-col gap-4 max-[1120px]:static max-[1120px]:grid max-[1120px]:grid-cols-[repeat(auto-fit,minmax(min(100%,280px),1fr))] max-[1120px]:items-start"
        >
          <WalletCard cash={data.cash} canAct={canAct} />
          <FloatsCard floats={floats} />
          <ComingUpCard cash={data.cash} />
        </aside>
      </div>
      <div
        className={
          overview.isPlaceholderData
            ? "opacity-50 transition-opacity duration-200"
            : "transition-opacity duration-200"
        }
      >
        <Insights
          data={data}
          trend={trend}
          thisMonth={thisMonth}
          onMonthChange={setMonth}
        />
      </div>
    </>
  );
}

function OverviewSkeleton(): JSX.Element {
  return (
    <div
      aria-busy="true"
      aria-label="Loading the overview"
      className="grid grid-cols-[minmax(0,1fr)_352px] items-start gap-x-12 gap-y-10 max-[1120px]:grid-cols-[minmax(0,1fr)]"
    >
      <div>
        <Skel width={200} height={20} />
        <Skel width={280} height={36} style={{ marginTop: 8 }} />
        <div className="mt-6 flex flex-col gap-5 rounded-xl border border-border bg-card p-5">
          {[0, 1, 2, 3].map((key) => (
            <div key={key} className="flex gap-3.5">
              <Skel width={36} height={36} />
              <div className="flex-1">
                <Skel width="55%" height={16} />
                <Skel width="35%" height={12} style={{ marginTop: 8 }} />
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-4">
        <Skel width="100%" height={300} />
        <Skel width="100%" height={180} />
      </div>
    </div>
  );
}
