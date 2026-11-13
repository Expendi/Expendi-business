"use client";

import type { JSX, ReactNode } from "react";
import {
  BanIcon,
  Building2Icon,
  CheckIcon,
  CircleAlertIcon,
  ClockIcon,
  FileTextIcon,
  FilterXIcon,
  KeyRoundIcon,
  LayersIcon,
  PaperclipIcon,
  PencilIcon,
  PlusIcon,
  RepeatIcon,
  RotateCcwIcon,
  TagIcon,
  TriangleAlertIcon,
  UploadIcon,
  WalletIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { Bill, BillStatus, PayeeMethod } from "@expendi-business/shared";

import type {
  DataTableColumnDef,
  SortState,
} from "~/components/data/data-table";
import type { FilterOption } from "~/components/data/filter-chip";
import type { KindTab } from "~/components/data/kind-tabs";
import type { StatusTone } from "~/components/data/status-badge";
import { IconButton, TextLinkButton } from "~/components/data/actions";
import { Banner, Banners } from "~/components/data/banner";
import {
  EntityMark,
  Mini,
  PhoneCard,
  RowCheckbox,
  RowMeta,
  RowTitle,
} from "~/components/data/cells";
import {
  DataTable,
  DataTableColumnHeader,
  nextSort,
  pressedKey,
  toSorting,
  useDataTable,
} from "~/components/data/data-table";
import {
  Callout,
  DetailItem,
  DetailList,
  DetailSheet,
  ReadOnlyNote,
  SectionLabel,
  SheetActions,
  SheetPosition,
} from "~/components/data/detail-sheet";
import {
  FilterChip,
  FilterMenuPanel,
  FilterOptionList,
} from "~/components/data/filter-chip";
import { KindTabs } from "~/components/data/kind-tabs";
import { AmountStack, KesTotal, Money } from "~/components/data/money";
import { PageHeader } from "~/components/data/page-header";
import {
  ResultsBody,
  ResultsHead,
  ResultsPanel,
} from "~/components/data/results";
import { SelectionBar } from "~/components/data/selection-bar";
import {
  StatCard,
  StatCards,
  StatCardSkeleton,
} from "~/components/data/stat-cards";
import { EmptyState, ErrorState } from "~/components/data/states";
import { StatusBadge } from "~/components/data/status-badge";
import { useDeepLinkParam } from "~/components/data/use-deep-link-param";
import { Button } from "~/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "~/components/ui/field";
import { Input } from "~/components/ui/input";
import {
  NativeSelect,
  NativeSelectOption,
} from "~/components/ui/native-select";
import { Textarea } from "~/components/ui/textarea";
import {
  approxKesTotal,
  formatKes,
  totalsByCurrency,
  usdcToKesCents,
} from "~/lib/money";
import { OPEN_BILLS } from "./fixtures/bills";
import { KES_RATE, TODAY } from "./fixtures/company";
import { KitPatterns } from "./kit-patterns";

const STATUS: Record<BillStatus, { label: string; tone: StatusTone }> = {
  upcoming: { label: "Upcoming", tone: "quiet" },
  due: { label: "Due today", tone: "waiting" },
  overdue: { label: "Overdue", tone: "overdue" },
  paying: { label: "Being paid", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  payout_failed: { label: "Payment failed", tone: "failed" },
  paid_outside: { label: "Paid outside Expendi", tone: "paid" },
  paid_by_card: { label: "Paid by card", tone: "paid" },
  cancelled: { label: "Cancelled", tone: "rejected" },
};

const METHODS: Record<PayeeMethod, string> = {
  mpesa_phone: "M-Pesa number",
  mpesa_till: "M-Pesa Till",
  mpesa_paybill: "M-Pesa Paybill",
  bank: "Bank account",
  usdc: "USDC wallet",
  outside: "Paid outside Expendi",
};

const URGENCY: Record<BillStatus, number> = {
  payout_failed: 0,
  overdue: 1,
  due: 2,
  upcoming: 3,
  paying: 4,
  paid: 5,
  paid_outside: 6,
  paid_by_card: 7,
  cancelled: 8,
};

type View = "open" | "paying";
type SortKey = "date" | "payee" | "amount" | "status";

const UNPAID: readonly BillStatus[] = [
  "upcoming",
  "due",
  "overdue",
  "payout_failed",
];

const STATUS_OPTIONS: readonly FilterOption[] = (
  ["payout_failed", "overdue", "due", "upcoming"] as const
).map((value) => ({ value, ...STATUS[value] }));

const PAYEE_OPTIONS: readonly FilterOption[] = [
  ...new Map(OPEN_BILLS.map((bill) => [bill.payee.id, bill.payee.name])),
]
  .map(([value, label]) => ({ value, label, mark: true }))
  .sort((a, b) => a.label.localeCompare(b.label));

const CATEGORY_OPTIONS: readonly FilterOption[] = [
  ...new Set(OPEN_BILLS.map((bill) => bill.category.name)),
]
  .sort()
  .map((name) => ({ value: name, label: name }));

function kesValue(bill: Bill): bigint {
  if (bill.amountUsdc !== null) {
    return BigInt(usdcToKesCents(bill.amountUsdc, KES_RATE) ?? "0");
  }
  return bill.amountKes === null ? -1n : BigInt(bill.amountKes);
}

function compare(sort: SortState<SortKey>) {
  return (a: Bill, b: Bill): number => {
    const byDate = a.dueOn.localeCompare(b.dueOn);
    const primary =
      sort.key === "status"
        ? URGENCY[a.status] - URGENCY[b.status]
        : sort.key === "date"
          ? byDate
          : sort.key === "payee"
            ? a.payee.name.localeCompare(b.payee.name)
            : Number(kesValue(a) - kesValue(b));
    return (sort.dir === "asc" ? primary : -primary) || byDate;
  };
}

function daysUntil(iso: string): number {
  return Math.round(
    (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${TODAY}T00:00:00Z`)) /
      86_400_000,
  );
}

function dateText(iso: string): string {
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function DueHint({ bill }: { bill: Bill }): JSX.Element | null {
  if (!UNPAID.includes(bill.status)) return null;
  const days = daysUntil(bill.dueOn);
  if (days < 0) {
    return (
      <span className="block text-xs leading-4 font-(--w-ui) text-error-700">
        {-days} {days === -1 ? "day" : "days"} late
      </span>
    );
  }
  if (days === 0) {
    return (
      <span className="block text-xs leading-4 font-(--w-ui) text-warn-700">
        Today
      </span>
    );
  }
  if (days > 14) return null;
  return (
    <span className="block text-xs leading-4 text-gray-500">
      In {days} {days === 1 ? "day" : "days"}
    </span>
  );
}

function BillAmount({ bill }: { bill: Bill }): JSX.Element {
  if (bill.currency === "usd" && bill.amountUsdc !== null) {
    const kes = usdcToKesCents(bill.amountUsdc, KES_RATE);
    return (
      <AmountStack sub={kes === null ? null : `≈ KES ${formatKes(kes)} today`}>
        <Money amount={bill.amountUsdc} currency="USD" />
      </AmountStack>
    );
  }
  if (bill.amountKes === null) {
    return <span className="text-gray-500">To enter</span>;
  }
  return (
    <AmountStack>
      <Money amount={bill.amountKes} currency="KES" />
    </AmountStack>
  );
}

function Markers({ bill }: { bill: Bill }): ReactNode {
  return (
    <>
      {bill.recurringItemId ? (
        <Mini icon={RepeatIcon} label="Recurring" />
      ) : null}
      {bill.fileCount > 0 ? (
        <Mini
          icon={PaperclipIcon}
          label={`${String(bill.fileCount)} ${bill.fileCount === 1 ? "file" : "files"}`}
        >
          {bill.fileCount}
        </Mini>
      ) : null}
      {bill.amountKes === null && bill.amountUsdc === null ? (
        <Mini icon={TriangleAlertIcon} label="No amount yet" warn>
          No amount
        </Mini>
      ) : null}
    </>
  );
}

function totalOf(bills: readonly Bill[]) {
  return approxKesTotal({
    ...totalsByCurrency(
      bills.map((bill) => ({
        currency: bill.currency,
        amount: bill.currency === "usd" ? bill.amountUsdc : bill.amountKes,
      })),
    ),
    rate: KES_RATE,
  });
}

export function KitGallery(): JSX.Element {
  return (
    <div>
      <PageHeader
        title="Kit"
        subtitle="Every shared data component in its states, with the mocks' sample data. Compare with docs/mocks/bills.html."
        actions={
          <>
            <Button variant="outline" size="md">
              <UploadIcon aria-hidden="true" />
              Import spreadsheet
            </Button>
            <Button variant="outline" size="md" aria-haspopup="dialog">
              <RepeatIcon aria-hidden="true" />
              Recurring payments
            </Button>
            <Button size="md">
              <PlusIcon aria-hidden="true" />
              New bill
            </Button>
          </>
        }
      />
      <Banners>
        <Banner
          role="note"
          icon={KeyRoundIcon}
          title="Set up your approval passkey first"
        >
          Paying needs your approval passkey. Set it up in the Expendi Business
          app; then confirm here with “use a phone or tablet” in your browser’s
          passkey prompt.
        </Banner>
        <Banner
          tone="success"
          role="status"
          title="2 bills are being paid"
          actions={
            <>
              <Button variant="outline" size="md">
                See Being paid
              </Button>
              <Button variant="outline" size="md">
                Done
              </Button>
            </>
          }
        >
          Kilimani Properties and Securex Guards. Each payee gets their money on
          its own.
        </Banner>
        <Banner
          tone="warn"
          role="status"
          title="1 payment failed"
          actions={
            <Button size="md">
              <RotateCcwIcon aria-hidden="true" />
              Retry the failed payment
            </Button>
          }
        >
          <p>Zuku wasn’t paid.</p>
          <p>The paybill didn’t accept the account number.</p>
        </Banner>
      </Banners>
      <StatCardsDemo />
      <BillsDemo />

      <KitSection title="Template page patterns: KPI cards, data table (client and manual), charts">
        <div className="mt-4">
          <KitPatterns />
        </div>
      </KitSection>

      <KitSection title="Results head, stacked (forced), with filters set">
        <StackedDemo />
      </KitSection>

      <KitSection title="Loading and error">
        <ResultsPanel label="Loading">
          <ResultsHead
            tabs={
              <KindTabs
                label="Bills"
                value="open"
                onChange={() => undefined}
                tabs={[
                  { value: "open", label: "To pay" },
                  { value: "paying", label: "Being paid" },
                  { value: "history", label: "History" },
                ]}
              />
            }
            chips={
              <FilterChip
                label="Status"
                icon={ClockIcon}
                options={STATUS_OPTIONS}
                value={null}
                onChange={() => undefined}
                anyLabel="Any status"
                disabled
              />
            }
          />
          <ResultsBody busy>
            <LoadingBillsTable />
          </ResultsBody>
        </ResultsPanel>
        <ResultsPanel label="Error">
          <ErrorState title="Bills didn't load" onRetry={() => undefined} />
        </ResultsPanel>
      </KitSection>

      <KitSection title="Filter menus, open">
        <div className="mt-4 flex flex-wrap items-start gap-6">
          <FilterMenuPanel inline>
            <FilterOptionList
              id="kit-status"
              label="Status"
              options={[{ value: "", label: "Any status" }, ...STATUS_OPTIONS]}
              current="overdue"
              active={3}
              onChoose={() => undefined}
              onActivate={() => undefined}
            />
          </FilterMenuPanel>
          <FilterMenuPanel
            inline
            search={
              <input
                type="search"
                placeholder="Search payees"
                aria-label="Search payees"
                className="min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-gray-500"
              />
            }
          >
            <FilterOptionList
              id="kit-payee"
              label="Payee"
              options={[
                { value: "", label: "Every payee" },
                ...PAYEE_OPTIONS.slice(0, 6),
              ]}
              current=""
              active={2}
              onChoose={() => undefined}
              onActivate={() => undefined}
            />
          </FilterMenuPanel>
        </div>
      </KitSection>

      <KitSection title="Atoms">
        <AtomsDemo />
      </KitSection>

      <KitSection title="Form fields (side sheet forms)">
        <FormDemo />
      </KitSection>
    </div>
  );
}

function KitSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section aria-label={title} className="mt-10">
      <h2 className="border-b border-dashed border-gray-300 pb-2 text-xs leading-4 font-(--w-ui) text-gray-500">
        {title}
      </h2>
      {children}
    </section>
  );
}

function StatCardsDemo(): JSX.Element {
  const toPay = OPEN_BILLS.filter((bill) => UNPAID.includes(bill.status));
  const missing = toPay.filter(
    (bill) => bill.amountKes === null && bill.amountUsdc === null,
  ).length;
  const of = (status: BillStatus) =>
    OPEN_BILLS.filter((bill) => bill.status === status);
  const overdue = of("overdue");
  const due = of("due");
  const failed = of("payout_failed");
  return (
    <>
      <StatCards>
        <StatCard
          icon={FileTextIcon}
          tone="total"
          label="To pay"
          value={<KesTotal total={totalOf(toPay)} />}
          sub={`${String(toPay.length)} bills · ${String(missing)} without an amount`}
        />
        <StatCard
          icon={TriangleAlertIcon}
          tone="danger"
          label="Overdue"
          value={overdue.length}
          sub={<KesTotal total={totalOf(overdue)} />}
        />
        <StatCard
          icon={ClockIcon}
          tone="attention"
          label="Due today"
          value={due.length}
          sub={<KesTotal total={totalOf(due)} />}
        />
        <StatCard
          icon={failed.length ? CircleAlertIcon : CheckIcon}
          tone={failed.length ? "danger" : "clear"}
          label="Payment failed"
          value={failed.length}
          sub={
            failed.length ? <KesTotal total={totalOf(failed)} /> : "All clear"
          }
        />
      </StatCards>
      <StatCards label="Loading summary">
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
        <StatCardSkeleton />
      </StatCards>
    </>
  );
}

const SORT_FIRST: Record<SortKey, "asc" | "desc"> = {
  date: "asc",
  payee: "asc",
  amount: "desc",
  status: "asc",
};

const SORT_KEYS: readonly SortKey[] = ["date", "payee", "amount", "status"];

function billColumns({
  view,
  checkbox,
  onOpen,
}: {
  view: View;
  checkbox: ((bill: Bill) => ReactNode) | null;
  onOpen: (id: string) => void;
}): DataTableColumnDef<Bill>[] {
  const columns: DataTableColumnDef<Bill>[] = [
    {
      id: "date",
      accessorFn: (bill) => bill.dueOn,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Due" />
      ),
      cell: ({ row }) => (
        <>
          {dateText(row.original.dueOn)}
          <DueHint bill={row.original} />
        </>
      ),
      meta: { kind: "date", label: "Due" },
    },
    {
      id: "payee",
      accessorFn: (bill) => bill.payee.name,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Payee" />
      ),
      cell: ({ row }) => (
        <span className="flex min-w-0 items-start gap-3">
          <EntityMark name={row.original.payee.name} />
          <span className="min-w-0">
            <RowTitle onOpen={() => onOpen(row.original.id)}>
              {row.original.payee.name}
            </RowTitle>
            <RowMeta
              text={[row.original.reference, row.original.category.name]
                .filter(Boolean)
                .join(" · ")}
            >
              <Markers bill={row.original} />
            </RowMeta>
          </span>
        </span>
      ),
      meta: { kind: "main", label: "Payee" },
    },
    {
      id: "method",
      accessorFn: (bill) => bill.payee.method ?? "",
      header: "Paid by",
      cell: ({ row }) => (
        <span
          className={
            row.original.payee.method ? "text-gray-600" : "text-gray-500"
          }
        >
          {row.original.payee.method
            ? METHODS[row.original.payee.method]
            : "Not set"}
        </span>
      ),
      enableSorting: false,
      meta: {
        collapse: "lg",
        label: "Paid by",
        className: "whitespace-nowrap",
      },
    },
    {
      id: "amount",
      accessorFn: (bill) => kesValue(bill).toString(),
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Amount" />
      ),
      cell: ({ row }) => <BillAmount bill={row.original} />,
      meta: { align: "end", label: "Amount" },
    },
    {
      id: "status",
      accessorFn: (bill) => bill.status,
      header: ({ column }) => (
        <DataTableColumnHeader column={column} title="Status" />
      ),
      cell: ({ row }) => (
        <StatusBadge tone={STATUS[row.original.status].tone}>
          {STATUS[row.original.status].label}
        </StatusBadge>
      ),
      meta: { label: "Status" },
    },
  ];
  if (view !== "open" || !checkbox) return columns;
  return [
    {
      id: "select",
      header: () => <span className="sr-only">Select</span>,
      cell: ({ row }) => checkbox(row.original),
      enableSorting: false,
      meta: { kind: "checkbox" },
    },
    ...columns,
  ];
}

function LoadingBillsTable(): JSX.Element {
  const columns = useMemo(
    () =>
      billColumns({ view: "paying", checkbox: null, onOpen: () => undefined }),
    [],
  );
  const table = useDataTable({
    data: [] as Bill[],
    columns,
    getRowId: (bill) => bill.id,
  });
  return <DataTable table={table} caption="Loading bills" loading />;
}

function BillsDemo(): JSX.Element {
  const [view, setView] = useState<View>("open");
  const [status, setStatus] = useState<string | null>(null);
  const [payeeId, setPayeeId] = useState<string | null>(null);
  const [category, setCategory] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<SortKey>>({
    key: "status",
    dir: "asc",
  });
  const [selected, setSelected] = useState<string[]>([OPEN_BILLS[0]?.id ?? ""]);
  const [openId, setOpenId] = useDeepLinkParam("billId");

  const inView = (bill: Bill) =>
    view === "open" ? UNPAID.includes(bill.status) : bill.status === "paying";
  const matches = (bill: Bill) =>
    (status === null || bill.status === status) &&
    (payeeId === null || bill.payee.id === payeeId) &&
    (category === null || bill.category.name === category);
  const rows = OPEN_BILLS.filter((bill) => inView(bill) && matches(bill)).sort(
    compare(sort),
  );
  const selectedRows = useMemo(
    () => Object.fromEntries(selected.map((id) => [id, true as const])),
    [selected],
  );
  const tabs: readonly KindTab<View>[] = [
    {
      value: "open",
      label: "To pay",
      count: OPEN_BILLS.filter((b) => UNPAID.includes(b.status) && matches(b))
        .length,
    },
    {
      value: "paying",
      label: "Being paid",
      count: OPEN_BILLS.filter((b) => b.status === "paying" && matches(b))
        .length,
    },
  ];
  const payable = (bill: Bill) =>
    view === "open" &&
    bill.status !== "payout_failed" &&
    bill.payee.method !== null &&
    bill.payee.method !== "outside" &&
    (bill.amountKes !== null || bill.amountUsdc !== null);
  const chosen = OPEN_BILLS.filter((bill) => selected.includes(bill.id));
  const anySet = status !== null || payeeId !== null || category !== null;
  const ids = rows.map((bill) => bill.id);
  const openIndex = openId ? ids.indexOf(openId) : -1;
  const openBill = OPEN_BILLS.find((bill) => bill.id === openId);

  function toggle(id: string) {
    setSelected((now) =>
      now.includes(id) ? now.filter((x) => x !== id) : [...now, id],
    );
  }

  function checkbox(bill: Bill) {
    if (!payable(bill)) return null;
    return (
      <RowCheckbox
        checked={selected.includes(bill.id)}
        onChange={() => toggle(bill.id)}
        aria-label={`Select ${bill.payee.name}`}
      />
    );
  }

  const columns = billColumns({
    view,
    checkbox,
    onOpen: setOpenId,
  });
  const table = useDataTable({
    data: rows,
    columns,
    getRowId: (bill) => bill.id,
    manual: { sorting: true },
    paginate: false,
    sorting: {
      value: toSorting(sort),
      onChange: (next) => {
        const key = pressedKey(next, sort, SORT_KEYS);
        setSort(nextSort(sort, key, SORT_FIRST[key]));
      },
    },
    rowSelection: { value: selectedRows },
  });

  return (
    <ResultsPanel label="Bills">
      <ResultsHead
        tabs={
          <KindTabs
            label="Bills"
            tabs={tabs}
            value={view}
            onChange={(next) => {
              setView(next);
              setStatus(null);
              setSelected([]);
            }}
            controls="kit-results"
          />
        }
        chips={
          <>
            {view === "open" ? (
              <FilterChip
                label="Status"
                icon={ClockIcon}
                options={STATUS_OPTIONS}
                value={status}
                onChange={setStatus}
                anyLabel="Any status"
              />
            ) : null}
            <FilterChip
              label="Payee"
              icon={Building2Icon}
              options={PAYEE_OPTIONS}
              value={payeeId}
              onChange={setPayeeId}
              anyLabel="Every payee"
              searchPlaceholder="Search payees"
            />
            <FilterChip
              label="Category"
              icon={TagIcon}
              options={CATEGORY_OPTIONS}
              value={category}
              onChange={setCategory}
              anyLabel="All categories"
            />
          </>
        }
        onClearAll={
          anySet
            ? () => {
                setStatus(null);
                setPayeeId(null);
                setCategory(null);
              }
            : undefined
        }
      />
      <ResultsBody id="kit-results">
        {rows.length === 0 ? (
          <EmptyState
            icon={FilterXIcon}
            title="No bills match these filters"
            action={
              <Button
                variant="outline"
                size="md"
                onClick={() => {
                  setStatus(null);
                  setPayeeId(null);
                  setCategory(null);
                }}
              >
                Clear all
              </Button>
            }
          />
        ) : (
          <DataTable
            table={table}
            caption="Bills to pay"
            phoneLabel="Bills"
            onRowOpen={(bill) => setOpenId(bill.id)}
            openRowId={openId}
            renderPhoneCard={(row) => {
              const bill = row.original;
              return (
                <PhoneCard
                  key={row.id}
                  mark={<EntityMark name={bill.payee.name} />}
                  title={bill.payee.name}
                  sub={`Due ${dateText(bill.dueOn)}`}
                  flags={
                    <>
                      <StatusBadge tone={STATUS[bill.status].tone}>
                        {STATUS[bill.status].label}
                      </StatusBadge>
                      <Markers bill={bill} />
                    </>
                  }
                  aside={<BillAmount bill={bill} />}
                  onOpen={() => setOpenId(bill.id)}
                  check={view === "open" ? checkbox(bill) : undefined}
                  selected={selected.includes(bill.id)}
                />
              );
            }}
          />
        )}
        {view === "open" ? (
          <SelectionBar
            summary={
              chosen.length === 0 ? (
                "Select bills to pay together."
              ) : (
                <>
                  <strong className="tabular-nums">
                    {chosen.length} selected
                  </strong>
                  {" · "}
                  <KesTotal total={totalOf(chosen)} />
                </>
              )
            }
            links={
              <>
                <TextLinkButton
                  onClick={() =>
                    setSelected(rows.filter(payable).map((bill) => bill.id))
                  }
                >
                  Select all payable
                </TextLinkButton>
                {chosen.length ? (
                  <TextLinkButton onClick={() => setSelected([])}>
                    Clear selection
                  </TextLinkButton>
                ) : null}
              </>
            }
            action={
              <Button disabled={chosen.length === 0}>
                {chosen.length > 1 ? `Pay all ${String(chosen.length)}` : "Pay"}
              </Button>
            }
          />
        ) : null}
      </ResultsBody>
      <DetailSheet
        open={openBill !== undefined}
        onClose={() => setOpenId(null)}
        eyebrow={openBill?.recurringItemId ? "Recurring payment" : "Bill"}
        title={openBill?.payee.name ?? ""}
        stepKey={openId ?? undefined}
        headerExtra={
          openBill ? (
            <>
              <p className="mt-0.5 text-2xl leading-8 font-(--w-heading) tracking-[-0.02em]">
                <BillAmountInSheet bill={openBill} />
              </p>
              <StatusBadge tone={STATUS[openBill.status].tone} className="mt-2">
                {STATUS[openBill.status].label}
              </StatusBadge>
            </>
          ) : null
        }
        stepper={{
          index: openIndex,
          total: ids.length,
          onStep: (delta) => {
            const next = ids[openIndex + delta];
            if (next) setOpenId(next);
          },
          previousLabel: "Previous bill",
          nextLabel: "Next bill",
        }}
        footer={
          openBill ? (
            <>
              <SheetActions kind="primary">
                {payable(openBill) ? (
                  <Button>
                    <KeyRoundIcon aria-hidden="true" />
                    Pay
                  </Button>
                ) : null}
                <Button variant={payable(openBill) ? "outline" : "default"}>
                  <PencilIcon aria-hidden="true" />
                  {openBill.amountKes === null && openBill.amountUsdc === null
                    ? "Enter the amount"
                    : "Edit bill"}
                </Button>
              </SheetActions>
              <SheetActions kind="secondary">
                <Button variant="ghost" size="md">
                  Add invoice
                </Button>
                <Button variant="danger" size="md">
                  Cancel bill
                </Button>
              </SheetActions>
              <ReadOnlyNote icon={KeyRoundIcon} wide>
                Paying needs your approval passkey.
              </ReadOnlyNote>
              <SheetPosition index={openIndex} total={ids.length} />
            </>
          ) : null
        }
      >
        {openBill ? <BillDetail bill={openBill} /> : null}
      </DetailSheet>
    </ResultsPanel>
  );
}

function BillAmountInSheet({ bill }: { bill: Bill }): JSX.Element {
  if (bill.currency === "usd" && bill.amountUsdc !== null) {
    const kes = usdcToKesCents(bill.amountUsdc, KES_RATE);
    return (
      <AmountStack
        align="start"
        size="inherit"
        sub={kes === null ? null : `≈ KES ${formatKes(kes)} today`}
      >
        <Money amount={bill.amountUsdc} currency="USD" />
      </AmountStack>
    );
  }
  if (bill.amountKes === null) {
    return <span className="text-base text-gray-500">To enter</span>;
  }
  return <Money amount={bill.amountKes} currency="KES" />;
}

function BillDetail({ bill }: { bill: Bill }): JSX.Element {
  return (
    <>
      {bill.status === "payout_failed" ? (
        <Callout tone="error" title="Payment failed">
          <p>The paybill didn’t accept the account number.</p>
        </Callout>
      ) : null}
      {bill.payee.method === null ? (
        <Callout tone="warn">
          <p>
            Add {bill.payee.name}’s payment details before paying this bill.
          </p>
        </Callout>
      ) : null}
      <DetailList>
        <DetailItem label="Due">{dateText(bill.dueOn)}</DetailItem>
        {bill.recurringItemId ? (
          <DetailItem
            label="Schedule"
            sub={<TextLinkButton>See recurring payment</TextLinkButton>}
          >
            Monthly, on the 1st
          </DetailItem>
        ) : null}
        <DetailItem label="Paid by">
          {bill.payee.method ? METHODS[bill.payee.method] : "Not set"}
        </DetailItem>
        <DetailItem label="Overview heading">
          {bill.overviewHeading === "subscriptions"
            ? "Subscriptions"
            : "Transactions"}
        </DetailItem>
        <DetailItem label="Category">{bill.category.name}</DetailItem>
        {bill.reference ? (
          <DetailItem label="Reference">{bill.reference}</DetailItem>
        ) : null}
      </DetailList>
      {bill.notes ? (
        <p className="whitespace-pre-wrap text-gray-700">{bill.notes}</p>
      ) : null}
      <SectionLabel>File</SectionLabel>
      <div className="flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-control border border-dashed border-control-border p-6 text-center text-gray-600">
        <BanIcon aria-hidden="true" className="size-6 text-gray-500" />
        <p>No receipt attached.</p>
      </div>
    </>
  );
}

function StackedDemo(): JSX.Element {
  const [method, setMethod] = useState<string | null>("bank");
  const [source, setSource] = useState<string | null>("recurring");
  return (
    <ResultsPanel label="Stacked filters">
      <ResultsHead
        stacked
        tabs={
          <KindTabs
            label="Kind"
            value="all"
            onChange={() => undefined}
            tabs={[
              { value: "all", label: "All", count: 42 },
              { value: "reimbursement", label: "Reimbursements", count: 18 },
              { value: "petty", label: "Petty cash", count: 9 },
              { value: "company", label: "Company spending", count: 15 },
            ]}
          />
        }
        chips={
          <>
            <FilterChip
              label="Status"
              icon={ClockIcon}
              options={STATUS_OPTIONS}
              value={null}
              onChange={() => undefined}
              anyLabel="Any status"
            />
            <FilterChip
              label="Payee"
              icon={Building2Icon}
              options={PAYEE_OPTIONS}
              value={PAYEE_OPTIONS[2]?.value ?? null}
              onChange={() => undefined}
              anyLabel="Every payee"
            />
            <FilterChip
              label="Category"
              icon={TagIcon}
              options={CATEGORY_OPTIONS}
              value={null}
              onChange={() => undefined}
              anyLabel="All categories"
            />
            <FilterChip
              label="Heading"
              icon={LayersIcon}
              options={[
                { value: "transactions", label: "Transactions" },
                { value: "subscriptions", label: "Subscriptions" },
              ]}
              value={null}
              onChange={() => undefined}
              anyLabel="Every heading"
            />
            <FilterChip
              label="Paid by"
              icon={WalletIcon}
              options={Object.entries(METHODS).map(([value, label]) => ({
                value,
                label,
              }))}
              value={method}
              onChange={setMethod}
              anyLabel="Any method"
            />
            <FilterChip
              label="Source"
              icon={RepeatIcon}
              options={[
                { value: "recurring", label: "Recurring" },
                { value: "one_off", label: "One-off" },
              ]}
              value={source}
              onChange={setSource}
              anyLabel="Any source"
            />
          </>
        }
        onClearAll={() => {
          setMethod(null);
          setSource(null);
        }}
      />
      <EmptyState
        title="Nothing to pay"
        action={
          <Button variant="outline" size="md">
            Clear all
          </Button>
        }
      >
        New bills and recurring payments show up here.
      </EmptyState>
    </ResultsPanel>
  );
}

function AtomsDemo(): JSX.Element {
  const tones: readonly [StatusTone, string][] = [
    ["waiting", "Due today"],
    ["moving", "Being paid"],
    ["paid", "Paid"],
    ["failed", "Payment failed"],
    ["rejected", "Cancelled"],
    ["quiet", "Upcoming"],
    ["overdue", "Overdue"],
  ];
  return (
    <div className="mt-4 flex flex-col gap-5 rounded-panel border border-gray-200 bg-surface p-5 shadow-panel">
      <div className="flex flex-wrap items-center gap-2">
        {tones.map(([tone, label]) => (
          <StatusBadge key={tone} tone={tone}>
            {label}
          </StatusBadge>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button>
          <KeyRoundIcon aria-hidden="true" />
          Pay
        </Button>
        <Button size="md">Primary 36</Button>
        <Button variant="outline">Outline 44</Button>
        <Button variant="outline" size="md">
          Outline 36
        </Button>
        <Button variant="ghost" size="md">
          Ghost
        </Button>
        <Button variant="danger" size="md">
          Cancel bill
        </Button>
        <Button size="md" disabled>
          Disabled
        </Button>
        <IconButton label="Close">
          <XIcon aria-hidden="true" />
        </IconButton>
        <TextLinkButton>Select all payable</TextLinkButton>
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <Mini icon={RepeatIcon} label="Recurring" />
        <Mini icon={PaperclipIcon} label="2 files">
          2
        </Mini>
        <Mini icon={TriangleAlertIcon} label="No receipt" warn>
          No receipt
        </Mini>
        <EntityMark name="Kilimani Properties" />
        <EntityMark name="Wanjiru Kamau" kind="person" />
        <RowCheckbox aria-label="Unchecked" />
        <RowCheckbox aria-label="Checked" defaultChecked />
        <RowCheckbox aria-label="Disabled" disabled />
      </div>
      <div className="flex flex-wrap items-center gap-6 text-base">
        <Money amount="4850000" currency="KES" />
        <Money amount="699950" currency="KES" />
        <Money amount="45000000" currency="USD" />
        <Money amount="16420800000" currency="USDC" />
        <KesTotal
          total={approxKesTotal({ kes: "8050000", usd: "0", rate: null })}
        />
        <KesTotal
          total={approxKesTotal({
            kes: "8050000",
            usd: "45000000",
            rate: KES_RATE,
          })}
        />
        <KesTotal
          total={approxKesTotal({ kes: "100", usd: "45000000", rate: null })}
        />
      </div>
      <div className="flex flex-wrap gap-3">
        <Callout tone="warn">
          <p>Add a payment method for CarMax Mechanics before paying.</p>
        </Callout>
        <Callout tone="error" title="Payment failed">
          <p>The paybill didn’t accept the account number.</p>
        </Callout>
        <Callout tone="neutral" icon={BanIcon}>
          <p>Cancelled by Wanjiru Kamau: subscription cancelled.</p>
        </Callout>
      </div>
    </div>
  );
}

function FormDemo(): JSX.Element {
  return (
    <div className="mt-4 max-w-[560px] rounded-panel border border-gray-200 bg-surface p-6 shadow-panel">
      <FieldGroup className="gap-[18px]">
        <Field>
          <FieldLabel htmlFor="kit-payee">Payee</FieldLabel>
          <NativeSelect id="kit-payee" className="w-full" defaultValue="kp">
            {PAYEE_OPTIONS.map((option) => (
              <NativeSelectOption key={option.value} value={option.value}>
                {option.label}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </Field>
        <div className="grid grid-cols-2 gap-4 max-[600px]:grid-cols-1">
          <Field data-invalid>
            <FieldLabel htmlFor="kit-amount">Amount (KES)</FieldLabel>
            <Input
              id="kit-amount"
              inputMode="decimal"
              aria-invalid
              defaultValue="48,5OO"
            />
            <FieldError>Enter the amount in numbers, e.g. 48500.</FieldError>
          </Field>
          <Field>
            <FieldLabel htmlFor="kit-due">Due date</FieldLabel>
            <Input id="kit-due" type="date" defaultValue="2026-11-30" />
          </Field>
        </div>
        <Field>
          <FieldLabel htmlFor="kit-ref">Reference</FieldLabel>
          <Input id="kit-ref" placeholder="e.g. INV-2026-1101" />
          <FieldDescription>
            The supplier’s invoice number, if any.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="kit-notes">Notes</FieldLabel>
          <Textarea
            id="kit-notes"
            placeholder="Anything the accountant should know"
          />
        </Field>
        <label className="flex cursor-pointer items-start gap-2.5">
          <RowCheckbox className="mt-px" defaultChecked />
          <span>
            <span className="block text-sm font-(--w-ui) text-gray-900">
              Remind me before it’s due
            </span>
            <span className="block text-xs leading-4 text-gray-500">
              Three days before, by email.
            </span>
          </span>
        </label>
      </FieldGroup>
    </div>
  );
}
