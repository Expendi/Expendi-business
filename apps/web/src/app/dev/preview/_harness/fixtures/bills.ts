import type { QueryClient, QueryKey } from "@tanstack/react-query";

import type {
  Bill,
  BillDetail,
  BillFile,
  BillListView,
  BillsSummary,
  BillStatus,
  PayeeKind,
  PayeeMethod,
  RecurringItem,
  RecurringItemState,
  RecurringSchedule,
  WalletResponse,
} from "@expendi-business/shared";
import {
  BILL_LIST_VIEW_STATUSES,
  BILL_LIST_VIEWS,
  OUTSTANDING_BILL_STATUSES,
  UNPAID_BILL_STATUSES,
} from "@expendi-business/shared";

import { settledOn } from "~/features/bills/bill-list";
import { billKeys, recurringKeys } from "~/features/payment-keys";
import { recurringListKey } from "~/features/recurring/recurring-api";
import { totalsByCurrency } from "~/lib/money";
import { KES_RATE, ORGANIZATION_ID, sampleId, VIEWER } from "./company";

/** The payees of docs/mocks/bills.html. */
const PAYEES = {
  kp: payee(101, "Kilimani Properties", "supplier", "mpesa_paybill"),
  sg: payee(102, "Securex Guards", "supplier", "mpesa_paybill"),
  sf: payee(103, "Safaricom", "vendor", "mpesa_paybill"),
  fg: payee(104, "Figma", "vendor", "usdc"),
  zk: payee(105, "Zuku", "vendor", "mpesa_paybill"),
  tf: payee(106, "Twiga Foods", "supplier", "mpesa_paybill"),
  kra: payee(107, "KRA", "statutory", "mpesa_paybill"),
  nw: payee(108, "Nairobi Water", "supplier", "mpesa_paybill"),
  bk: payee(109, "Bidco Kenya", "supplier", "bank"),
  kpl: payee(110, "Kenya Power", "supplier", "mpesa_paybill"),
  gw: payee(111, "Google Workspace", "vendor", "usdc"),
  jh: payee(112, "Jubilee Health", "supplier", "mpesa_paybill"),
  hp: payee(113, "Hotpoint Appliances", "supplier", "outside"),
  cm: payee(114, "CarMax Mechanics", "supplier", null),
  cv: payee(115, "Canva", "vendor", "usdc"),
} as const;

const CATEGORIES = {
  equipment: { id: sampleId(201), name: "Equipment" },
  insurance: { id: sampleId(202), name: "Insurance" },
  rent: { id: sampleId(203), name: "Rent & utilities" },
  repairs: { id: sampleId(204), name: "Repairs & maintenance" },
  security: { id: sampleId(205), name: "Security" },
  software: { id: sampleId(206), name: "Software" },
  suppliers: { id: sampleId(207), name: "Suppliers" },
  taxes: { id: sampleId(208), name: "Taxes" },
  airtime: { id: sampleId(209), name: "Airtime & internet" },
} as const;

interface SampleRecurring {
  n: number;
  payee: keyof typeof PAYEES;
  category: keyof typeof CATEGORIES;
  heading: "transactions" | "subscriptions";
  /** Whole shillings or dollars; null when variable. */
  amount: number | null;
  schedule: RecurringSchedule;
  scheduleDay: number;
  startsOn: string;
  endsOn?: string;
  reminderDays: number;
  state?: RecurringItemState;
  payVia?: "expendi" | "outside";
  /** The due date after the bill still owed; null once it has ended. */
  nextDueOn: string | null;
}

/** The recurring payments of docs/mocks/bills.html; salaries live in Payroll. */
const RECURRING_SAMPLES = {
  rent: {
    n: 301,
    payee: "kp",
    category: "rent",
    heading: "transactions",
    amount: 48500,
    schedule: "monthly",
    scheduleDay: 1,
    startsOn: "2025-01-01",
    endsOn: "2027-12-31",
    reminderDays: 5,
    nextDueOn: "2026-12-01",
  },
  guards: {
    n: 302,
    payee: "sg",
    category: "security",
    heading: "transactions",
    amount: 32000,
    schedule: "monthly",
    scheduleDay: 31,
    startsOn: "2026-01-31",
    reminderDays: 3,
    nextDueOn: "2026-11-30",
  },
  fibre: {
    n: 303,
    payee: "sf",
    category: "airtime",
    heading: "subscriptions",
    amount: 6999,
    schedule: "monthly",
    scheduleDay: 6,
    startsOn: "2025-08-06",
    reminderDays: 3,
    nextDueOn: "2026-12-06",
  },
  figma: {
    n: 304,
    payee: "fg",
    category: "software",
    heading: "subscriptions",
    amount: 45,
    schedule: "monthly",
    scheduleDay: 6,
    startsOn: "2026-02-06",
    reminderDays: 7,
    nextDueOn: "2026-12-06",
  },
  tv: {
    n: 305,
    payee: "zk",
    category: "airtime",
    heading: "subscriptions",
    amount: 4100,
    schedule: "monthly",
    scheduleDay: 4,
    startsOn: "2025-11-04",
    reminderDays: 3,
    nextDueOn: "2026-12-04",
  },
  twiga: {
    n: 306,
    payee: "tf",
    category: "suppliers",
    heading: "transactions",
    amount: null,
    schedule: "weekly",
    scheduleDay: 4,
    startsOn: "2026-06-04",
    reminderDays: 1,
    nextDueOn: "2026-11-12",
  },
  paye: {
    n: 307,
    payee: "kra",
    category: "taxes",
    heading: "transactions",
    amount: null,
    schedule: "monthly",
    scheduleDay: 9,
    startsOn: "2025-02-09",
    reminderDays: 5,
    nextDueOn: "2026-12-09",
  },
  water: {
    n: 308,
    payee: "nw",
    category: "rent",
    heading: "transactions",
    amount: 3850,
    schedule: "monthly",
    scheduleDay: 15,
    startsOn: "2025-03-15",
    reminderDays: 0,
    nextDueOn: "2026-12-15",
  },
  power: {
    n: 309,
    payee: "kpl",
    category: "rent",
    heading: "transactions",
    amount: null,
    schedule: "monthly",
    scheduleDay: 18,
    startsOn: "2026-04-18",
    reminderDays: 3,
    nextDueOn: "2026-12-18",
  },
  workspace: {
    n: 310,
    payee: "gw",
    category: "software",
    heading: "subscriptions",
    amount: 72,
    schedule: "monthly",
    scheduleDay: 1,
    startsOn: "2025-12-01",
    reminderDays: 1,
    nextDueOn: "2027-01-01",
  },
  health: {
    n: 311,
    payee: "jh",
    category: "insurance",
    heading: "transactions",
    amount: 64500,
    schedule: "monthly",
    scheduleDay: 1,
    startsOn: "2025-06-01",
    reminderDays: 5,
    state: "paused",
    nextDueOn: "2027-01-01",
  },
  service: {
    n: 313,
    payee: "cm",
    category: "repairs",
    heading: "transactions",
    amount: 18500,
    schedule: "quarterly",
    scheduleDay: 15,
    startsOn: "2026-01-15",
    reminderDays: 7,
    state: "paused",
    nextDueOn: "2027-01-15",
  },
  canva: {
    n: 312,
    payee: "cv",
    category: "software",
    heading: "subscriptions",
    amount: 15,
    schedule: "monthly",
    scheduleDay: 20,
    startsOn: "2025-04-20",
    endsOn: "2026-10-18",
    reminderDays: 3,
    state: "ended",
    nextDueOn: null,
  },
  warranty: {
    n: 314,
    payee: "hp",
    category: "equipment",
    heading: "transactions",
    amount: 4999,
    schedule: "yearly",
    scheduleDay: 12,
    startsOn: "2024-09-12",
    endsOn: "2026-09-12",
    reminderDays: 7,
    state: "ended",
    payVia: "outside",
    nextDueOn: null,
  },
} as const satisfies Record<string, SampleRecurring>;

type RecurringKey = keyof typeof RECURRING_SAMPLES;

function payee(
  n: number,
  name: string,
  kind: PayeeKind,
  method: PayeeMethod | null,
): Bill["payee"] {
  return { id: sampleId(n), name, kind, method, archived: false };
}

/** A sample invoice or proof of payment, drawn as a sheet of paper. */
interface Paper {
  role: "invoice" | "proof";
  heading: string;
  label: string;
  sub: string;
  lines: readonly (readonly [string, number])[];
}

interface SampleBill {
  n: number;
  payee: keyof typeof PAYEES;
  status: BillStatus;
  dueOn: string;
  /** Whole shillings, or whole dollars for a USD bill; null still to enter. */
  kes?: number | null;
  usd?: number;
  heading: "transactions" | "subscriptions";
  category: keyof typeof CATEGORIES;
  reference?: string;
  recurring?: RecurringKey;
  variable?: boolean;
  notes?: string;
  files?: readonly Paper[];
  paidOn?: string;
  paidFrom?: string;
  adjustmentReason?: string;
  paidOutsideNote?: string;
  cancelledReason?: string;
  cancelledOn?: string;
  failure?: string;
}

const PAID_THROUGH_EXPENDI: readonly BillStatus[] = [
  "paying",
  "paid",
  "payout_failed",
];

function bill(sample: SampleBill): Bill {
  const usd = sample.usd !== undefined;
  const person = {
    userId: VIEWER.userId,
    name: VIEWER.name,
    email: VIEWER.email,
  };
  const recurring = sample.recurring
    ? RECURRING_SAMPLES[sample.recurring]
    : null;
  return {
    id: sampleId(sample.n),
    status: sample.status,
    payee: PAYEES[sample.payee],
    overviewHeading: sample.heading,
    category: CATEGORIES[sample.category],
    variable: sample.variable ?? false,
    currency: usd ? "usd" : "kes",
    amountKes:
      usd || sample.kes === null || sample.kes === undefined
        ? null
        : String(sample.kes * 100),
    amountUsdc: usd ? String((sample.usd ?? 0) * 1_000_000) : null,
    reference: sample.reference ?? null,
    notes: sample.notes ?? null,
    dueOn: sample.dueOn,
    recurringItemId: recurring ? sampleId(recurring.n) : null,
    payrollRunId: null,
    adjustmentReason: sample.adjustmentReason ?? null,
    paidOn: sample.paidOn ?? null,
    paidAt: sample.paidOn ? `${sample.paidOn}T09:00:00.000Z` : null,
    markedPaidBy: sample.status === "paid_outside" ? person : null,
    paidOutsideNote: sample.paidOutsideNote ?? null,
    cancelledReason: sample.cancelledReason ?? null,
    cancelledAt: sample.cancelledOn
      ? `${sample.cancelledOn}T09:00:00.000Z`
      : null,
    cancelledBy: sample.cancelledOn ? person : null,
    payoutId: PAID_THROUGH_EXPENDI.includes(sample.status)
      ? sampleId(sample.n + 5000)
      : null,
    fileCount: sample.files?.length ?? 0,
    recurring: recurring
      ? {
          id: sampleId(recurring.n),
          state: "state" in recurring ? recurring.state : "active",
          schedule: recurring.schedule,
          scheduleDay: recurring.scheduleDay,
          startsOn: recurring.startsOn,
        }
      : null,
    paidFromAccount: sample.paidFrom
      ? { id: sampleId(sample.n + 6000), name: sample.paidFrom }
      : null,
    createdAt: "2026-10-20T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
  };
}

const OPEN_SAMPLES: readonly SampleBill[] = [
  {
    n: 1,
    payee: "kp",
    kes: 48500,
    dueOn: "2026-11-01",
    status: "overdue",
    heading: "transactions",
    category: "rent",
    reference: "INV-2026-1101",
    recurring: "rent",
    notes: "Rent plus service charge.",
    files: [
      {
        role: "invoice",
        heading: "Kilimani Properties Ltd",
        label: "INVOICE",
        sub: "INV-2026-1101, 28 Oct 2026",
        lines: [
          ["Office rent, November", 45000],
          ["Service charge", 3500],
        ],
      },
    ],
  },
  {
    n: 2,
    payee: "sg",
    kes: 32000,
    dueOn: "2026-10-31",
    status: "overdue",
    heading: "transactions",
    category: "security",
    reference: "SG-1031",
    recurring: "guards",
    files: [
      {
        role: "invoice",
        heading: "Securex Guards Ltd",
        label: "INVOICE",
        sub: "SG-1031, 25 Oct 2026",
        lines: [["Night guard, October", 32000]],
      },
    ],
  },
  {
    n: 3,
    payee: "sf",
    kes: 6999,
    dueOn: "2026-11-06",
    status: "due",
    heading: "subscriptions",
    category: "airtime",
    recurring: "fibre",
  },
  {
    n: 4,
    payee: "fg",
    usd: 45,
    dueOn: "2026-11-06",
    status: "due",
    heading: "subscriptions",
    category: "software",
    reference: "FIG-88213",
    recurring: "figma",
    files: [
      {
        role: "invoice",
        heading: "Figma, Inc.",
        label: "INVOICE",
        sub: "FIG-88213, 1 Nov 2026",
        lines: [["Professional, 3 editors", 45]],
      },
    ],
  },
  {
    n: 5,
    payee: "zk",
    kes: 4100,
    dueOn: "2026-11-04",
    status: "payout_failed",
    heading: "subscriptions",
    category: "airtime",
    recurring: "tv",
    failure: "The paybill didn't accept the account number.",
  },
  {
    n: 6,
    payee: "tf",
    kes: 186000,
    dueOn: "2026-11-05",
    status: "paying",
    heading: "transactions",
    category: "suppliers",
    reference: "INV-4471",
    recurring: "twiga",
    variable: true,
    files: [
      {
        role: "invoice",
        heading: "Twiga Foods Ltd",
        label: "INVOICE",
        sub: "INV-4471, 30 Oct 2026",
        lines: [["Maize flour, 120 bales", 186000]],
      },
    ],
  },
  {
    n: 7,
    payee: "kra",
    kes: null,
    dueOn: "2026-11-09",
    status: "upcoming",
    heading: "transactions",
    category: "taxes",
    recurring: "paye",
    variable: true,
    notes: "PAYE for October. Enter the amount once payroll is final.",
  },
  {
    n: 8,
    payee: "nw",
    kes: 3850,
    dueOn: "2026-11-15",
    status: "upcoming",
    heading: "transactions",
    category: "rent",
    recurring: "water",
  },
  {
    n: 9,
    payee: "kpl",
    kes: 14250,
    dueOn: "2026-11-18",
    status: "upcoming",
    heading: "transactions",
    category: "rent",
    reference: "54012339",
    recurring: "power",
    variable: true,
  },
  {
    n: 10,
    payee: "bk",
    kes: 120000,
    dueOn: "2026-11-20",
    status: "upcoming",
    heading: "transactions",
    category: "suppliers",
    reference: "BID-2210-55",
    files: [
      {
        role: "invoice",
        heading: "Bidco Africa Ltd",
        label: "INVOICE",
        sub: "BID-2210-55, 21 Oct 2026",
        lines: [["Cooking oil, 40 jerrycans", 120000]],
      },
    ],
  },
  {
    n: 11,
    payee: "cm",
    kes: 18500,
    dueOn: "2026-11-22",
    status: "upcoming",
    heading: "transactions",
    category: "repairs",
    reference: "JOB-7712",
    files: [
      {
        role: "invoice",
        heading: "CarMax Mechanics",
        label: "QUOTE",
        sub: "JOB-7712, 2 Nov 2026",
        lines: [
          ["Van brake pads", 12500],
          ["Labour", 6000],
        ],
      },
    ],
  },
  {
    n: 12,
    payee: "hp",
    kes: 12000,
    dueOn: "2026-11-25",
    status: "upcoming",
    heading: "transactions",
    category: "equipment",
    notes: "Microwave for the kitchen. They only take cheques.",
  },
  {
    n: 13,
    payee: "gw",
    usd: 72,
    dueOn: "2026-12-01",
    status: "upcoming",
    heading: "subscriptions",
    category: "software",
    recurring: "workspace",
  },
  {
    n: 14,
    payee: "jh",
    kes: 64500,
    dueOn: "2026-12-01",
    status: "upcoming",
    heading: "transactions",
    category: "insurance",
    reference: "JH-77812-DEC",
    recurring: "health",
  },
];

const SETTLED_SAMPLES: readonly SampleBill[] = [
  {
    n: 21,
    payee: "kpl",
    kes: 14250,
    dueOn: "2026-11-04",
    status: "paid",
    paidOn: "2026-11-04",
    heading: "transactions",
    category: "rent",
    files: [
      {
        role: "proof",
        heading: "Expendi",
        label: "PAYMENT",
        sub: "Paid 4 Nov 2026, 14:03",
        lines: [["Paybill 888880, 54012339", 14250]],
      },
    ],
  },
  {
    n: 22,
    payee: "jh",
    kes: 64500,
    dueOn: "2026-11-01",
    status: "paid",
    paidOn: "2026-11-01",
    heading: "transactions",
    category: "insurance",
    recurring: "health",
  },
  {
    n: 23,
    payee: "gw",
    usd: 72,
    dueOn: "2026-11-01",
    status: "paid",
    paidOn: "2026-11-01",
    heading: "subscriptions",
    category: "software",
    recurring: "workspace",
  },
  {
    n: 24,
    payee: "cv",
    usd: 15,
    dueOn: "2026-10-20",
    status: "cancelled",
    cancelledOn: "2026-10-18",
    cancelledReason: "Subscription cancelled; the team moved to Figma.",
    heading: "subscriptions",
    category: "software",
    recurring: "canva",
  },
  {
    n: 25,
    payee: "kp",
    kes: 48500,
    dueOn: "2026-10-01",
    status: "paid",
    paidOn: "2026-10-15",
    heading: "transactions",
    category: "rent",
    reference: "INV-2026-1001",
    recurring: "rent",
    files: [
      {
        role: "invoice",
        heading: "Kilimani Properties Ltd",
        label: "INVOICE",
        sub: "INV-2026-1001, 1 Oct 2026",
        lines: [
          ["Office rent, October", 45000],
          ["Service charge", 3500],
        ],
      },
      {
        role: "proof",
        heading: "Expendi",
        label: "PAYMENT",
        sub: "Paid 15 Oct 2026, 09:02",
        lines: [["Paybill 522522, KP-1182", 48500]],
      },
    ],
  },
  {
    n: 26,
    payee: "tf",
    kes: 98000,
    dueOn: "2026-10-10",
    status: "paid",
    paidOn: "2026-10-10",
    heading: "transactions",
    category: "suppliers",
  },
  {
    n: 27,
    payee: "nw",
    kes: 3610,
    dueOn: "2026-10-15",
    status: "paid",
    paidOn: "2026-10-14",
    heading: "transactions",
    category: "rent",
    recurring: "water",
    adjustmentReason: "The meter reading came in lower than the estimate.",
  },
  {
    n: 28,
    payee: "sf",
    kes: 6999,
    dueOn: "2026-10-06",
    status: "paid",
    paidOn: "2026-10-06",
    heading: "subscriptions",
    category: "airtime",
    recurring: "fibre",
  },
  {
    n: 29,
    payee: "hp",
    kes: 54999,
    dueOn: "2026-09-12",
    status: "paid_outside",
    paidOn: "2026-09-12",
    paidFrom: "Equity Bank ••4521",
    paidOutsideNote: "Paid by cheque 001284.",
    heading: "transactions",
    category: "equipment",
    files: [
      {
        role: "proof",
        heading: "Equity Bank",
        label: "CHEQUE",
        sub: "No. 001284, 12 Sep 2026",
        lines: [["Hotpoint Appliances", 54999]],
      },
    ],
  },
];

/** Still to pay and being paid: the To pay and Being paid tabs. */
export const OPEN_BILLS: readonly Bill[] = OPEN_SAMPLES.map(bill);

/** Paid, paid outside Expendi and cancelled: the History tab. */
export const SETTLED_BILLS: readonly Bill[] = SETTLED_SAMPLES.map(bill);

const ALL_SAMPLES = [...OPEN_SAMPLES, ...SETTLED_SAMPLES];
const ALL_BILLS = [...OPEN_BILLS, ...SETTLED_BILLS];

/** The wallet as the bills page reads it, for today's KES per USDC. */
export const WALLET: WalletResponse = {
  status: "active",
  address: "8f3a5b2c9d1e4f7a6b0c3d2e1f9a8b7c6d5e4c218f3a5b2c9d1e4f7a6b0c3d2e",
  chain: "near",
  usdcBalance: "16420800000",
  kesEquivalent: { kesCents: "211828320", rate: KES_RATE },
};

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const figure = (amount: number): string =>
  amount.toLocaleString("en-KE", {
    minimumFractionDigits: amount % 1 ? 2 : 0,
  });

/** The paper the mock draws for a file, as an SVG the viewer can show. */
function paperSvg(paper: Paper): string {
  const top = 74;
  const rows = paper.lines.map(
    ([label, amount], at) =>
      `<text x="20" y="${String(top + at * 20)}" fill="#475467">${escapeXml(label)}</text>` +
      `<text x="280" y="${String(top + at * 20)}" fill="#475467" text-anchor="end">${figure(amount)}</text>`,
  );
  const ruleY = top + paper.lines.length * 20 - 6;
  const total = paper.lines.reduce((sum, [, amount]) => sum + amount, 0);
  const height = ruleY + 40;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="${String(height)}" viewBox="0 0 300 ${String(height)}" font-family="Outfit, system-ui, sans-serif" font-size="12">`,
    `<rect x="0.5" y="0.5" width="299" height="${String(height - 1)}" rx="2" fill="#fff" stroke="#e4e7ec"/>`,
    `<text x="20" y="30" font-size="13" font-weight="600" fill="#101828">${escapeXml(paper.heading)}</text>`,
    `<text x="280" y="30" font-size="11" letter-spacing="0.6" fill="#667085" text-anchor="end">${paper.label}</text>`,
    `<text x="20" y="48" fill="#667085">${escapeXml(paper.sub)}</text>`,
    ...rows,
    `<line x1="20" x2="280" y1="${String(ruleY)}" y2="${String(ruleY)}" stroke="#d0d5dd" stroke-dasharray="3 3"/>`,
    `<text x="20" y="${String(ruleY + 20)}" font-weight="600" fill="#101828">Total</text>`,
    `<text x="280" y="${String(ruleY + 20)}" font-weight="600" fill="#101828" text-anchor="end">${figure(total)}</text>`,
    `</svg>`,
  ].join("");
}

function fileOf(sample: SampleBill, paper: Paper, at: number): BillFile {
  return {
    id: sampleId(sample.n * 10 + at + 7000),
    role: paper.role,
    kind: "screenshot",
    contentType: "image/svg+xml",
    url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(paperSvg(paper))}`,
    expiresAt: "2026-11-06T12:00:00.000Z",
  };
}

function detailOf(sample: SampleBill, row: Bill): BillDetail {
  return {
    ...row,
    files: (sample.files ?? []).map((paper, at) => fileOf(sample, paper, at)),
    payout:
      row.payoutId === null
        ? null
        : {
            id: row.payoutId,
            status:
              row.status === "payout_failed"
                ? "failed"
                : row.status === "paid"
                  ? "paid"
                  : "paying",
            failureReason: sample.failure ?? null,
          },
  };
}

/** Each bill as `GET …/bills/:id` returns it, with its files. */
export const BILL_DETAILS: readonly BillDetail[] = ALL_SAMPLES.map(
  (sample, at) => detailOf(sample, ALL_BILLS[at] ?? bill(sample)),
);

const OUTSTANDING: readonly BillStatus[] = OUTSTANDING_BILL_STATUSES;

function recurringItem(sample: SampleRecurring): RecurringItem {
  const id = sampleId(sample.n);
  const owed = OPEN_BILLS.find(
    (one) => one.recurringItemId === id && OUTSTANDING.includes(one.status),
  );
  const usd = PAYEES[sample.payee].method === "usdc";
  const amount = sample.amount;
  return {
    id,
    state: sample.state ?? "active",
    payee: PAYEES[sample.payee],
    overviewHeading: sample.heading,
    category: CATEGORIES[sample.category],
    variable: amount === null,
    currency: usd ? "usd" : "kes",
    amountKes: amount === null || usd ? null : String(amount * 100),
    amountUsdc: amount === null || !usd ? null : String(amount * 1_000_000),
    schedule: sample.schedule,
    scheduleDay: sample.scheduleDay,
    startsOn: sample.startsOn,
    endsOn: sample.endsOn ?? null,
    payVia: sample.payVia ?? "expendi",
    reminderDays: sample.reminderDays,
    active: (sample.state ?? "active") === "active",
    nextDueOn: sample.nextDueOn,
    nextBill: owed
      ? {
          id: owed.id,
          status: owed.status,
          dueOn: owed.dueOn,
          currency: owed.currency,
          amountKes: owed.amountKes,
          amountUsdc: owed.amountUsdc,
        }
      : null,
    createdAt: "2026-01-02T09:00:00.000Z",
    updatedAt: "2026-10-20T09:00:00.000Z",
  };
}

/** `GET …/recurring-items?excludeSalaries=true`. */
export const RECURRING_ITEMS: readonly RecurringItem[] =
  Object.values(RECURRING_SAMPLES).map(recurringItem);

function totals(bills: readonly Bill[]) {
  const { kes, usd } = totalsByCurrency(
    bills.map((one) => ({
      currency: one.currency,
      amount: one.currency === "usd" ? one.amountUsdc : one.amountKes,
    })),
  );
  return { count: bills.length, totalKes: kes, totalUsdc: usd };
}

const UNPAID: readonly BillStatus[] = UNPAID_BILL_STATUSES;

type QueryParams = Readonly<Record<string, unknown>>;

const SETTLED: readonly BillStatus[] = BILL_LIST_VIEW_STATUSES.history;

/** Whether a bill passes the filters `GET …/bills` and its summary share. */
function matches(one: Bill, params: QueryParams): boolean {
  const unset = (name: string) => params[name] === undefined;
  return (
    (unset("payeeId") || one.payee.id === params.payeeId) &&
    (unset("categoryId") || one.category.id === params.categoryId) &&
    (unset("heading") || one.overviewHeading === params.heading) &&
    (unset("method") || (one.payee.method ?? "none") === params.method) &&
    (unset("source") ||
      (one.recurringItemId ? "recurring" : "one_off") === params.source) &&
    (typeof params.settledFrom !== "string" ||
      !SETTLED.includes(one.status) ||
      settledOn(one) >= params.settledFrom)
  );
}

/** `GET …/bills` over the sample bills, by due date as the API sorts them. */
export function listSampleBills(params: QueryParams): Bill[] {
  const view = BILL_LIST_VIEWS.find((one) => one === params.view) ?? "open";
  const statuses: readonly BillStatus[] = BILL_LIST_VIEW_STATUSES[view];
  return ALL_BILLS.filter(
    (one) =>
      statuses.includes(one.status) &&
      (params.status === undefined || one.status === params.status) &&
      matches(one, params),
  ).sort((a, b) => a.dueOn.localeCompare(b.dueOn));
}

/** `GET …/bills/summary`: the tabs follow the filters, the rest is company-wide. */
export function summarizeSampleBills(params: QueryParams): BillsSummary {
  const count = (view: BillListView) =>
    listSampleBills({ ...params, view }).length;
  const withStatus = (status: BillStatus) =>
    OPEN_BILLS.filter((one) => one.status === status);
  const toPay = OPEN_BILLS.filter((one) => UNPAID.includes(one.status));
  return {
    views: {
      open: count("open"),
      paying: count("paying"),
      history: count("history"),
    },
    toPay: {
      ...totals(toPay),
      withoutAmount: toPay.filter(
        (one) => one.amountKes === null && one.amountUsdc === null,
      ).length,
    },
    overdue: totals(withStatus("overdue")),
    dueToday: totals(withStatus("due")),
    payoutFailed: totals(withStatus("payout_failed")),
  };
}

/** `GET …/bills/summary` unfiltered, for the sidebar badge. */
export const BILLS_SUMMARY: BillsSummary = summarizeSampleBills({});

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/**
 * Seeds the bills, their details and the recurring payments, and answers
 * each filtered list and summary the page asks for as it's first asked,
 * so the filters and tabs work in the preview.
 */
export function seedBills(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  for (const detail of BILL_DETAILS) {
    client.setQueryData(billKeys.detail(org, detail.id), detail);
  }
  client.setQueryData(recurringListKey(org), RECURRING_ITEMS);
  for (const item of RECURRING_ITEMS) {
    client.setQueryData(recurringKeys.detail(org, item.id), item);
  }
  const prefix = billKeys.all(org);
  const answer = (queryKey: QueryKey) => {
    const [scope, company, kind, params] = queryKey;
    if (scope !== prefix[0] || company !== org || !isObject(params)) return;
    if (kind === "list" && "view" in params) {
      client.setQueryData(queryKey, listSampleBills(params));
    } else if (kind === "summary") {
      client.setQueryData(queryKey, summarizeSampleBills(params));
    }
  };
  const cache = client.getQueryCache();
  cache.subscribe((event) => {
    if (event.type !== "added") return;
    const added = cache.get(event.query.queryHash);
    if (added) answer(added.queryKey);
  });
}
