import type { QueryClient } from "@tanstack/react-query";

import type {
  CategoriesResponse,
  Claim,
  ClaimDetail,
  ClaimReceipt,
  ClaimsSummary,
  EtimsStatus,
  Expense,
  ExpenseDetail,
  ExpenseKind,
  ExpenseListKind,
  ExpenseReceipt,
  ExpenseSortKey,
  ExpensesSummary,
  ExpenseStatus,
  ExpenseSummaryQuery,
  ExpenseWarning,
} from "@expendi-business/shared";
import {
  EXPENSE_LIST_KINDS,
  EXPENSE_SORT_KEYS,
} from "@expendi-business/shared";

import { toApiQuery } from "~/app/(company)/expenses/_components/expense-filters";
import { EXPENSES_PAGE_SIZE } from "~/app/(company)/expenses/_components/expenses-view";
import { navCountKeys } from "~/hooks/use-nav-counts";
import { queryKeys } from "~/lib/query-keys";
import { ORGANIZATION_ID, sampleId } from "./company";
import { MEMBERS } from "./team";

/**
 * The sample data of docs/mocks/expenses.html and docs/mocks/approvals.html:
 * Mwangaza Logistics' reimbursements, petty cash and company spending.
 * Receipts are drawn as SVG "paper", as the mocks draw them.
 */

const PEOPLE = {
  bo: person("Brian Otieno", "brian@mwangaza.co.ke", 501),
  fw: person("Faith Wambui", "faith@mwangaza.co.ke", 502),
  km: person("Kevin Mwangi", "kevin@mwangaza.co.ke", 503),
  ga: person("Grace Achieng", "grace@mwangaza.co.ke", 504),
  dk: person("Daniel Kiprop", "daniel@mwangaza.co.ke", 505),
  pn: person("Peter Njoroge", "peter@mwangaza.co.ke", 506),
  ah: person("Amina Hassan", "amina@mwangaza.co.ke", 507),
  wk: person("Wanjiru Kamau", "wanjiru@mwangaza.co.ke", 508),
} as const;
type PersonKey = keyof typeof PEOPLE;

/** The team page's membership ids, so the Person filter finds them. */
function person(name: string, email: string, fallback: number) {
  const member = MEMBERS.find((m) => m.email === email);
  return { membershipId: member?.id ?? sampleId(fallback), name, email };
}

const CATEGORY_LIST = [
  { key: "airtime", name: "Airtime & internet" },
  { key: "equipment", name: "Equipment" },
  { key: "fuel", name: "Fuel & transport" },
  { key: "meals", name: "Meals & entertainment" },
  { key: "office", name: "Office & supplies" },
  { key: "rent", name: "Rent & utilities" },
  { key: "repairs", name: "Repairs & maintenance" },
] as const;
type CategoryKey = (typeof CATEGORY_LIST)[number]["key"];

const CATEGORY = Object.fromEntries(
  CATEGORY_LIST.map(({ key, name }, at) => [
    key,
    { id: sampleId(601 + at), name },
  ]),
) as Record<CategoryKey, { id: string; name: string }>;

export const EXPENSE_CATEGORIES: CategoriesResponse = CATEGORY_LIST.map(
  ({ key, name }) => ({
    id: CATEGORY[key].id,
    name,
    etimsNotRequired: false,
  }),
);

interface Paper {
  heading: string;
  label: string;
  sub: string;
  /** Label and whole or decimal shillings. */
  lines: readonly (readonly [string, number])[];
}

type SampleReceipt =
  | { kind: "photo" | "screenshot" | "pdf"; paper: Paper }
  | { kind: "sms_text"; text: string };

const escapeXml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const shillings = (amount: number) =>
  amount.toLocaleString("en-KE", {
    minimumFractionDigits: amount % 1 ? 2 : 0,
    maximumFractionDigits: 2,
  });

/** A receipt drawn like the mocks' paper: heading, lines and a total. */
function receiptImage(paper: Paper, look: "paper" | "screen" | "pdf"): string {
  const width = 300;
  const top = 12;
  const bodyTop = top + 66;
  const height = bodyTop + paper.lines.length * 18 + 52;
  const total = paper.lines.reduce((sum, [, amount]) => sum + amount, 0);
  const text = (x: number, y: number, value: string, attrs = "") =>
    `<text x="${String(x)}" y="${String(y)}" ${attrs}>${escapeXml(value)}</text>`;
  const lines = paper.lines
    .map(
      ([label, amount], at) =>
        text(28, bodyTop + at * 18, label, 'fill="#475467"') +
        text(
          272,
          bodyTop + at * 18,
          shillings(amount),
          'fill="#475467" text-anchor="end"',
        ),
    )
    .join("");
  const totalY = bodyTop + paper.lines.length * 18 + 16;
  const rotate =
    look === "paper" ? `rotate(-0.6 150 ${String(height / 2)})` : "";
  const radius = look === "screen" ? 16 : look === "pdf" ? 2 : 4;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height + 16)}" viewBox="0 0 ${String(width)} ${String(height + 16)}" font-family="Outfit, ui-sans-serif, system-ui, sans-serif" font-size="12"><defs><filter id="s" x="-10%" y="-10%" width="120%" height="130%"><feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#101828" flood-opacity="0.12"/></filter></defs><g transform="${rotate}"><rect x="10" y="${String(top)}" width="280" height="${String(height - top)}" rx="${String(radius)}" fill="#fff" stroke="#e4e7ec" filter="url(#s)"/>${text(28, top + 26, paper.heading, 'font-size="13" font-weight="600" fill="#101828"')}${text(272, top + 26, paper.label, 'font-size="11" font-weight="500" fill="#667085" text-anchor="end" letter-spacing="0.6"')}${text(28, top + 44, paper.sub, 'fill="#667085"')}${lines}<line x1="28" x2="272" y1="${String(totalY - 14)}" y2="${String(totalY - 14)}" stroke="#d0d5dd" stroke-dasharray="3 3"/>${text(28, totalY, "Total", 'font-weight="600" fill="#101828"')}${text(272, totalY, `KES ${shillings(total)}`, 'font-weight="600" fill="#101828" text-anchor="end"')}</g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

let receiptNumber = 0;
function receiptOf(sample: SampleReceipt): ExpenseReceipt {
  receiptNumber += 1;
  const id = sampleId(9000 + receiptNumber);
  if (sample.kind === "sms_text") {
    return { id, kind: "sms_text", billRole: null, text: sample.text };
  }
  const look =
    sample.kind === "screenshot"
      ? "screen"
      : sample.kind === "pdf"
        ? "pdf"
        : "paper";
  return {
    id,
    kind: sample.kind,
    billRole: null,
    contentType: sample.kind === "pdf" ? "application/pdf" : "image/svg+xml",
    url: receiptImage(sample.paper, look),
    expiresAt: "2026-11-06T10:15:00.000Z",
  };
}

const photo = (
  heading: string,
  label: string,
  sub: string,
  lines: Paper["lines"],
): SampleReceipt => ({ kind: "photo", paper: { heading, label, sub, lines } });

interface SampleExpense {
  n: number;
  spentOn: string;
  merchant: string;
  listKind: ExpenseListKind;
  kind: ExpenseKind;
  category: CategoryKey;
  /** KES cents. */
  amount: number;
  person: PersonKey;
  status: ExpenseStatus;
  etims: EtimsStatus;
  invoice?: string;
  supplierPin?: string;
  mpesa?: string;
  description?: string;
  noReceiptReason?: string;
  rejectedReason?: string;
  receipts: readonly SampleReceipt[];
  warnings?: readonly ExpenseWarning[];
  paidAt?: string;
  selfApproved?: boolean;
  fromFloat?: boolean;
  paidFrom?: string;
  source?: "app" | "import";
}

const uber = (sub: string, trip: string, amount: number): SampleReceipt => ({
  kind: "screenshot",
  paper: { heading: "Uber", label: "TRIP", sub, lines: [[trip, amount]] },
});

const HANDPICKED: readonly SampleExpense[] = [
  {
    n: 1,
    spentOn: "2026-11-05",
    merchant: "Matatu fares",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 145000,
    person: "fw",
    status: "submitted",
    etims: "not_required",
    description: "Site visits to the Embakasi warehouse.",
    receipts: [],
  },
  {
    n: 2,
    spentOn: "2026-11-05",
    merchant: "Uber",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 128000,
    person: "ah",
    status: "submitted",
    etims: "not_required",
    description: "Client meeting at Upper Hill.",
    receipts: [uber("5 Nov 2026, 10:05", "Westlands to Upper Hill", 1280)],
  },
  {
    n: 3,
    spentOn: "2026-11-04",
    merchant: "Java House Westlands",
    listKind: "claim",
    kind: "claim",
    category: "meals",
    amount: 320000,
    person: "bo",
    status: "submitted",
    etims: "attached",
    invoice: "0040812345",
    supplierPin: "P051238822K",
    mpesa: "SK41H7QZ2P",
    description: "Lunch with the Twiga Foods procurement team.",
    receipts: [
      photo("Java House Westlands", "RECEIPT", "4 Nov 2026, 13:42", [
        ["2 × Chicken wrap", 1900],
        ["2 × Fresh juice", 700],
        ["Service", 600],
      ]),
    ],
  },
  {
    n: 4,
    spentOn: "2026-11-03",
    merchant: "Rubis Westlands",
    listKind: "petty_cash",
    kind: "float",
    category: "fuel",
    amount: 485000,
    person: "km",
    status: "recorded",
    etims: "none",
    description: "Fuel for the delivery van KDM 412T.",
    receipts: [],
  },
  {
    n: 5,
    spentOn: "2026-11-02",
    merchant: "Rubis Westlands",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 500000,
    person: "km",
    status: "submitted",
    etims: "none",
    mpesa: "SK29J4LMN7",
    warnings: [
      {
        code: "near_duplicate",
        expenseId: sampleId(799),
        amountKes: "500000",
        spentOn: "2026-10-30",
      },
    ],
    receipts: [
      {
        kind: "sms_text",
        text: "SK29J4LMN7 Confirmed. Ksh5,000.00 paid to RUBIS WESTLANDS on 2/11/26 at 7:42 AM. New M-PESA balance is Ksh3,214.50. Transaction cost, Ksh0.00.",
      },
    ],
  },
  {
    n: 6,
    spentOn: "2026-11-02",
    merchant: "Naivas Sarit",
    listKind: "petty_cash",
    kind: "float",
    category: "office",
    amount: 230000,
    person: "ga",
    status: "recorded",
    etims: "none",
    mpesa: "SK22B9TT4M",
    receipts: [
      photo("Naivas Sarit Centre", "RECEIPT", "2 Nov 2026, 10:15", [
        ["Printing paper A4 × 2", 1300],
        ["Cleaning supplies", 1000],
      ]),
    ],
  },
  {
    n: 7,
    spentOn: "2026-11-01",
    merchant: "Bolt",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 64000,
    person: "ah",
    status: "paying",
    etims: "not_required",
    receipts: [
      {
        kind: "screenshot",
        paper: {
          heading: "Bolt",
          label: "TRIP",
          sub: "1 Nov 2026, 18:30",
          lines: [["Upper Hill to Westlands", 640]],
        },
      },
    ],
  },
  {
    n: 8,
    spentOn: "2026-10-31",
    merchant: "Uber",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 118000,
    person: "wk",
    status: "paid",
    paidAt: "2026-10-31",
    selfApproved: true,
    etims: "not_required",
    receipts: [uber("31 Oct 2026, 08:10", "Kilimani to JKIA", 1180)],
  },
  {
    n: 9,
    spentOn: "2026-10-30",
    merchant: "Naivas Kilimani",
    listKind: "claim",
    kind: "claim",
    category: "office",
    amount: 395000,
    person: "pn",
    status: "payout_failed",
    etims: "attached",
    invoice: "0040819937",
    mpesa: "SK10M3NB7T",
    description: "Cleaning supplies for the office.",
    receipts: [
      photo("Naivas Kilimani", "RECEIPT", "30 Oct 2026, 17:20", [
        ["Cleaning supplies", 3950],
      ]),
    ],
  },
  {
    n: 10,
    spentOn: "2026-10-28",
    merchant: "Total Energies Ngong Rd",
    listKind: "claim",
    kind: "claim",
    category: "fuel",
    amount: 450000,
    person: "dk",
    status: "paid",
    paidAt: "2026-10-29",
    etims: "attached",
    invoice: "0040801177",
    supplierPin: "P051099812Q",
    mpesa: "SJ88QW1E2R",
    receipts: [
      photo("TotalEnergies Ngong Road", "FUEL SALE", "28 Oct 2026, 06:40", [
        ["Diesel 25 L", 4500],
      ]),
    ],
  },
  {
    n: 11,
    spentOn: "2026-10-27",
    merchant: "Quickmart Kilimani",
    listKind: "petty_cash",
    kind: "claim",
    fromFloat: true,
    category: "office",
    amount: 120000,
    person: "ga",
    status: "paid",
    paidAt: "2026-10-28",
    etims: "none",
    description: "Tea and sugar for the office. The float had run out.",
    receipts: [
      photo("Quickmart Kilimani", "RECEIPT", "27 Oct 2026, 09:05", [
        ["Tea leaves 500 g", 450],
        ["Sugar 2 kg", 750],
      ]),
    ],
  },
  {
    n: 12,
    spentOn: "2026-10-25",
    merchant: "Artcaffe Westgate",
    listKind: "claim",
    kind: "claim",
    category: "meals",
    amount: 236000,
    person: "pn",
    status: "rejected",
    etims: "none",
    rejectedReason:
      "This was a team lunch, not a client meeting. Team lunches aren't reimbursed.",
    receipts: [
      photo("Artcaffe Westgate", "RECEIPT", "25 Oct 2026, 13:15", [
        ["Lunch × 4", 2360],
      ]),
    ],
  },
  {
    n: 13,
    spentOn: "2026-10-22",
    merchant: "Total Kenya fuel card",
    listKind: "company",
    kind: "company",
    category: "fuel",
    amount: 2000000,
    person: "wk",
    status: "recorded",
    etims: "attached",
    invoice: "0040799021",
    paidFrom: "KCB current account ••7781",
    receipts: [
      {
        kind: "pdf",
        paper: {
          heading: "TotalEnergies Kenya",
          label: "TAX INVOICE",
          sub: "Card top-up, 22 Oct 2026",
          lines: [["Fleet card top-up", 20000]],
        },
      },
    ],
  },
  {
    n: 14,
    spentOn: "2026-10-18",
    merchant: "Nairobi County parking",
    listKind: "company",
    kind: "company",
    category: "fuel",
    amount: 120000,
    person: "wk",
    status: "recorded",
    etims: "not_required",
    paidFrom: "Company M-Pesa till",
    noReceiptReason: "Paid on eCitizen and the receipt email was lost.",
    receipts: [],
  },
  {
    n: 16,
    spentOn: "2026-08-10",
    merchant: "Spin & Shine car wash",
    listKind: "petty_cash",
    kind: "float",
    category: "repairs",
    amount: 80000,
    person: "km",
    status: "recorded",
    etims: "none",
    warnings: [
      { code: "older_than_60_days", spentOn: "2026-08-10", ageDays: 85 },
    ],
    receipts: [
      photo("Spin & Shine", "RECEIPT", "10 Aug 2026", [["Van wash", 800]]),
    ],
  },
  {
    n: 17,
    spentOn: "2026-09-12",
    merchant: "Hotpoint Appliances",
    listKind: "company",
    kind: "company",
    category: "equipment",
    amount: 5499900,
    person: "wk",
    status: "paid_outside",
    source: "import",
    etims: "attached",
    invoice: "0040733018",
    paidFrom: "Equity Bank ••4521",
    description: "Fridge for the staff kitchen.",
    noReceiptReason: "Imported from the old spreadsheet without receipts.",
    receipts: [],
  },
];

const DATE_FORMAT = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** The mock's 40 older expenses that fill the list past one page. */
function filler(): SampleExpense[] {
  const spends: readonly (readonly [
    string,
    CategoryKey,
    number,
    ExpenseListKind,
  ])[] = [
    ["Total Energies Ngong Rd", "fuel", 450000, "claim"],
    ["Artcaffe Westgate", "meals", 186000, "claim"],
    ["Safaricom airtime", "airtime", 100000, "petty_cash"],
    ["Bolt", "fuel", 52000, "claim"],
    ["Carrefour Junction", "office", 187500, "petty_cash"],
    ["JKIA parking", "fuel", 30000, "claim"],
    ["Kenya Power tokens", "rent", 500000, "company"],
    ["Text Book Centre Sarit", "office", 142000, "petty_cash"],
    ["CarMax Mechanics", "repairs", 1250000, "company"],
    ["Java House Junction", "meals", 87000, "claim"],
  ];
  const owners: readonly PersonKey[] = [
    "bo",
    "fw",
    "km",
    "ga",
    "dk",
    "pn",
    "ah",
  ];
  const etims: readonly EtimsStatus[] = [
    "attached",
    "none",
    "not_required",
    "attached",
  ];
  return Array.from({ length: 40 }, (_, i) => i).flatMap((i) => {
    const spend = spends[i % spends.length];
    if (!spend) return [];
    const [merchant, category, base, listKind] = spend;
    const day = String(26 - Math.floor(i * 0.6)).padStart(2, "0");
    const spentOn = `2026-10-${day}`;
    const amount = base + (i % 3) * 5000;
    const status: ExpenseStatus = listKind === "claim" ? "paid" : "recorded";
    const etimsStatus = etims[i % etims.length] ?? "none";
    const sample: SampleExpense = {
      n: 100 + i,
      spentOn,
      merchant,
      listKind,
      kind:
        listKind === "petty_cash"
          ? "float"
          : listKind === "company"
            ? "company"
            : "claim",
      category,
      amount,
      person:
        listKind === "company" ? "wk" : (owners[i % owners.length] ?? "bo"),
      status,
      paidAt: listKind === "claim" ? spentOn : undefined,
      etims: etimsStatus,
      invoice:
        etimsStatus === "attached"
          ? `00407${String(61000 + i * 37)}`
          : undefined,
      mpesa:
        listKind === "company"
          ? undefined
          : `SJ${(48213 + i * 97).toString(36).toUpperCase()}Q`,
      paidFrom:
        listKind === "company" ? "KCB current account ••7781" : undefined,
      receipts: [
        photo(
          merchant,
          "RECEIPT",
          DATE_FORMAT.format(new Date(`${spentOn}T00:00:00Z`)),
          [["Total", amount / 100]],
        ),
      ],
    };
    return [sample];
  });
}

interface SampleRow {
  expense: Expense;
  receipts: ExpenseReceipt[];
}

/** The mock lists the same day's expenses by number: a lower one was recorded later. */
function recordedAt(spentOn: string, n: number): string {
  return `${spentOn}T${String(20 - (n % 12)).padStart(2, "0")}:00:00.000Z`;
}

function toRow(sample: SampleExpense): SampleRow {
  const receipts = sample.receipts.map(receiptOf);
  const member = PEOPLE[sample.person];
  return {
    receipts,
    expense: {
      id: sampleId(700 + sample.n),
      kind: sample.kind,
      listKind: sample.listKind,
      status: sample.status,
      source: sample.source ?? "app",
      overviewHeading:
        sample.listKind === "petty_cash" ? "petty_cash" : "transactions",
      merchant: sample.merchant,
      amountKes: String(sample.amount),
      spentOn: sample.spentOn,
      description: sample.description ?? null,
      category: CATEGORY[sample.category],
      member,
      mpesaCode: sample.mpesa ?? null,
      etimsStatus: sample.etims,
      etimsInvoiceNumber: sample.invoice ?? null,
      etimsSupplierPin: sample.supplierPin ?? null,
      warnings: [...(sample.warnings ?? [])],
      receiptCount: receipts.length,
      noReceipt: receipts.length === 0,
      noReceiptReason: sample.noReceiptReason ?? null,
      rejectedReason: sample.rejectedReason ?? null,
      selfApproved: sample.selfApproved ?? false,
      approvedAt: sample.paidAt ? `${sample.paidAt}T08:00:00.000Z` : null,
      paidAt: sample.paidAt ? `${sample.paidAt}T09:00:00.000Z` : null,
      floatId:
        sample.kind === "float" || sample.fromFloat ? sampleId(690) : null,
      overspendClaimId: null,
      bill: null,
      paidFromAccount: sample.paidFrom
        ? { id: sampleId(680), name: sample.paidFrom }
        : null,
      createdAt: recordedAt(sample.spentOn, sample.n),
    },
  };
}

const ROWS: readonly SampleRow[] = [...HANDPICKED, ...filler()].map(toRow);
const EXPENSES = ROWS.map((row) => row.expense);

/** Payment failed first, then waiting, being paid, rejected, paid, paid before Expendi, recorded. */
const URGENCY: Record<ExpenseStatus, number> = {
  payout_failed: 0,
  submitted: 1,
  paying: 2,
  rejected: 3,
  paid: 4,
  paid_outside: 5,
  recorded: 6,
};

function compare(key: ExpenseSortKey, dir: "asc" | "desc") {
  return (a: Expense, b: Expense): number => {
    const byDate = a.spentOn.localeCompare(b.spentOn);
    const primary =
      key === "date"
        ? byDate
        : key === "person"
          ? (a.member.name ?? "").localeCompare(b.member.name ?? "")
          : key === "merchant"
            ? a.merchant.localeCompare(b.merchant)
            : key === "amount"
              ? Number(a.amountKes) - Number(b.amountKes)
              : URGENCY[a.status] - URGENCY[b.status];
    const tie =
      byDate ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id);
    return dir === "asc" ? primary || tie : -primary || -tie;
  };
}

function matching(query: ExpenseSummaryQuery): Expense[] {
  return EXPENSES.filter(
    (expense) =>
      (!query.kind || expense.listKind === query.kind) &&
      (!query.status || expense.status === query.status) &&
      (query.noReceipt === undefined ||
        expense.noReceipt === (query.noReceipt === "true")),
  );
}

function totals(expenses: readonly Expense[]) {
  return {
    count: expenses.length,
    totalKes: String(
      expenses.reduce((sum, expense) => sum + Number(expense.amountKes), 0),
    ),
  };
}

function summaryOf(query: ExpenseSummaryQuery): ExpensesSummary {
  const shown = matching(query);
  const everyKind = matching({ ...query, kind: undefined });
  return {
    ...totals(shown),
    waitingForApproval: totals(shown.filter((e) => e.status === "submitted")),
    withoutReceipt: totals(shown.filter((e) => e.noReceipt)),
    withoutEtims: totals(shown.filter((e) => e.etimsStatus === "none")),
    kinds: {
      claim: everyKind.filter((e) => e.listKind === "claim").length,
      petty_cash: everyKind.filter((e) => e.listKind === "petty_cash").length,
      company: everyKind.filter((e) => e.listKind === "company").length,
    },
  };
}

/* Approvals: the waiting queue and the failed payment of approvals.html. */

interface SampleClaim {
  n: number;
  merchant: string;
  person: PersonKey;
  spentOn: string;
  category: CategoryKey;
  amount: number;
  description: string;
  mpesa: string | null;
  etims: EtimsStatus;
  invoice?: string;
  receipts: readonly SampleReceipt[];
  warnings?: readonly ExpenseWarning[];
  phoneConfirmed?: boolean;
  failure?: string;
}

const WAITING: readonly SampleClaim[] = [
  {
    n: 3,
    merchant: "Java House Westlands",
    person: "bo",
    spentOn: "2026-11-04",
    category: "meals",
    amount: 320000,
    description: "Lunch with the Twiga Foods procurement team.",
    mpesa: "SK41H7QZ2P",
    etims: "attached",
    invoice: "0040812345",
    receipts: [
      photo("Java House Westlands", "RECEIPT", "4 Nov 2026, 13:42", [
        ["2 × Chicken wrap", 1900],
        ["2 × Fresh juice", 700],
        ["Service", 600],
      ]),
    ],
  },
  {
    n: 1,
    merchant: "Matatu fares",
    person: "fw",
    spentOn: "2026-11-05",
    category: "fuel",
    amount: 145000,
    description:
      "Site visits to the Embakasi warehouse: CBD to Industrial Area, on to Embakasi, and back.",
    mpesa: null,
    etims: "not_required",
    receipts: [],
  },
  {
    n: 5,
    merchant: "Rubis Westlands",
    person: "km",
    spentOn: "2026-11-02",
    category: "fuel",
    amount: 500000,
    description: "Fuel for the delivery van KDM 412T.",
    mpesa: "SK29J4LMN7",
    etims: "none",
    warnings: [
      {
        code: "near_duplicate",
        expenseId: sampleId(799),
        amountKes: "500000",
        spentOn: "2026-10-30",
      },
    ],
    receipts: [
      {
        kind: "sms_text",
        text: "SK29J4LMN7 Confirmed. Ksh5,000.00 paid to RUBIS WESTLANDS on 2/11/26 at 7:42 AM. New M-PESA balance is Ksh3,214.50. Transaction cost, Ksh0.00.",
      },
    ],
  },
  {
    n: 51,
    merchant: "Text Book Centre Sarit",
    person: "ga",
    spentOn: "2026-11-03",
    category: "office",
    amount: 273950,
    description: "Printer toner and two box files.",
    mpesa: "SK37P2DD8W",
    etims: "attached",
    invoice: "0040834512",
    receipts: [
      photo(
        "Text Book Centre Ltd",
        "TAX INVOICE",
        "TBC-SAR-88214, 3 Nov 2026",
        [
          ["HP 305 toner", 2189.5],
          ["Box file × 2", 550],
        ],
      ),
    ],
  },
  {
    n: 52,
    merchant: "Shell Mombasa Road",
    person: "dk",
    spentOn: "2026-08-12",
    category: "fuel",
    amount: 680000,
    description: "Fuel for the Mombasa delivery run.",
    mpesa: "SH81QW3E5R",
    etims: "none",
    warnings: [
      { code: "older_than_60_days", spentOn: "2026-08-12", ageDays: 83 },
    ],
    receipts: [
      photo("Shell Mombasa Road", "FUEL SALE", "12 Aug 2026, 06:15", [
        ["Diesel 37.8 L", 6800],
      ]),
    ],
  },
  {
    n: 2,
    merchant: "Uber",
    person: "ah",
    spentOn: "2026-11-05",
    category: "fuel",
    amount: 128000,
    description: "Client meeting at Upper Hill.",
    mpesa: null,
    etims: "not_required",
    phoneConfirmed: false,
    receipts: [uber("5 Nov 2026, 10:05", "Westlands to Upper Hill", 1280)],
  },
];

const FAILED: readonly SampleClaim[] = [
  {
    n: 9,
    merchant: "Naivas Kilimani",
    person: "pn",
    spentOn: "2026-10-30",
    category: "office",
    amount: 395000,
    description: "Cleaning supplies for the office.",
    mpesa: "SK10M3NB7T",
    etims: "attached",
    invoice: "0040819937",
    failure: "The M-Pesa number didn't accept the payment.",
    receipts: [
      photo("Naivas Kilimani", "RECEIPT", "30 Oct 2026, 17:20", [
        ["Cleaning supplies", 3950],
      ]),
    ],
  },
];

function toClaim(sample: SampleClaim, status: ExpenseStatus): ClaimDetail {
  const member = PEOPLE[sample.person];
  const receipts = sample.receipts
    .map(receiptOf)
    .flatMap((receipt): ClaimReceipt[] =>
      receipt.kind === "sms_text"
        ? [{ id: receipt.id, kind: "sms_text", text: receipt.text }]
        : receipt.kind === "pdf"
          ? []
          : [
              {
                id: receipt.id,
                kind: receipt.kind,
                contentType: receipt.contentType,
                url: receipt.url,
                expiresAt: receipt.expiresAt,
              },
            ],
    );
  return {
    id: sampleId(700 + sample.n),
    status,
    merchant: sample.merchant,
    amountKes: String(sample.amount),
    spentOn: sample.spentOn,
    description: sample.description,
    category: CATEGORY[sample.category],
    mpesaCode: sample.mpesa,
    etimsInvoiceNumber: sample.invoice ?? null,
    etimsSupplierPin: null,
    etimsQrPayload: null,
    etimsStatus: sample.etims,
    rejectedReason: null,
    floatId: null,
    submittedBy: {
      membershipId: member.membershipId,
      name: member.name,
      email: member.email,
      payoutPhoneConfirmed: sample.phoneConfirmed ?? true,
    },
    approvedAt: status === "payout_failed" ? "2026-10-31T08:00:00.000Z" : null,
    selfApproved: false,
    paidAt: null,
    canEdit: false,
    warnings: [...(sample.warnings ?? [])],
    receiptCount: receipts.length,
    createdAt: `${sample.spentOn}T09:00:00.000Z`,
    updatedAt: `${sample.spentOn}T09:00:00.000Z`,
    receipts,
    payout: sample.failure
      ? {
          id: sampleId(670 + sample.n),
          status: "failed",
          failureReason: sample.failure,
        }
      : null,
  };
}

const WAITING_CLAIMS = WAITING.map((sample) => toClaim(sample, "submitted"));
const FAILED_CLAIMS = FAILED.map((sample) => toClaim(sample, "payout_failed"));

const listed = ({
  receipts: _receipts,
  payout: _payout,
  ...claim
}: ClaimDetail): Claim => claim;

const claimTotals = (claims: readonly Claim[]) => ({
  count: claims.length,
  totalKes: String(
    claims.reduce((sum, claim) => sum + Number(claim.amountKes), 0),
  ),
});

export const CLAIMS_SUMMARY: ClaimsSummary = {
  waiting: claimTotals(WAITING_CLAIMS),
  payoutFailed: claimTotals(FAILED_CLAIMS),
};

/** Every read Expenses, Approvals and the Expenses badge make. */
export function seedExpensesAndApprovals(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(queryKeys.categories(org), EXPENSE_CATEGORIES);
  for (const kind of [undefined, ...EXPENSE_LIST_KINDS]) {
    const query = toApiQuery({ kind });
    client.setQueryData(queryKeys.expenseSummary(org, query), summaryOf(query));
    for (const sort of EXPENSE_SORT_KEYS) {
      for (const dir of ["asc", "desc"] as const) {
        const rows = matching(query).sort(compare(sort, dir));
        client.setQueryData(
          queryKeys.expenseList(org, {
            ...query,
            sort,
            dir,
            limit: EXPENSES_PAGE_SIZE,
          }),
          {
            pages: [
              {
                expenses: rows.slice(0, EXPENSES_PAGE_SIZE),
                nextCursor:
                  rows.length > EXPENSES_PAGE_SIZE ? "preview-page-2" : null,
              },
            ],
            pageParams: [null],
          },
        );
      }
    }
  }
  for (const row of ROWS) {
    const detail: ExpenseDetail = { ...row.expense, receipts: row.receipts };
    client.setQueryData(queryKeys.expense(org, row.expense.id), detail);
  }
  client.setQueryData(
    navCountKeys.pettyCashSummary(org),
    summaryOf({ kind: "petty_cash", status: "recorded" }),
  );
  client.setQueryData(
    navCountKeys.pettyCashWithReceiptSummary(org),
    summaryOf({ kind: "petty_cash", status: "recorded", noReceipt: "false" }),
  );

  for (const [status, claims] of [
    ["submitted", WAITING_CLAIMS],
    ["payout_failed", FAILED_CLAIMS],
  ] as const) {
    client.setQueryData(queryKeys.claimQueue(org, status), {
      pages: [{ claims: claims.map(listed), nextCursor: null }],
      pageParams: [null],
    });
    for (const claim of claims) {
      client.setQueryData(queryKeys.claim(org, claim.id), claim);
    }
  }
}
