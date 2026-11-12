"use client";

import type { JSX } from "react";
import {
  ClockIcon,
  FilterXIcon,
  HandCoinsIcon,
  PlusIcon,
  UsersIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Customer, InvoiceSummary } from "@expendi-business/shared";

import type { InvoiceLocalSheet } from "./invoice-sheet";
import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type { CustomerShow } from "~/features/invoices/customer-list";
import type { InvoiceFilter } from "~/features/invoices/invoice-keys";
import { EntityMark, PhoneCard } from "~/components/data/cells";
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
  customerShowOf,
  filterCustomers,
} from "~/features/invoices/customer-list";
import {
  INVOICE_FILTERS,
  invoiceFilterOf,
} from "~/features/invoices/invoice-keys";
import {
  INVOICE_STATUSES,
  InvoiceStatusBadges,
  Usd,
} from "~/features/invoices/invoice-status";
import { useCustomers, useInvoices } from "~/features/invoices/invoices-api";
import { formatIsoDate } from "~/lib/dates";
import { customerColumns, invoiceColumns } from "./columns";
import { CustomerSheet } from "./customer-sheet";
import { InvoiceSheet, NO_LOCAL_SHEET } from "./invoice-sheet";

type InvoicesTab = "invoices" | "customers";
type Param = "tab" | "status" | "archived" | "invoice" | "customer";

const STATUS_OPTIONS: readonly FilterOption[] = INVOICE_FILTERS.map(
  (status) => ({
    value: status,
    label: INVOICE_STATUSES[status].label,
    tone: INVOICE_STATUSES[status].tone,
  }),
);

const SHOW_OPTIONS: readonly FilterOption[] = [
  { value: "archived", label: "Archived only" },
  { value: "all", label: "Active and archived" },
];

/**
 * Invoices (docs/decisions/crypto-invoicing.md): what customers owe the
 * company, in US dollars, paid in USDC through a link that needs no
 * account, and the customers behind them. Admins create, send and settle
 * invoices and manage customers; accountants see the same, read-only. The
 * tab, filters and the open invoice or customer live in the URL.
 */
export function InvoicesView(): JSX.Element {
  const { company, canAct } = useDashboard();
  return (
    <CompanyInvoices
      key={company.organizationId}
      organizationId={company.organizationId}
      canAct={canAct}
    />
  );
}

function CompanyInvoices({
  organizationId,
  canAct,
}: {
  organizationId: string;
  canAct: boolean;
}): JSX.Element {
  const [param, setParams] = useDeepLinkParams<Param>();
  const invoiceId = param("invoice");
  const customerId = invoiceId ? null : param("customer");
  const tab: InvoicesTab =
    param("tab") === "customers" && !invoiceId ? "customers" : "invoices";
  const status = invoiceFilterOf(param("status"));
  const show = customerShowOf(param("archived"));
  const [local, setLocal] = useState<InvoiceLocalSheet>(NO_LOCAL_SHEET);
  const [creatingCustomer, setCreatingCustomer] = useState(false);

  const invoices = useInvoices(organizationId, status, {
    enabled: tab === "invoices",
  });
  const customers = useCustomers(organizationId, true);
  const customerRows = useMemo(
    () => filterCustomers(customers.data ?? [], show),
    [customers.data, show],
  );

  function closeSheet() {
    setLocal(NO_LOCAL_SHEET);
    setCreatingCustomer(false);
    setParams({ invoice: null, customer: null });
  }

  function openInvoice(id: string) {
    setLocal(NO_LOCAL_SHEET);
    setParams({ invoice: id });
  }

  function openCustomer(id: string) {
    setCreatingCustomer(false);
    setParams({ customer: id });
  }

  function showTab(next: InvoicesTab) {
    closeSheet();
    setParams({
      tab: next === "customers" ? next : null,
      status: null,
      archived: null,
    });
  }

  const tabs: readonly KindTab<InvoicesTab>[] = [
    { value: "invoices", label: "Invoices" },
    { value: "customers", label: "Customers" },
  ];

  return (
    <section>
      <PageHeader
        title="Invoices"
        subtitle={
          canAct
            ? "Bill customers in US dollars. They pay in USDC from a link, with no account, and the invoice marks itself paid."
            : "Invoices and customers. Only admins create, send and change them."
        }
        actions={
          canAct ? (
            tab === "invoices" ? (
              <Button
                size="md"
                aria-haspopup="dialog"
                onClick={() => {
                  setParams({ invoice: null, customer: null });
                  setLocal({ kind: "new-invoice" });
                }}
              >
                <PlusIcon aria-hidden="true" />
                New invoice
              </Button>
            ) : (
              <Button
                size="md"
                aria-haspopup="dialog"
                onClick={() => {
                  setParams({ invoice: null, customer: null });
                  setCreatingCustomer(true);
                }}
              >
                <PlusIcon aria-hidden="true" />
                New customer
              </Button>
            )
          ) : null
        }
      />

      <ResultsPanel label="Invoices">
        <div className="overflow-x-auto border-b border-border px-4 py-3">
          <KindTabs
            label="Invoices"
            tabs={tabs}
            value={tab}
            onChange={showTab}
            controls="invoice-results"
          />
        </div>
        {tab === "invoices" ? (
          <InvoiceList
            rows={invoices.data ?? []}
            status={status}
            loading={invoices.isPending}
            failed={invoices.isError}
            refreshing={invoices.isPlaceholderData}
            canAct={canAct}
            openId={invoiceId}
            onStatus={(next) => setParams({ status: next })}
            onOpen={openInvoice}
            onNew={() => setLocal({ kind: "new-invoice" })}
            onRetry={() => void invoices.refetch()}
          />
        ) : (
          <CustomerList
            rows={customerRows}
            show={show}
            loading={customers.isPending}
            failed={customers.isError}
            canAct={canAct}
            openId={customerId}
            onShow={(next) => setParams({ archived: next })}
            onOpen={openCustomer}
            onNew={() => setCreatingCustomer(true)}
            onRetry={() => void customers.refetch()}
          />
        )}
      </ResultsPanel>

      <InvoiceSheet
        organizationId={organizationId}
        canAct={canAct}
        rows={invoices.data ?? []}
        invoiceId={invoiceId}
        local={local}
        onOpen={openInvoice}
        onLocal={setLocal}
        onClose={closeSheet}
        onCreated={(created) => {
          setLocal(NO_LOCAL_SHEET);
          setParams({ invoice: created.id, status: null });
        }}
      />
      <CustomerSheet
        organizationId={organizationId}
        canAct={canAct}
        customers={customers.data ?? []}
        rows={customerRows}
        customerId={customerId}
        creating={creatingCustomer}
        loading={customers.isPending}
        onOpen={openCustomer}
        onClose={closeSheet}
      />
    </section>
  );
}

function InvoiceList({
  rows,
  status,
  loading,
  failed,
  refreshing,
  canAct,
  openId,
  onStatus,
  onOpen,
  onNew,
  onRetry,
}: {
  rows: readonly InvoiceSummary[];
  status: InvoiceFilter | null;
  loading: boolean;
  failed: boolean;
  refreshing: boolean;
  canAct: boolean;
  openId: string | null;
  onStatus: (status: string | null) => void;
  onOpen: (invoiceId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}): JSX.Element {
  const columns = useMemo(() => invoiceColumns({ onOpen }), [onOpen]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (invoice) => invoice.id,
  });
  const filtered = status !== null;

  return (
    <>
      <DataTableToolbar
        table={table}
        searchLabel="Search invoices by number or customer"
        searchPlaceholder="Search invoices"
        actions={
          filtered ? <ClearAllButton onClick={() => onStatus(null)} /> : null
        }
      >
        <FilterChip
          label="Status"
          icon={ClockIcon}
          options={STATUS_OPTIONS}
          value={status}
          onChange={onStatus}
          anyLabel="All"
        />
      </DataTableToolbar>
      <ResultsBody id="invoice-results" busy={loading} refreshing={refreshing}>
        {failed ? (
          <ErrorState title="Invoices didn't load" onRetry={onRetry} />
        ) : (
          <DataTable
            table={table}
            caption="Invoices"
            phoneLabel="Invoices"
            loading={loading}
            onRowOpen={(invoice) => onOpen(invoice.id)}
            openRowId={openId}
            empty={
              <EmptyState
                icon={filtered ? FilterXIcon : HandCoinsIcon}
                title={
                  filtered ? "No invoices match this filter" : "No invoices yet"
                }
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => onStatus(null)}
                    >
                      Clear all
                    </Button>
                  ) : canAct ? (
                    <Button variant="outline" size="md" onClick={onNew}>
                      <PlusIcon aria-hidden="true" />
                      New invoice
                    </Button>
                  ) : null
                }
              >
                {filtered
                  ? null
                  : "Invoices you create, and the ones you send, show up here."}
              </EmptyState>
            }
            renderPhoneCard={(row) => (
              <PhoneCard
                key={row.id}
                title={row.original.number}
                sub={`${row.original.customerName} · Due ${formatIsoDate(row.original.dueOn)}`}
                flags={
                  <InvoiceStatusBadges
                    status={row.original.status}
                    overdue={row.original.overdue}
                  />
                }
                aside={
                  <span className="text-base leading-6 font-(--w-amount)">
                    <Usd cents={row.original.totalCents} />
                  </span>
                }
                onOpen={() => onOpen(row.original.id)}
              />
            )}
          />
        )}
      </ResultsBody>
      {loading || failed ? null : (
        <DataTablePagination table={table} noun="invoices" />
      )}
    </>
  );
}

function CustomerList({
  rows,
  show,
  loading,
  failed,
  canAct,
  openId,
  onShow,
  onOpen,
  onNew,
  onRetry,
}: {
  rows: readonly Customer[];
  show: CustomerShow;
  loading: boolean;
  failed: boolean;
  canAct: boolean;
  openId: string | null;
  onShow: (show: string | null) => void;
  onOpen: (customerId: string) => void;
  onNew: () => void;
  onRetry: () => void;
}): JSX.Element {
  const columns = useMemo(() => customerColumns({ onOpen }), [onOpen]);
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (customer) => customer.id,
    sorting: { initial: [{ id: "name", desc: false }] },
  });
  const filtered = show !== "active";

  return (
    <>
      <DataTableToolbar
        table={table}
        searchLabel="Search customers by name or email"
        searchPlaceholder="Search customers"
        actions={
          filtered ? <ClearAllButton onClick={() => onShow(null)} /> : null
        }
      >
        <FilterChip
          label="Show"
          icon={UsersIcon}
          options={SHOW_OPTIONS}
          value={filtered ? show : null}
          onChange={onShow}
          anyLabel="Active customers"
        />
      </DataTableToolbar>
      <ResultsBody id="invoice-results" busy={loading}>
        {failed ? (
          <ErrorState title="Customers didn't load" onRetry={onRetry} />
        ) : (
          <DataTable
            table={table}
            caption="Customers"
            phoneLabel="Customers"
            loading={loading}
            onRowOpen={(customer) => onOpen(customer.id)}
            openRowId={openId}
            empty={
              <EmptyState
                icon={filtered ? FilterXIcon : UsersIcon}
                title={
                  filtered
                    ? "No customers match this filter"
                    : "No customers yet"
                }
                action={
                  filtered ? (
                    <Button
                      variant="outline"
                      size="md"
                      onClick={() => onShow(null)}
                    >
                      Clear all
                    </Button>
                  ) : canAct ? (
                    <Button variant="outline" size="md" onClick={onNew}>
                      <PlusIcon aria-hidden="true" />
                      New customer
                    </Button>
                  ) : null
                }
              >
                {filtered ? null : "Add the people and companies you invoice."}
              </EmptyState>
            }
            renderPhoneCard={(row) => (
              <PhoneCard
                key={row.id}
                mark={<EntityMark name={row.original.name} />}
                title={row.original.name}
                sub={row.original.email}
                onOpen={() => onOpen(row.original.id)}
              />
            )}
          />
        )}
      </ResultsBody>
      {loading || failed ? null : (
        <DataTablePagination table={table} noun="customers" />
      )}
    </>
  );
}
