"use client";

import type { SortingState } from "@tanstack/react-table";
import type { JSX } from "react";
import {
  ArchiveIcon,
  Building2Icon,
  FilterXIcon,
  PlusIcon,
  TagIcon,
  WalletIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Payee } from "@expendi-business/shared";
import { PAYEE_KINDS, PAYEE_METHODS } from "@expendi-business/shared";

import type { KindTab } from "~/components/data/kind-tabs";
import type { PayeeSortKey } from "~/features/payees/payee-display";
import type { PasskeyState } from "~/features/payment-ui";
import {
  DataTable,
  DataTablePagination,
  DataTableToolbar,
  useDataTable,
} from "~/components/data/data-table";
import { ClearAllButton, FilterChip } from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { PageHeader } from "~/components/data/page-header";
import { ResultsBody, ResultsPanel } from "~/components/data/results";
import { EmptyState, ErrorState } from "~/components/data/states";
import { useDeepLinkParams } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import { useDashboard } from "~/contexts/dashboard-context";
import {
  KIND_LABELS,
  matchesSearch,
  METHOD_LABELS,
  sortPayees,
} from "~/features/payees/payee-display";
import {
  ACTIVE_PAYEES,
  ARCHIVED_PAYEES,
  usePayeeBanks,
  usePayees,
} from "~/features/payees/payees-api";
import { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { payeeColumns, PayeePhoneCard } from "./columns";
import { PayeeSheet } from "./payee-sheet";

type PayeeTab = "active" | "archived";
type Param = "tab" | "kind" | "method" | "q" | "id";

const SORT_KEYS: readonly PayeeSortKey[] = ["name", "method", "changed"];
const DEFAULT_SORTING: SortingState = [{ id: "name", desc: false }];

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
  const [sorting, setSorting] = useState<SortingState>(DEFAULT_SORTING);
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
  const activePayees = useMemo(() => active.data ?? [], [active.data]);
  const archivedPayees = useMemo(() => archived.data ?? [], [archived.data]);

  const matches = useCallback(
    (payee: Payee) =>
      (kind === null || payee.kind === kind) &&
      (method === null || payee.details?.method === method) &&
      matchesSearch(payee.name, search),
    [kind, method, search],
  );
  const sortedBy = sorting[0];
  const sortKey = SORT_KEYS.find((known) => known === sortedBy?.id) ?? "name";
  const sortDir = sortedBy?.desc ? "desc" : "asc";
  const rows = useMemo(
    () =>
      sortPayees(
        (tab === "active" ? activePayees : archivedPayees).filter(matches),
        { key: sortKey, dir: sortDir },
      ),
    [tab, activePayees, archivedPayees, matches, sortKey, sortDir],
  );
  const ids = useMemo(() => rows.map((payee) => payee.id), [rows]);
  const banks = usePayeeBanks(organizationId, {
    enabled: rows.some((payee) => payee.details?.method === "bank"),
  });
  const bankName = useCallback(
    (payee: Payee): string | null => {
      const { details } = payee;
      if (details?.method !== "bank") return null;
      return (
        banks.data?.find((bank) => bank.code === details.bankCode)?.name ?? null
      );
    },
    [banks.data],
  );

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

  const openPayee = useCallback(
    (payee: Payee) => setParams({ id: payee.id }),
    [setParams],
  );
  const columns = useMemo(
    () => payeeColumns({ onOpen: openPayee, bankName }),
    [openPayee, bankName],
  );
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (payee) => payee.id,
    manual: { sorting: true, filtering: true },
    sorting: { value: sorting, onChange: setSorting },
    globalFilter: {
      value: search,
      onChange: (next) => {
        setSearch(next);
        setParams({ q: next.trim() ? next : null });
      },
    },
  });

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
        <div className="border-b border-border">
          <KindTabs
            label="Payees"
            tabs={tabs}
            value={tab}
            onChange={(next) =>
              setParams({ tab: next === "archived" ? next : null })
            }
            controls="payee-results"
          />
        </div>
        <DataTableToolbar
          table={table}
          searchLabel="Search payees by name"
          searchPlaceholder="Search payees"
        >
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
          {anyFilter ? <ClearAllButton onClick={clearAll} /> : null}
        </DataTableToolbar>
        <ResultsBody id="payee-results" busy={loading}>
          {failed ? (
            <ErrorState title="Payees didn't load" onRetry={retry} />
          ) : (
            <DataTable
              table={table}
              caption={tab === "archived" ? "Archived payees" : "Payees"}
              phoneLabel="Payees"
              loading={loading}
              skeletonRows={7}
              onRowOpen={openPayee}
              openRowId={open?.id ?? null}
              empty={
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
              }
              renderPhoneCard={(row) => (
                <PayeePhoneCard
                  key={row.id}
                  payee={row.original}
                  onOpen={() => openPayee(row.original)}
                />
              )}
            />
          )}
        </ResultsBody>
        {loading || failed ? null : (
          <DataTablePagination table={table} noun="payees" />
        )}
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
