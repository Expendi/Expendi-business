"use client";

import type { JSX } from "react";
import {
  BanknoteIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  ClockIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Bill } from "@expendi-business/shared";

import type {
  DataTableColumnDef,
  DataTableInstance,
} from "~/components/data/data-table";
import type { TrendPoint } from "~/components/data/trend-chart";
import {
  EntityMark,
  PhoneCard,
  RowMeta,
  RowTitle,
} from "~/components/data/cells";
import {
  DataTable,
  DataTableColumnHeader,
  DataTablePagination,
  DataTableToolbar,
  selectColumn,
  useDataTable,
} from "~/components/data/data-table";
import { Money } from "~/components/data/money";
import { ResultsPanel } from "~/components/data/results";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { StatusBadge } from "~/components/data/status-badge";
import { TrendChart } from "~/components/data/trend-chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { formatKes } from "~/lib/money";
import { OPEN_BILLS } from "./fixtures/bills";
import { REPORT_SPENDING_12 } from "./fixtures/reports";

const DUE_FORMAT = new Intl.DateTimeFormat("en-KE", {
  day: "numeric",
  month: "short",
});

function dueText(bill: Bill): string {
  return DUE_FORMAT.format(new Date(`${bill.dueOn}T00:00:00`));
}

function amountOf(bill: Bill): number {
  return Number(bill.amountKes ?? bill.amountUsdc ?? 0);
}

function BillAmount({ bill }: { bill: Bill }): JSX.Element {
  return bill.currency === "usd" && bill.amountUsdc ? (
    <Money amount={bill.amountUsdc} currency="USDC" />
  ) : bill.amountKes ? (
    <Money amount={bill.amountKes} currency="KES" />
  ) : (
    <span className="text-muted-foreground">Enter amount</span>
  );
}

function billColumns(onOpen: (bill: Bill) => void): DataTableColumnDef<Bill>[] {
  return [
    selectColumn<Bill>({
      allLabel: "Select every bill on this page",
      rowLabel: (bill) => `Select ${bill.payee.name}`,
    }),
    {
      id: "due",
      accessorKey: "dueOn",
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Due" />
      ),
      cell: ({ row }) => dueText(row.original),
      meta: { kind: "date", label: "Due" },
    },
    {
      id: "payee",
      accessorFn: (bill) => bill.payee.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Payee" />
      ),
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-3">
          <EntityMark name={row.original.payee.name} />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original)}>
              {row.original.payee.name}
            </RowTitle>
            <RowMeta text={row.original.reference} />
          </span>
        </span>
      ),
      meta: { kind: "main", label: "Payee" },
      enableHiding: false,
    },
    {
      id: "category",
      accessorFn: (bill) => bill.category.name,
      header: "Category",
      meta: { collapse: "md" },
    },
    {
      id: "status",
      accessorKey: "status",
      header: "Status",
      cell: ({ row }) => (
        <StatusBadge
          tone={row.original.status === "overdue" ? "overdue" : "quiet"}
        >
          {row.original.status === "overdue" ? "Overdue" : "Upcoming"}
        </StatusBadge>
      ),
      meta: { collapse: "lg" },
    },
    {
      id: "amount",
      accessorFn: amountOf,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => <BillAmount bill={row.original} />,
      sortDescFirst: true,
      meta: { align: "end", label: "Amount" },
    },
  ];
}

function BillPhoneCard({
  bill,
  onOpen,
}: {
  bill: Bill;
  onOpen: () => void;
}): JSX.Element {
  return (
    <PhoneCard
      key={bill.id}
      mark={<EntityMark name={bill.payee.name} />}
      title={bill.payee.name}
      sub={`Due ${dueText(bill)} · ${bill.category.name}`}
      aside={<BillAmount bill={bill} />}
      onOpen={onOpen}
    />
  );
}

/** Client mode: the table sorts, searches and pages the rows itself. */
function ClientTableDemo(): JSX.Element {
  const [openId, setOpenId] = useState<string | null>(null);
  const columns = useMemo(() => billColumns((bill) => setOpenId(bill.id)), []);
  const table = useDataTable({
    data: OPEN_BILLS,
    columns,
    getRowId: (bill) => bill.id,
    sorting: { initial: [{ id: "due", desc: false }] },
    pagination: { initialPageSize: 5 },
    enableRowSelection: true,
  });
  return (
    <ResultsPanel label="Bills, client mode">
      <DataTableToolbar table={table} searchLabel="Search bills" />
      <DataTable
        table={table}
        caption="Bills to pay"
        onRowOpen={(bill) => setOpenId(bill.id)}
        openRowId={openId}
        renderPhoneCard={(row) => (
          <BillPhoneCard
            key={row.id}
            bill={row.original}
            onOpen={() => setOpenId(row.id)}
          />
        )}
      />
      <DataTablePagination table={table} noun="bills" pageSizes={[5, 10, 20]} />
    </ResultsPanel>
  );
}

/**
 * Manual mode: the "server" (here a memo) sorts and pages; the table only
 * reports what was asked for and shows the page it gets back.
 */
function ManualTableDemo(): JSX.Element {
  const [sorting, setSorting] = useState([{ id: "amount", desc: true }]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 4 });
  const page = useMemo(() => {
    const [sort] = sorting;
    const sorted = [...OPEN_BILLS].sort((a, b) => {
      const order =
        sort?.id === "amount"
          ? amountOf(a) - amountOf(b)
          : sort?.id === "payee"
            ? a.payee.name.localeCompare(b.payee.name)
            : a.dueOn.localeCompare(b.dueOn);
      return sort?.desc ? -order : order;
    });
    const start = pagination.pageIndex * pagination.pageSize;
    return sorted.slice(start, start + pagination.pageSize);
  }, [sorting, pagination]);
  const columns = useMemo(() => billColumns(() => undefined).slice(1), []);
  const table: DataTableInstance<Bill> = useDataTable({
    data: page,
    columns,
    getRowId: (bill) => bill.id,
    manual: true,
    rowCount: OPEN_BILLS.length,
    sorting: { value: sorting, onChange: setSorting },
    pagination: { value: pagination, onChange: setPagination },
  });
  return (
    <ResultsPanel label="Bills, manual mode">
      <DataTable table={table} caption="Bills, sorted and paged by the API" />
      <DataTablePagination table={table} noun="bills" pageSizes={[4, 8]} />
    </ResultsPanel>
  );
}

function StatesTableDemo(): JSX.Element {
  const columns = useMemo(() => billColumns(() => undefined).slice(1), []);
  const loading = useDataTable({
    data: [],
    columns,
    getRowId: (bill) => bill.id,
    paginate: false,
  });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <ResultsPanel label="Loading">
        <DataTable table={loading} caption="Loading bills" loading />
      </ResultsPanel>
      <ResultsPanel label="Empty">
        <DataTable
          table={loading}
          caption="No bills"
          empty="No bills to pay. New bills show here."
        />
      </ResultsPanel>
    </div>
  );
}

function shillings(cents: string): number {
  return Number(cents) / 100;
}

const SPENDING: TrendPoint[] = REPORT_SPENDING_12.months.map((month) => ({
  month: month.month,
  total: shillings(month.totalKes),
  salaries: shillings(month.headings.salaries),
  transactions: shillings(month.headings.transactions),
  pettyCash: shillings(month.headings.petty_cash),
}));

const MONTH_FORMAT = new Intl.DateTimeFormat("en-KE", { month: "short" });

function monthTick(month: string): string {
  return MONTH_FORMAT.format(new Date(`${month}-01T00:00:00`));
}

function kes(value: number): string {
  return `KES ${formatKes(String(Math.round(value * 100)))}`;
}

function ChartsDemo(): JSX.Element {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>Spending</CardTitle>
          <CardDescription>The last 12 months, in KES</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart
            label="Spending per month over the last 12 months"
            data={SPENDING}
            xKey="month"
            series={[{ key: "total", label: "Spending" }]}
            formatValue={kes}
            formatTick={monthTick}
          />
        </CardContent>
      </Card>
      <Card className="shadow-xs">
        <CardHeader>
          <CardTitle>By kind</CardTitle>
          <CardDescription>Salaries, payments and petty cash</CardDescription>
        </CardHeader>
        <CardContent>
          <TrendChart
            kind="bar"
            label="Salaries, payments and petty cash per month"
            data={SPENDING.slice(-6)}
            xKey="month"
            series={[
              { key: "salaries", label: "Salaries" },
              { key: "transactions", label: "Payments" },
              { key: "pettyCash", label: "Petty cash" },
            ]}
            formatValue={kes}
            formatTick={monthTick}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function KpiDemo(): JSX.Element {
  return (
    <>
      <StatCards label="Template KPI cards">
        <StatCard
          icon={BanknoteIcon}
          tone="total"
          label="To pay this month"
          value={`KES ${formatKes("48620000")}`}
          trend={{ direction: "up", label: "+12% on October" }}
          sub="14 bills"
        />
        <StatCard
          icon={ClockIcon}
          tone="attention"
          label="Due this week"
          value="5"
          extra="KES 92,400 in total"
        />
        <StatCard
          icon={CircleAlertIcon}
          tone="danger"
          label="Overdue"
          value="2"
          trend={{ direction: "down", label: "−1 since Monday" }}
        />
        <StatCard
          icon={CircleCheckIcon}
          tone="clear"
          label="Failed payments"
          value="All clear"
        />
      </StatCards>
      <StatCards label="Loading KPI cards">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatCards>
    </>
  );
}

/** The template's page patterns, for Phase 2 pages to copy. */
export function KitPatterns(): JSX.Element {
  return (
    <div className="flex flex-col gap-6">
      <KpiDemo />
      <ClientTableDemo />
      <ManualTableDemo />
      <StatesTableDemo />
      <ChartsDemo />
    </div>
  );
}
