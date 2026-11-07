"use client";

import type { JSX } from "react";
import { cn } from "cn";
import {
  ArchiveIcon,
  Building2Icon,
  FilterXIcon,
  PlusIcon,
  SearchIcon,
  ShieldAlertIcon,
  TagIcon,
  WalletIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Payee } from "@expendi-business/shared";
import { PAYEE_KINDS, PAYEE_METHODS } from "@expendi-business/shared";

import type { KindTab } from "~/components/data/kind-tabs";
import type { SortState } from "~/components/data/table";
import type { PayeeSortKey } from "~/features/payees/payee-display";
import type { PasskeyState } from "~/features/payment-ui";
import { FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import { EmptyState, ErrorState, Skel } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import {
  DataRow,
  DataTable,
  EntityMark,
  Mini,
  nextSort,
  PhoneCard,
  PhoneCards,
  RowMeta,
  RowTitle,
  SortHeader,
  Td,
} from "~/components/data/table";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import {
  detailSummary,
  formatNairobiTime,
  isPerson,
  KIND_LABELS,
  matchesSearch,
  METHOD_LABELS,
  PAYEE_SORT_FIRST,
  payeeMetaLine,
  RECENTLY_CHANGED_LABEL,
  sortPayees,
} from "~/features/payees/payee-display";
import {
  ACTIVE_PAYEES,
  ARCHIVED_PAYEES,
  usePayeeBanks,
  usePayees,
} from "~/features/payees/payees-api";
import { formatNairobiDate } from "~/lib/dates";
import { formatNairobiDateTime } from "~/lib/nairobi-time";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { PayeeSheet } from "./payee-sheet";

type PayeeTab = "active" | "archived";
type Param = "tab" | "kind" | "method" | "q" | "id";

const NO_FILTERS = { kind: null, method: null, q: null } as const;

/**
 * The company's payees (spec §6.19): who it pays other than staff
 * reimbursements, and how. Admins add payees and change their payment
 * details with their passkey; accountants see the same, read-only. The
 * tab, filters, search and the open payee live in the URL.
 */
export function PayeesView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyPayees
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyPayees({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const active = usePayees(organizationId, ACTIVE_PAYEES);
  const archived = usePayees(organizationId, ARCHIVED_PAYEES);
  const passkeyStatus = useApprovalPasskeyStatus(canAct);
  const [param, setParams] = useDeepLinkParams<Param>();
  const [sort, setSort] = useState<SortState<PayeeSortKey>>({
    key: "name",
    dir: "asc",
  });
  const [search, setSearch] = useState(() => param("q") ?? "");
  const [creating, setCreating] = useState(false);

  const passkey: PasskeyState = !canAct
    ? "none"
    : passkeyStatus.data === undefined
      ? "checking"
      : passkeyStatus.data.enrolled
        ? "ready"
        : "missing";
  const tab: PayeeTab = param("tab") === "archived" ? "archived" : "active";
  const kind = PAYEE_KINDS.find((known) => known === param("kind")) ?? null;
  const method =
    PAYEE_METHODS.find((known) => known === param("method")) ?? null;
  const anyFilter = kind !== null || method !== null || search.trim() !== "";
  const loading = active.isPending || archived.isPending;
  const failed = active.isError || archived.isError;
  const activePayees = active.data ?? [];
  const archivedPayees = archived.data ?? [];

  const matches = (payee: Payee) =>
    (kind === null || payee.kind === kind) &&
    (method === null || payee.details?.method === method) &&
    matchesSearch(payee.name, search);
  const rows = sortPayees(
    (tab === "active" ? activePayees : archivedPayees).filter(matches),
    sort,
  );
  const ids = rows.map((payee) => payee.id);
  const banks = usePayeeBanks(organizationId, {
    enabled: rows.some((payee) => payee.details?.method === "bank"),
  });
  const bankName = (payee: Payee): string | null => {
    const { details } = payee;
    if (details?.method !== "bank") return null;
    return (
      banks.data?.find((bank) => bank.code === details.bankCode)?.name ?? null
    );
  };

  const id = param("id");
  const open = id
    ? [...activePayees, ...archivedPayees].find((payee) => payee.id === id)
    : undefined;
  const openTab: PayeeTab | null = open
    ? open.archived
      ? "archived"
      : "active"
    : null;
  const aligned = useRef(false);
  useEffect(() => {
    if (aligned.current || loading) return;
    aligned.current = true;
    if (openTab && openTab !== tab) {
      setParams({ tab: openTab === "archived" ? openTab : null });
    }
  }, [loading, openTab, tab, setParams]);

  function clearAll() {
    setSearch("");
    setParams(NO_FILTERS);
  }

  function retry() {
    void active.refetch();
    void archived.refetch();
  }

  const tabs: readonly KindTab<PayeeTab>[] = [
    {
      value: "active",
      label: "Active",
      count:
        loading || failed ? undefined : activePayees.filter(matches).length,
    },
    {
      value: "archived",
      label: "Archived",
      count:
        loading || failed ? undefined : archivedPayees.filter(matches).length,
    },
  ];

  return (
    <section>
      <PageHeader
        title="Payees"
        subtitle={
          canAct
            ? "Everyone the company pays besides staff reimbursements. New payment details are confirmed with your passkey."
            : "Everyone the company pays besides staff reimbursements, with their payment details. Only admins change them."
        }
        actions={
          canAct ? (
            <Button size="md" onClick={() => setCreating(true)}>
              <PlusIcon aria-hidden="true" />
              Add payee
            </Button>
          ) : null
        }
      />

      <ResultsPanel label="Payees">
        <ResultsHead
          tabs={
            <KindTabs
              label="Payees"
              tabs={tabs}
              value={tab}
              onChange={(next) =>
                setParams({ tab: next === "archived" ? next : null })
              }
              controls="payee-results"
            />
          }
          chips={
            <>
              <SearchBox
                value={search}
                onChange={(next) => {
                  setSearch(next);
                  setParams({ q: next.trim() ? next : null });
                }}
              />
              <FilterChip
                label="Kind"
                icon={TagIcon}
                options={PAYEE_KINDS.map((value) => ({
                  value,
                  label: KIND_LABELS[value],
                }))}
                value={kind}
                onChange={(value) => setParams({ kind: value })}
                anyLabel="All kinds"
                disabled={loading || failed}
              />
              <FilterChip
                label="Paid by"
                icon={WalletIcon}
                options={PAYEE_METHODS.map((value) => ({
                  value,
                  label: METHOD_LABELS[value],
                }))}
                value={method}
                onChange={(value) => setParams({ method: value })}
                anyLabel="Any method"
                disabled={loading || failed}
              />
            </>
          }
          onClearAll={anyFilter ? clearAll : undefined}
        />
        <ResultsBody id="payee-results" busy={loading}>
          {loading ? (
            <PayeeSkeleton />
          ) : failed ? (
            <ErrorState title="Payees didn't load" onRetry={retry} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={
                anyFilter
                  ? FilterXIcon
                  : tab === "archived"
                    ? ArchiveIcon
                    : Building2Icon
              }
              title={
                anyFilter
                  ? "No payees match this search"
                  : tab === "archived"
                    ? "No archived payees"
                    : "No payees here yet"
              }
              action={
                anyFilter ? (
                  <Button variant="outline" size="md" onClick={clearAll}>
                    Clear all
                  </Button>
                ) : tab === "active" && canAct ? (
                  <Button
                    variant="outline"
                    size="md"
                    onClick={() => setCreating(true)}
                  >
                    <PlusIcon aria-hidden="true" />
                    Add payee
                  </Button>
                ) : null
              }
            >
              {anyFilter
                ? null
                : tab === "archived"
                  ? "Payees you archive show up here, with their history."
                  : "Add the suppliers, subscriptions and people the company pays."}
            </EmptyState>
          ) : (
            <PayeeTable
              rows={rows}
              tab={tab}
              sort={sort}
              onSort={setSort}
              openId={open?.id ?? null}
              onOpen={(payeeId) => setParams({ id: payeeId })}
              bankName={bankName}
            />
          )}
        </ResultsBody>
      </ResultsPanel>

      {!loading && (open || creating) ? (
        <PayeeSheet
          organizationId={organizationId}
          payeeId={open?.id ?? (creating ? id : null)}
          listed={open ?? null}
          activePayees={activePayees}
          index={open ? ids.indexOf(open.id) : -1}
          total={ids.length}
          onStep={(delta) => {
            const at = open ? ids.indexOf(open.id) : -1;
            const next = ids[at + delta];
            if (next) setParams({ id: next });
          }}
          onShow={(payee) =>
            setParams({
              id: payee.id,
              tab: payee.archived ? "archived" : null,
              ...(creating ? NO_FILTERS : {}),
            })
          }
          onClose={() => {
            setCreating(false);
            setParams({ id: null });
          }}
          canAct={canAct}
          passkey={passkey}
        />
      ) : null}
    </section>
  );
}

/** The name search: stays mounted so typing keeps focus while chips move. */
function SearchBox({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): JSX.Element {
  return (
    <label className="relative inline-flex h-8 min-w-[150px] flex-[0_1_220px] items-center group-data-[stacked=true]/head:flex-[0_1_180px] @max-[560px]/results:group-data-[stacked=true]/head:flex-[1_1_100%]">
      <SearchIcon
        aria-hidden="true"
        className="pointer-events-none absolute left-[11px] size-3.5 text-gray-500"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Search payees"
        aria-label="Search payees by name"
        autoComplete="off"
        spellCheck={false}
        className={cn(
          "h-8 w-full rounded-full border pr-3 pl-8 text-sm text-gray-900 transition-colors duration-150 placeholder:text-gray-500 hover:border-gray-400 focus-visible:border-gray-900 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--focus-ring)",
          value.trim()
            ? "border-brand-100 bg-brand-50"
            : "border-control-border bg-surface",
        )}
      />
    </label>
  );
}

function PayeeSkeleton(): JSX.Element {
  return (
    <DataTable caption="Loading payees">
      <tbody aria-hidden="true">
        {Array.from({ length: 7 }, (_, at) => (
          <tr key={at}>
            <td className="w-full max-w-0 border-b border-row-divider p-4">
              <span className="flex items-start gap-3">
                <Skel width={32} height={32} className="flex-none" />
                <span className="flex-1">
                  <Skel width="45%" height={14} />
                  <Skel width="30%" height={12} style={{ marginTop: 8 }} />
                </span>
              </span>
            </td>
            <td className="border-b border-row-divider p-4">
              <Skel width={120} height={14} />
              <Skel width={150} height={12} style={{ marginTop: 8 }} />
            </td>
            <td className="border-b border-row-divider p-4 @max-[900px]/results:hidden">
              <Skel width={90} height={14} />
            </td>
          </tr>
        ))}
      </tbody>
    </DataTable>
  );
}

function PayeeTable({
  rows,
  tab,
  sort,
  onSort,
  openId,
  onOpen,
  bankName,
}: {
  rows: readonly Payee[];
  tab: PayeeTab;
  sort: SortState<PayeeSortKey>;
  onSort: (sort: SortState<PayeeSortKey>) => void;
  openId: string | null;
  onOpen: (payeeId: string) => void;
  bankName: (payee: Payee) => string | null;
}): JSX.Element {
  const sortBy = (key: PayeeSortKey) =>
    onSort(nextSort(sort, key, PAYEE_SORT_FIRST[key]));
  return (
    <>
      <DataTable caption={tab === "archived" ? "Archived payees" : "Payees"}>
        <thead>
          <tr>
            <SortHeader
              label="Name"
              sortKey="name"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Paid by"
              sortKey="method"
              sort={sort}
              onSort={sortBy}
            />
            <SortHeader
              label="Details changed"
              sortKey="changed"
              sort={sort}
              onSort={sortBy}
              collapse="md"
            />
          </tr>
        </thead>
        <tbody>
          {rows.map((payee) => {
            const sub = payee.details
              ? detailSummary(
                  payee.details,
                  payee.payoutPhoneConfirmed,
                  bankName(payee),
                )
              : null;
            return (
              <DataRow
                key={payee.id}
                open={payee.id === openId}
                onOpen={() => onOpen(payee.id)}
              >
                <Td kind="main">
                  <span className="flex min-w-0 items-start gap-3">
                    <EntityMark
                      name={payee.name}
                      kind={isPerson(payee) ? "person" : "business"}
                    />
                    <span className="min-w-0">
                      <RowTitle onOpen={() => onOpen(payee.id)}>
                        {payee.name}
                      </RowTitle>
                      <RowMeta text={payeeMetaLine(payee)}>
                        {payee.secondConfirmationUntil ? (
                          <Mini
                            icon={ShieldAlertIcon}
                            warn
                            label={`Paying them before ${formatNairobiDateTime(payee.secondConfirmationUntil)} needs a second confirmation.`}
                          >
                            {RECENTLY_CHANGED_LABEL}
                          </Mini>
                        ) : null}
                      </RowMeta>
                    </span>
                  </span>
                </Td>
                <Td className="whitespace-nowrap">
                  {payee.details ? (
                    <>
                      <span className="block leading-6 text-gray-600">
                        {METHOD_LABELS[payee.details.method]}
                      </span>
                      {sub ? (
                        <span
                          title={sub}
                          className="block max-w-[300px] truncate text-gray-500 tabular-nums"
                        >
                          {sub}
                        </span>
                      ) : null}
                    </>
                  ) : (
                    <span className="block leading-6 text-gray-500">
                      No payment details yet
                    </span>
                  )}
                </Td>
                <Td kind="date" collapse="md">
                  {payee.detailsChangedAt ? (
                    <>
                      <span className="block leading-6">
                        {formatNairobiDate(payee.detailsChangedAt)}
                      </span>
                      <span className="block text-gray-500">
                        {formatNairobiTime(payee.detailsChangedAt)}
                      </span>
                    </>
                  ) : (
                    <span className="block leading-6 text-gray-500">Never</span>
                  )}
                </Td>
              </DataRow>
            );
          })}
        </tbody>
      </DataTable>
      <PhoneCards label="Payees">
        {rows.map((payee) => (
          <PhoneCard
            key={payee.id}
            mark={
              <EntityMark
                name={payee.name}
                kind={isPerson(payee) ? "person" : "business"}
              />
            }
            title={payee.name}
            sub={`${KIND_LABELS[payee.kind]} · ${payee.details ? METHOD_LABELS[payee.details.method] : "No payment details yet"}`}
            flags={
              payee.secondConfirmationUntil ? (
                <StatusBadge tone="waiting">
                  {RECENTLY_CHANGED_LABEL}
                </StatusBadge>
              ) : null
            }
            onOpen={() => onOpen(payee.id)}
          />
        ))}
      </PhoneCards>
    </>
  );
}
