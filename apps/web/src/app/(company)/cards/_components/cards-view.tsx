"use client";

import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import {
  ArrowDownToLineIcon,
  CircleDotIcon,
  CreditCardIcon,
  FlaskConicalIcon,
  HourglassIcon,
  MessageCircleQuestionIcon,
  PlusIcon,
  ReceiptTextIcon,
  WalletIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type {
  CardBalance,
  CardProgram,
  ExpendiCard,
} from "@expendi-business/shared";
import {
  CARD_BALANCE_LOW_USD_CENTS,
  CARD_PURCHASE_STATUSES,
  formatUsdCents,
} from "@expendi-business/shared";

import type { CardSortKey } from "./cards-display";
import type { SortState } from "~/components/data/data-table";
import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type { StatTone } from "~/components/data/stat-cards";
import type { PasskeyState } from "~/features/payment-ui";
import type { CardPurchaseFilters } from "~/lib/query-keys";
import { Banner, Banners } from "~/components/data/banner";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState } from "~/components/data/states";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import { describeApiError } from "~/lib/api";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { CardSheet } from "./card-sheet";
import {
  useCardLoads,
  useCardProgram,
  useCardPurchases,
  useCards,
} from "./cards-api";
import {
  cardLabel,
  formatUsd,
  hasPurchaseFilter,
  isBelowZero,
  NEEDS_ANSWER,
  PURCHASE_STATUS,
  readPurchaseFilters,
  sortCards,
} from "./cards-display";
import { CardsTable, CardsTableSkeleton } from "./cards-list";
import { IssueCardSheet } from "./issue-card-sheet";
import { LoadSheet } from "./load-sheet";
import { LoadsTable, LoadsTableSkeleton } from "./loads-list";
import { PurchasesResults } from "./purchases-list";
import { TurnOnCards } from "./turn-on-cards";
import { Usd } from "./usd";

type CardProgramOn = Extract<CardProgram, { status: "on" }>;
type CardsTab = "cards" | "purchases" | "loads";
type Param =
  "tab" | "id" | "purchase" | "card" | "status" | "receipt" | "review";
type OpenSheet = "load" | "issue" | null;

const TITLE = "Cards";
const SUBTITLE =
  "Virtual cards for the team, spending from the company's Card balance.";

const STATUS_OPTIONS: readonly FilterOption[] = CARD_PURCHASE_STATUSES.map(
  (status) => ({
    value: status,
    label: PURCHASE_STATUS[status].label,
    tone: PURCHASE_STATUS[status].tone,
  }),
);

const RECEIPT_OPTIONS: readonly FilterOption[] = [
  { value: "true", label: "Needs a receipt" },
  { value: "false", label: "Has a receipt or waiver" },
];

const ANSWER_OPTIONS: readonly FilterOption[] = [
  { value: "true", label: NEEDS_ANSWER, tone: "waiting" },
];

const NEEDS_ANSWER_FILTERS: CardPurchaseFilters = {
  cardId: null,
  status: null,
  needsReceipt: null,
  needsReview: "true",
};

/**
 * Expendi cards (spec §6.25): the Card balance, the cards, their purchases
 * and every Card load. Admins act, each money step with their passkey;
 * accountants see the same pages read-only. The tab, filters and the open
 * item live in the URL.
 */
export function CardsView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyCards
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyCards({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const program = useCardProgram(organizationId);

  if (program.data?.status === "on") {
    return (
      <ProgramOn
        organizationId={organizationId}
        canAct={canAct}
        program={program.data}
      />
    );
  }

  let body: ReactNode;
  if (program.isPending) {
    body = (
      <div aria-busy="true" className="mt-4">
        <StatCards label="Card balance" columns={3}>
          <StatCardSkeleton />
          <StatCardSkeleton />
          <StatCardSkeleton />
        </StatCards>
      </div>
    );
  } else if (program.isError) {
    body = (
      <PlainPanel>
        <ErrorState
          title="Cards didn't load"
          onRetry={() => void program.refetch()}
        >
          {describeApiError(program.error)}
        </ErrorState>
      </PlainPanel>
    );
  } else if (canAct) {
    body = <TurnOnCards organizationId={organizationId} />;
  } else {
    body = (
      <PlainPanel>
        <EmptyState icon={CreditCardIcon} title="Cards aren't on yet">
          An admin can turn on Expendi cards for this company.
        </EmptyState>
      </PlainPanel>
    );
  }

  return (
    <section>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      {body}
    </section>
  );
}

function PlainPanel({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4 rounded-xl border border-border bg-card shadow-xs">
      {children}
    </div>
  );
}

function ProgramOn({
  organizationId,
  canAct,
  program,
}: {
  organizationId: string;
  canAct: boolean;
  program: CardProgramOn;
}): JSX.Element {
  const cards = useCards(organizationId);
  const loads = useCardLoads(organizationId);
  const passkeyStatus = useApprovalPasskeyStatus(canAct);
  const [param, setParams] = useDeepLinkParams<Param>();
  const [sheet, setSheet] = useState<OpenSheet>(null);
  const [sort, setSort] = useState<SortState<CardSortKey>>({
    key: "card",
    dir: "asc",
  });

  const passkey: PasskeyState = !canAct
    ? "none"
    : passkeyStatus.data === undefined
      ? "checking"
      : passkeyStatus.data.enrolled
        ? "ready"
        : "missing";
  const tab: CardsTab =
    param("tab") === "purchases"
      ? "purchases"
      : param("tab") === "loads"
        ? "loads"
        : "cards";
  const filters = readPurchaseFilters(param);
  const rows = useMemo(
    () => sortCards(cards.data?.cards ?? [], sort),
    [cards.data, sort],
  );
  const ids = rows.map((card) => card.id);
  const openCard = rows.find((card) => card.id === param("id"));
  const canIssue = canAct && !program.paused;
  const canLoad = canAct && !program.paused;

  function openIssued(card: ExpendiCard) {
    setSheet(null);
    setParams({ tab: null, id: card.id });
  }

  function clearFilters() {
    setParams({ card: null, status: null, receipt: null, review: null });
  }

  function showNeedingAnswer() {
    setParams({
      tab: "purchases",
      id: null,
      purchase: null,
      card: null,
      status: null,
      receipt: null,
      review: "true",
    });
  }

  const tabs: readonly KindTab<CardsTab>[] = [
    { value: "cards", label: "Cards", count: cards.data?.cards.length },
    { value: "purchases", label: "Purchases" },
    { value: "loads", label: "Loads", count: loads.data?.loads.length },
  ];
  const cardOptions: readonly FilterOption[] = rows.map((card) => ({
    value: card.id,
    label: cardLabel(card),
  }));

  return (
    <section>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          canAct ? (
            <>
              <Button
                variant="outline"
                size="md"
                disabled={!canLoad}
                onClick={() => setSheet("load")}
              >
                <ArrowDownToLineIcon aria-hidden="true" />
                Load
              </Button>
              <Button
                size="md"
                disabled={!canIssue}
                onClick={() => setSheet("issue")}
              >
                <PlusIcon aria-hidden="true" />
                Issue card
              </Button>
            </>
          ) : null
        }
      />

      <Banners>
        <Banner
          role="note"
          icon={FlaskConicalIcon}
          title="Sandbox: no real money moves"
        >
          Card loads and purchases here are simulated. No USDC leaves the
          wallet.
        </Banner>
        {program.paused ? (
          <Banner
            tone="warn"
            role="status"
            title="Card loads and new cards are paused"
          >
            Expendi paused payouts for this company, which also stops Card loads
            and new cards.
          </Banner>
        ) : null}
        {program.lowBalance ? (
          <Banner
            tone="warn"
            role="status"
            title="The Card balance is low"
            actions={
              canLoad ? (
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => setSheet("load")}
                >
                  Load
                </Button>
              ) : null
            }
          >
            Less than {formatUsdCents(CARD_BALANCE_LOW_USD_CENTS)} is available.
            Cards start declining when it runs out.
          </Banner>
        ) : null}
        {tab === "purchases" && filters.needsReview ? null : (
          <NeedsAnswerBanner
            organizationId={organizationId}
            canAct={canAct}
            onShow={showNeedingAnswer}
          />
        )}
      </Banners>

      <BalanceSummary balance={program.balance} low={program.lowBalance} />

      <ResultsPanel label="Cards, purchases and loads">
        <ResultsHead
          tabs={
            <KindTabs
              label="Cards, purchases and loads"
              tabs={tabs}
              value={tab}
              onChange={(next) =>
                setParams({
                  tab: next === "cards" ? null : next,
                  id: null,
                  purchase: null,
                })
              }
              controls="cards-results"
            />
          }
          chips={
            tab === "purchases" ? (
              <>
                <FilterChip
                  label="Card"
                  icon={CreditCardIcon}
                  options={cardOptions}
                  value={filters.cardId}
                  onChange={(value) =>
                    setParams({ card: value, purchase: null })
                  }
                  anyLabel="Every card"
                  disabled={!cards.isSuccess}
                />
                <FilterChip
                  label="Status"
                  icon={CircleDotIcon}
                  options={STATUS_OPTIONS}
                  value={filters.status}
                  onChange={(value) =>
                    setParams({ status: value, purchase: null })
                  }
                  anyLabel="Any status"
                />
                <FilterChip
                  label="Receipt"
                  icon={ReceiptTextIcon}
                  options={RECEIPT_OPTIONS}
                  value={filters.needsReceipt}
                  onChange={(value) =>
                    setParams({ receipt: value, purchase: null })
                  }
                  anyLabel="Any receipt state"
                />
                <FilterChip
                  label="Answer"
                  icon={MessageCircleQuestionIcon}
                  options={ANSWER_OPTIONS}
                  value={filters.needsReview}
                  onChange={(value) =>
                    setParams({ review: value, purchase: null })
                  }
                  anyLabel="Any purchase"
                />
              </>
            ) : null
          }
          onClearAll={
            tab === "purchases" && hasPurchaseFilter(filters)
              ? clearFilters
              : undefined
          }
        />
        {tab === "purchases" ? (
          <PurchasesResults
            organizationId={organizationId}
            canAct={canAct}
            filters={filters}
            openId={param("purchase")}
            onOpen={(purchaseId) => setParams({ purchase: purchaseId })}
            onClose={() => setParams({ purchase: null })}
            onClearFilters={clearFilters}
          />
        ) : tab === "loads" ? (
          <LoadsResults
            loads={loads}
            canLoad={canLoad}
            onLoad={() => setSheet("load")}
          />
        ) : (
          <ResultsBody id="cards-results" busy={cards.isPending}>
            {cards.isPending ? (
              <CardsTableSkeleton />
            ) : cards.isError ? (
              <ErrorState
                title="Cards didn't load"
                onRetry={() => void cards.refetch()}
              >
                {describeApiError(cards.error)}
              </ErrorState>
            ) : rows.length === 0 ? (
              <EmptyState
                icon={CreditCardIcon}
                title="No cards yet"
                action={
                  canIssue ? (
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => setSheet("issue")}
                    >
                      <PlusIcon aria-hidden="true" />
                      Issue card
                    </Button>
                  ) : null
                }
              >
                {canAct
                  ? "Issue a virtual card for someone on the team."
                  : "Cards an admin issues show here."}
              </EmptyState>
            ) : (
              <CardsTable
                cards={rows}
                sort={sort}
                onSort={setSort}
                openId={openCard?.id ?? null}
                onOpen={(cardId) => setParams({ id: cardId })}
              />
            )}
          </ResultsBody>
        )}
      </ResultsPanel>

      {openCard ? (
        <CardSheet
          organizationId={organizationId}
          card={openCard}
          canAct={canAct}
          passkey={passkey}
          index={ids.indexOf(openCard.id)}
          total={ids.length}
          onStep={(delta) => {
            const next = ids[ids.indexOf(openCard.id) + delta];
            if (next) setParams({ id: next });
          }}
          onClose={() => setParams({ id: null })}
          onViewPurchases={() =>
            setParams({
              id: null,
              tab: "purchases",
              card: openCard.id,
              status: null,
              receipt: null,
            })
          }
        />
      ) : null}
      {sheet === "load" && canLoad ? (
        <LoadSheet
          organizationId={organizationId}
          passkey={passkey}
          availableUsdCents={program.balance.availableUsdCents}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet === "issue" && canIssue ? (
        <IssueCardSheet
          organizationId={organizationId}
          passkey={passkey}
          onClose={() => setSheet(null)}
          onIssued={openIssued}
        />
      ) : null}
    </section>
  );
}

/**
 * Purchases on company-held cards from merchants they hadn't seen, which
 * wait for an admin to say what they are (spec §6.25).
 */
function NeedsAnswerBanner({
  organizationId,
  canAct,
  onShow,
}: {
  organizationId: string;
  canAct: boolean;
  onShow: () => void;
}): JSX.Element | null {
  const waiting = useCardPurchases(organizationId, NEEDS_ANSWER_FILTERS);
  const [first] = waiting.data?.pages ?? [];
  const count = first?.purchases.length ?? 0;
  if (count === 0 || !first) return null;
  const counted = first.nextCursor
    ? `${String(count)}+ purchases need an answer`
    : count === 1
      ? "A purchase needs an answer"
      : `${String(count)} purchases need an answer`;
  return (
    <Banner
      tone="warn"
      role="status"
      icon={MessageCircleQuestionIcon}
      title={counted}
      actions={
        <Button variant="outline" size="md" onClick={onShow}>
          {canAct ? "Answer" : "See them"}
        </Button>
      }
    >
      A company-held card was charged by a merchant it hadn&apos;t seen. Say
      whether it&apos;s one of the card&apos;s recurring payments, a one-off, or
      not recognised.
    </Banner>
  );
}

/** The Card balance as the API works it out when it's read. */
function BalanceSummary({
  balance,
  low,
}: {
  balance: CardBalance;
  low: boolean;
}): JSX.Element {
  const belowZero = isBelowZero(balance);
  const availableTone: StatTone = belowZero
    ? "danger"
    : low
      ? "attention"
      : "total";
  return (
    <StatCards label="Card balance" columns={3}>
      <SummaryCard
        icon={WalletIcon}
        tone={availableTone}
        label="Available"
        cents={balance.availableUsdCents}
        sub={
          belowZero
            ? "Below zero after a late clearing"
            : "Loaded, plus refunds, less spending and holds"
        }
      />
      <SummaryCard
        icon={HourglassIcon}
        tone="total"
        label="On hold"
        cents={balance.onHoldUsdCents}
        sub="Purchases still to settle"
      />
      <SummaryCard
        icon={ArrowDownToLineIcon}
        tone="total"
        label="Loaded"
        cents={balance.loadedUsdCents}
        sub={`${formatUsd(balance.spentUsdCents)} spent · ${formatUsd(balance.refundedUsdCents)} refunded`}
      />
    </StatCards>
  );
}

function SummaryCard({
  icon,
  tone,
  label,
  cents,
  sub,
}: {
  icon: LucideIcon;
  tone: StatTone;
  label: string;
  cents: string;
  sub: string;
}): JSX.Element {
  return (
    <StatCard
      icon={icon}
      tone={tone}
      label={label}
      value={<Usd cents={cents} />}
      sub={sub}
    />
  );
}

function LoadsResults({
  loads,
  canLoad,
  onLoad,
}: {
  loads: ReturnType<typeof useCardLoads>;
  canLoad: boolean;
  onLoad: () => void;
}): JSX.Element {
  return (
    <ResultsBody id="cards-results" busy={loads.isPending}>
      {loads.isPending ? (
        <LoadsTableSkeleton />
      ) : loads.isError ? (
        <ErrorState
          title="Card loads didn't load"
          onRetry={() => void loads.refetch()}
        >
          {describeApiError(loads.error)}
        </ErrorState>
      ) : loads.data.loads.length === 0 ? (
        <EmptyState
          icon={ArrowDownToLineIcon}
          title="No Card loads yet"
          action={
            canLoad ? (
              <Button variant="outline" size="md" onClick={onLoad}>
                Load
              </Button>
            ) : null
          }
        >
          Every Card load shows here, with the rate it used.
        </EmptyState>
      ) : (
        <LoadsTable loads={loads.data.loads} />
      )}
    </ResultsBody>
  );
}
