import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  BanknoteIcon,
  BookOpenIcon,
  Building2Icon,
  CoinsIcon,
  DownloadIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  HandCoinsIcon,
  KeyRoundIcon,
  LandmarkIcon,
  ReceiptTextIcon,
  RepeatIcon,
  SendIcon,
  SettingsIcon,
  ShieldCheckIcon,
  TagIcon,
  UserIcon,
  UsersIcon,
  WalletIcon,
} from "lucide-react";

import type { ActivityEntry } from "@expendi-business/shared";
import {
  FUND_IN_CHAIN_NAMES,
  PAYEE_CHAIN_NAMES,
} from "@expendi-business/shared";

import type { MoneyCurrency } from "~/components/data/money";
import type { StatusTone } from "~/components/data/status-badge";
import type { ApproxKesTotal } from "~/lib/money";
import { ROLE_LABELS } from "~/config/roles";
import { shortAddress } from "~/features/chain-display";
import { formatIsoDate } from "~/lib/dates";
import { formatKes, sumUnits } from "~/lib/money";
import { formatNairobiDateTime } from "~/lib/nairobi-time";

/**
 * The areas of the audit log a company filters by: each is the start of
 * the actions recorded for it (`<entity>.<verb>`, spec §6.13).
 */
export const ACTIVITY_AREAS: readonly {
  readonly prefix: string;
  readonly label: string;
  readonly icon: LucideIcon;
}[] = [
  {
    prefix: "expense.",
    label: "Reimbursements and spending",
    icon: ReceiptTextIcon,
  },
  { prefix: "payout.", label: "Payments and withdrawals", icon: SendIcon },
  { prefix: "bill.", label: "Bills", icon: FileTextIcon },
  { prefix: "recurring_item.", label: "Recurring payments", icon: RepeatIcon },
  { prefix: "salary.", label: "Salaries", icon: HandCoinsIcon },
  { prefix: "payroll_run.", label: "Payroll runs", icon: BanknoteIcon },
  { prefix: "float.", label: "Petty cash", icon: CoinsIcon },
  { prefix: "payee.", label: "Payees", icon: Building2Icon },
  { prefix: "membership.", label: "Team", icon: UsersIcon },
  { prefix: "category.", label: "Categories", icon: TagIcon },
  {
    prefix: "paid_from_account.",
    label: "Paid-from accounts",
    icon: LandmarkIcon,
  },
  {
    prefix: "withdrawal_address.",
    label: "Allowed addresses",
    icon: ShieldCheckIcon,
  },
  { prefix: "wallet.", label: "USDC wallet", icon: WalletIcon },
  { prefix: "organization.", label: "Company settings", icon: SettingsIcon },
  { prefix: "accounting_", label: "Zoho Books", icon: BookOpenIcon },
  { prefix: "report_export.", label: "Exports", icon: DownloadIcon },
];

export const areaOf = (action: string) =>
  ACTIVITY_AREAS.find((area) => action.startsWith(area.prefix)) ?? null;

const words = (identifier: string) => identifier.replaceAll("_", " ").trim();

const capitalised = (text: string) =>
  text.length === 0 ? text : `${text[0]?.toUpperCase() ?? ""}${text.slice(1)}`;

/** Where the generic wording reads wrong. */
const ACTION_LABELS: Readonly<Record<string, string>> = {
  "payout.paying": "Payment sent",
  "payee.restored": "Payee restored",
};

/** `payroll_run.payment_left_out` → `Payroll run payment left out`. */
export function describeAction(action: string): string {
  const named = ACTION_LABELS[action];
  if (named) return named;
  const [entity = "", ...verb] = action.split(".");
  return capitalised([words(entity), ...verb.map(words)].join(" "));
}

/** Who did it: a person in the company, Expendi's team, or its systems. */
export function describeActor(actor: ActivityEntry["actor"]): string {
  switch (actor.type) {
    case "user":
      return actor.name ?? "Someone no longer in the company";
    case "staff":
      return "Expendi team";
    case "system":
      return "Expendi (automatic)";
  }
}

export const ACTOR_ABOUT: Readonly<Record<"staff" | "system", string>> = {
  system:
    "Expendi's own systems: payment updates, the reconciliation job and other jobs.",
  staff: "Expendi staff, in the internal admin app.",
};

export const ENTITY_TYPES: Readonly<
  Record<string, { readonly label: string; readonly icon: LucideIcon }>
> = {
  bill: { label: "Bill", icon: FileTextIcon },
  expense: { label: "Expense", icon: ReceiptTextIcon },
  payee: { label: "Payee", icon: Building2Icon },
  membership: { label: "Team member", icon: UsersIcon },
  category: { label: "Category", icon: TagIcon },
  payroll_run: { label: "Payroll run", icon: BanknoteIcon },
  recurring_item: { label: "Recurring payment", icon: RepeatIcon },
  float: { label: "Petty cash float", icon: CoinsIcon },
  payout: { label: "Payment", icon: SendIcon },
  wallet: { label: "USDC wallet", icon: WalletIcon },
  organization: { label: "Company", icon: SettingsIcon },
  accounting_connection: { label: "Zoho Books connection", icon: BookOpenIcon },
  accounting_sync: { label: "Zoho Books sync", icon: BookOpenIcon },
  report_export: { label: "Export", icon: DownloadIcon },
  paid_from_account: { label: "Paid-from account", icon: LandmarkIcon },
  withdrawal_address: { label: "Allowed address", icon: ShieldCheckIcon },
  user: { label: "Person", icon: UserIcon },
  import: { label: "Import", icon: FileSpreadsheetIcon },
  import_run: { label: "Import", icon: FileSpreadsheetIcon },
  float_movement: { label: "Petty cash", icon: CoinsIcon },
  approval_passkey: { label: "Approval passkey", icon: KeyRoundIcon },
};

export function entityTypeOf(type: string): {
  readonly label: string;
  readonly icon: LucideIcon;
} {
  return (
    ENTITY_TYPES[type] ?? {
      label: capitalised(words(type)),
      icon: ActivityIcon,
    }
  );
}

/** The record as people know it: its label, or its kind. */
export function recordName(entity: ActivityEntry["entity"]): string {
  return entity.label ?? entityTypeOf(entity.type).label;
}

/** A salary is a recurring item, recorded under `salary.` actions. */
const isSalary = (entity: ActivityEntry["entity"], action: string) =>
  entity.type === "recurring_item" && action.startsWith("salary.");

/** Where a record lives now, for "Open in …". */
export function recordLink(
  entity: ActivityEntry["entity"],
  action: string,
): { readonly href: string; readonly page: string } | null {
  const id = entity.id ? encodeURIComponent(entity.id) : null;
  switch (entity.type) {
    case "bill":
      return { href: id ? `/bills?billId=${id}` : "/bills", page: "Bills" };
    case "recurring_item":
      return isSalary(entity, action)
        ? {
            href: id ? `/payroll?salaryId=${id}` : "/payroll",
            page: "Payroll",
          }
        : {
            href: id ? `/bills?recurring=${id}` : "/bills?recurring=all",
            page: "Bills",
          };
    case "payroll_run":
      return {
        href: id ? `/payroll?runId=${id}` : "/payroll",
        page: "Payroll",
      };
    case "expense":
      return {
        href: id ? `/expenses?expenseId=${id}` : "/expenses",
        page: "Expenses",
      };
    case "float":
    case "float_movement":
      return { href: "/expenses?kind=petty_cash", page: "Expenses" };
    case "payee":
      return { href: id ? `/payees?id=${id}` : "/payees", page: "Payees" };
    case "membership":
      return { href: id ? `/team?memberId=${id}` : "/team", page: "Team" };
    case "user":
      return { href: "/team", page: "Team" };
    case "category":
      return {
        href: id
          ? `/settings?section=categories&category=${id}`
          : "/settings?section=categories",
        page: "Settings",
      };
    case "paid_from_account":
      return {
        href: id
          ? `/settings?section=accounts&account=${id}`
          : "/settings?section=accounts",
        page: "Settings",
      };
    case "approval_passkey":
      return { href: "/settings?section=passkey", page: "Settings" };
    case "accounting_connection":
    case "accounting_sync":
      return { href: "/settings?section=zoho", page: "Settings" };
    case "organization":
      return { href: "/settings", page: "Settings" };
    case "payout":
    case "wallet":
    case "withdrawal_address":
      return { href: "/wallet", page: "Accounts" };
    case "report_export":
      return { href: "/reports", page: "Reports" };
    default:
      return null;
  }
}

type Json = ActivityEntry["after"];

export function fieldsOf(value: Json): Readonly<Record<string, Json>> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

/** Minor units as the API records them: a string of digits, or a whole number. */
function minorUnits(value: Json | undefined): string | null {
  if (typeof value === "string" && /^\d+$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return null;
}

export interface EntryAmount {
  readonly amount: string;
  readonly currency: MoneyCurrency;
  /** KES cents for a USD amount, when the payment recorded it. */
  readonly kes: string | null;
}

/** The amount an entry records, where it has one. */
export function amountOf(entry: ActivityEntry): EntryAmount | null {
  const after = fieldsOf(entry.after);
  if (!after) return null;
  const kes = minorUnits(after.amountKes);
  if (kes) return { amount: kes, currency: "KES", kes };
  const usdc = minorUnits(after.amountUsdc);
  if (usdc) {
    return {
      amount: usdc,
      currency: after.currency === "usd" ? "USD" : "USDC",
      kes: minorUnits(after.kesEquivalent),
    };
  }
  const debit = minorUnits(after.maxDebitUsdc);
  return debit ? { amount: debit, currency: "USDC", kes: null } : null;
}

/**
 * One KES figure for entries approved together, from what each payment
 * recorded in KES; "≈" when one of them was in USD.
 */
export function kesTotalOf(
  entries: readonly ActivityEntry[],
): ApproxKesTotal | null {
  const amounts = entries.flatMap((entry) => {
    const amount = amountOf(entry);
    return amount?.kes ? [amount] : [];
  });
  if (amounts.length === 0) return null;
  return {
    kesCents: sumUnits(amounts.map((amount) => amount.kes ?? "0")),
    approximate: amounts.some((amount) => amount.currency !== "KES"),
  };
}

const STATUS_LABELS: Readonly<
  Record<string, Readonly<Record<string, readonly [string, StatusTone]>>>
> = {
  bill: {
    upcoming: ["Upcoming", "quiet"],
    due: ["Due today", "waiting"],
    overdue: ["Overdue", "overdue"],
    paying: ["Being paid", "moving"],
    paid: ["Paid", "paid"],
    payout_failed: ["Payment failed", "failed"],
    paid_outside: ["Paid outside Expendi", "paid"],
    cancelled: ["Cancelled", "rejected"],
  },
  expense: {
    submitted: ["Waiting for approval", "waiting"],
    rejected: ["Rejected", "rejected"],
    paying: ["Being paid", "moving"],
    paid: ["Paid", "paid"],
    payout_failed: ["Payment failed", "failed"],
    paid_outside: ["Paid before Expendi", "quiet"],
    recorded: ["Recorded", "quiet"],
  },
  payroll_run: {
    draft: ["Draft", "quiet"],
    paying: ["Being paid", "moving"],
    paid: ["Paid", "paid"],
  },
  payout: {
    prepared: ["Prepared", "quiet"],
    funded: ["Funded", "moving"],
    paying: ["On its way", "moving"],
    paid: ["Paid", "paid"],
    failed: ["Failed", "failed"],
  },
  membership: {
    invited: ["Invited", "waiting"],
    active: ["Active", "paid"],
    removed: ["Removed", "rejected"],
  },
};

/** What a recorded value reads as in the changes table. */
export type ShownValue =
  | { readonly kind: "none" }
  | { readonly kind: "text"; readonly text: string }
  | {
      readonly kind: "money";
      readonly amount: string;
      readonly currency: MoneyCurrency;
    }
  | {
      readonly kind: "status";
      readonly label: string;
      readonly tone: StatusTone;
    };

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const CHAIN_NAMES: Readonly<Record<string, string>> = {
  ...PAYEE_CHAIN_NAMES,
  ...FUND_IN_CHAIN_NAMES,
};

/** "NEAR" for "near"; a chain this page doesn't know stays as recorded. */
const chainName = (value: Json): string | null =>
  typeof value === "string" ? (CHAIN_NAMES[value] ?? value) : null;

const yesNo = (value: Json) =>
  value === true ? "Yes" : value === false ? "No" : null;

function paymentDetails(value: Json): string | null {
  const details = fieldsOf(value);
  if (!details) return null;
  const text = (key: string) =>
    typeof details[key] === "string" ? details[key] : "";
  switch (details.method) {
    case "paybill":
      return `M-Pesa Paybill ${text("paybill")}, account ${text("account")}`;
    case "till":
      return `M-Pesa Till ${text("till")}`;
    case "mpesa":
      return `M-Pesa ${text("phone")}`;
    case "bank":
      return `${text("bankName")}, account ending ${text("accountNumber").slice(-4)}`;
    case "usdc":
      return [
        `USDC wallet ${shortAddress(text("address"))}`,
        chainName(details.chain ?? null),
      ]
        .filter((part) => part !== null)
        .join(" on ");
    default:
      return null;
  }
}

interface FieldFormat {
  readonly label: string;
  readonly show?: (value: Json, entityType: string) => ShownValue | null;
}

const text = (value: string | null): ShownValue | null =>
  value === null ? null : { kind: "text", text: value };

const kes = (label: string): FieldFormat => ({
  label,
  show: (value) => {
    const cents = minorUnits(value);
    return cents ? { kind: "money", amount: cents, currency: "KES" } : null;
  },
});

const usdc = (label: string): FieldFormat => ({
  label,
  show: (value) => {
    const units = minorUnits(value);
    return units ? { kind: "money", amount: units, currency: "USDC" } : null;
  },
});

const dateField = (label: string): FieldFormat => ({
  label,
  show: (value) =>
    text(typeof value === "string" ? formatIsoDate(value) : null),
});

const flag = (label: string): FieldFormat => ({
  label,
  show: (value) => text(yesNo(value)),
});

/** Readable names, and readable values, for the fields the log records. */
const FIELDS: Readonly<Record<string, FieldFormat>> = {
  status: {
    label: "Status",
    show: (value, entityType) => {
      if (typeof value !== "string") return null;
      const [label, tone] = STATUS_LABELS[entityType]?.[value] ?? [
        capitalised(words(value)),
        "quiet",
      ];
      return { kind: "status", label, tone };
    },
  },
  amountKes: kes("Amount"),
  kesEquivalent: kes("In KES"),
  amountUsdc: usdc("Amount"),
  maxDebitUsdc: usdc("From the wallet, at most"),
  currency: {
    label: "Currency",
    show: (value) =>
      text(typeof value === "string" ? value.toUpperCase() : null),
  },
  selfApproval: flag("Self-approved"),
  name: { label: "Name" },
  fullName: { label: "Name" },
  email: { label: "Email" },
  kind: {
    label: "Kind",
    show: (value) =>
      text(
        value === "supplier"
          ? "Supplier"
          : value === "withdrawal"
            ? "Withdrawal"
            : value === "employee"
              ? "Employee"
              : typeof value === "string"
                ? capitalised(words(value))
                : null,
      ),
  },
  details: {
    label: "Payment details",
    show: (value) => text(paymentDetails(value)),
  },
  role: {
    label: "Role",
    show: (value) =>
      text(
        value === "admin" || value === "employee" || value === "accountant"
          ? ROLE_LABELS[value]
          : null,
      ),
  },
  reason: { label: "Reason" },
  rejectedReason: { label: "Reason" },
  etimsNotRequired: flag("eTIMS not required"),
  month: {
    label: "Month",
    show: (value) => {
      if (typeof value !== "string") return null;
      const [year, month] = value.split("-");
      const name = MONTHS[Number(month) - 1];
      return text(name && year ? `${name} ${year}` : value);
    },
  },
  monthly: flag("Monthly export"),
  recipients: {
    label: "Emailed to",
    show: (value) =>
      text(
        Array.isArray(value)
          ? value.filter((item) => typeof item === "string").join(", ")
          : null,
      ),
  },
  expiresAt: {
    label: "Link expires",
    show: (value) =>
      text(typeof value === "string" ? formatNairobiDateTime(value) : null),
  },
  payoutsPaused: flag("Payments paused"),
  merchant: { label: "Merchant" },
  category: { label: "Category" },
  spentOn: dateField("Spent on"),
  dueOn: dateField("Due"),
  endedOn: dateField("Ended on"),
  reference: { label: "Reference" },
  payee: { label: "Payee" },
  amountChangeReason: { label: "Why the amount changed" },
  noReceiptReason: { label: "Why there's no receipt" },
  label: { label: "Label" },
  address: { label: "Address" },
  to: { label: "To" },
  from: {
    label: "From",
    show: (value) =>
      text(typeof value === "string" ? shortAddress(value) : null),
  },
  phone: { label: "M-Pesa number" },
  type: {
    label: "Type",
    show: (value) =>
      text(
        value === "top_up"
          ? "Top-up"
          : value === "issue"
            ? "Float issued"
            : typeof value === "string"
              ? capitalised(words(value))
              : null,
      ),
  },
  payrollMarginPercent: {
    label: "Payroll cap margin",
    show: (value) =>
      text(typeof value === "number" ? `${String(value)}%` : null),
  },
  warnings: {
    label: "Warnings",
    show: (value) =>
      text(
        Array.isArray(value)
          ? value
              .flatMap((warning) =>
                typeof warning !== "string"
                  ? []
                  : warning === "near_duplicate"
                    ? ["Possible duplicate"]
                    : warning === "older_than_60_days"
                      ? ["Over 60 days old"]
                      : [warning],
              )
              .join(", ")
          : null,
      ),
  },
  paidFrom: { label: "Paid from" },
  pettyCash: flag("Petty cash"),
  filename: { label: "File" },
  rows: { label: "Rows" },
  created: { label: "Added" },
  skipped: { label: "Skipped" },
  payments: { label: "Payments" },
  paid: { label: "Paid" },
  failed: { label: "Failed" },
  person: { label: "Person" },
  note: { label: "Note" },
  zohoOrganization: { label: "Zoho organization" },
  expenseAccount: { label: "Expense account" },
  paidThroughAccount: { label: "Paid through account" },
  dayOfMonth: { label: "Day of the month" },
  device: { label: "Device" },
  chain: { label: "Chain", show: (value) => text(chainName(value)) },
  last4: { label: "Last 4 digits" },
  kraPin: { label: "KRA PIN" },
  refundOf: { label: "Refund of" },
  txHash: {
    label: "Transaction",
    show: (value) =>
      text(typeof value === "string" ? shortAddress(value) : null),
  },
};

/** IDs stay in "Recorded values"; a passkey approval shows as its own line. */
const HIDDEN_FIELDS = new Set([
  "approvalId",
  "payoutId",
  "payoutIds",
  "paidBefore",
  "linkId",
  "floatId",
  "userId",
  "membershipId",
  "batchSize",
]);

/** `etimsNotRequired` → `eTIMS not required`; unknown keys in plain words. */
export function fieldLabel(key: string): string {
  return (
    FIELDS[key]?.label ??
    capitalised(
      key
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .replaceAll("_", " ")
        .toLowerCase(),
    )
  );
}

export function showValue(
  key: string,
  value: Json | undefined,
  entityType: string,
): ShownValue {
  if (value === undefined || value === null) return { kind: "none" };
  const shown = FIELDS[key]?.show?.(value, entityType);
  if (shown) return shown;
  if (typeof value === "string") return { kind: "text", text: value };
  if (typeof value === "number") return { kind: "text", text: String(value) };
  if (typeof value === "boolean")
    return { kind: "text", text: value ? "Yes" : "No" };
  return { kind: "text", text: JSON.stringify(value) };
}

export interface ChangeRow {
  readonly key: string;
  readonly label: string;
  readonly before: ShownValue | null;
  readonly after: ShownValue;
  readonly changed: boolean;
}

/**
 * The recorded values field by field: before and after where the entry
 * recorded both, or what was recorded. IDs are left to "Recorded values".
 */
export function describeChanges(entry: ActivityEntry): {
  readonly hasBefore: boolean;
  readonly rows: readonly ChangeRow[];
} {
  const from = fieldsOf(entry.before);
  const to = fieldsOf(entry.after);
  const keys = [
    ...new Set([...Object.keys(to ?? {}), ...Object.keys(from ?? {})]),
  ].filter((key) => !HIDDEN_FIELDS.has(key));
  const type = entry.entity.type;
  return {
    hasBefore: from !== null,
    rows: keys.map((key) => {
      const was = from && key in from ? from[key] : undefined;
      const now = to && key in to ? to[key] : undefined;
      const recordedBefore = from !== null && key in from;
      return {
        key,
        label: fieldLabel(key),
        before: recordedBefore ? showValue(key, was, type) : null,
        after: showValue(key, now, type),
        changed:
          recordedBefore &&
          JSON.stringify(was ?? null) !== JSON.stringify(now ?? null),
      };
    }),
  };
}

/** A short line after the record's name, where the entry says something more. */
export function summaryOf(entry: ActivityEntry): string | null {
  const before = fieldsOf(entry.before);
  const after = fieldsOf(entry.after);
  if (!after) return null;
  for (const key of ["reason", "rejectedReason"]) {
    const value = after[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  if (entry.action === "membership.invited") {
    const role = showValue("role", after.role, entry.entity.type);
    return role.kind === "text" ? `Invited as ${role.text}` : null;
  }
  if (typeof after.noReceiptReason === "string") return "No receipt";
  if (after.pettyCash === true) return "Petty cash";
  if (
    typeof before?.name === "string" &&
    typeof after.name === "string" &&
    before.name !== after.name
  ) {
    return `Renamed from ${before.name}`;
  }
  const was = minorUnits(before?.amountKes);
  if (was && minorUnits(after.amountKes) && was !== after.amountKes) {
    return `Was KES ${formatKes(was)}`;
  }
  return null;
}

export type CalloutTone = "warn" | "error" | "neutral";

/** What the sheet calls out first: a failed payment, or a self-approval. */
export function calloutOf(entry: ActivityEntry): {
  readonly tone: CalloutTone;
  readonly title: string;
  readonly text: string;
} | null {
  const after = fieldsOf(entry.after);
  if (!after) return null;
  if (after.status === "payout_failed" || entry.action === "payout.failed") {
    return {
      tone: "error",
      title: "Payment failed",
      text:
        typeof after.reason === "string"
          ? after.reason
          : "The payment didn't go through.",
    };
  }
  if (after.selfApproval === true) {
    return {
      tone: "warn",
      title: "Self-approved",
      text: `${describeActor(entry.actor)} approved their own expense. It's flagged here and in the monthly export.`,
    };
  }
  return null;
}

export const isSelfApproved = (entry: ActivityEntry): boolean =>
  fieldsOf(entry.after)?.selfApproval === true;

export function isPossibleDuplicate(entry: ActivityEntry): boolean {
  const warnings = fieldsOf(entry.after)?.warnings;
  return Array.isArray(warnings) && warnings.includes("near_duplicate");
}

/**
 * One row of the log: an entry, or every entry one passkey approval made
 * (each bill paid together, and the payments behind them).
 */
export interface ActivityRow {
  /** The newest entry's ID, for `?id=`. */
  readonly id: string;
  readonly entries: readonly ActivityEntry[];
  /** What the row is about; payments are folded into the bills or expenses they paid. */
  readonly subjects: readonly ActivityEntry[];
  readonly approvalId: string | null;
}

export function groupRows(entries: readonly ActivityEntry[]): ActivityRow[] {
  const groups: ActivityEntry[][] = [];
  const byApproval = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const group = entry.approvalId
      ? byApproval.get(entry.approvalId)
      : undefined;
    if (group) {
      group.push(entry);
      continue;
    }
    const fresh = [entry];
    groups.push(fresh);
    if (entry.approvalId) byApproval.set(entry.approvalId, fresh);
  }
  return groups.map((group) => {
    const [first] = group;
    const subjects = group.filter((entry) => entry.entity.type !== "payout");
    return {
      id: first?.id ?? "",
      entries: group,
      subjects: subjects.length > 0 ? subjects : group,
      approvalId: first?.approvalId ?? null,
    };
  });
}

const PLURALS: Readonly<Record<string, string>> = {
  bill: "bills",
  expense: "expenses",
  float: "petty cash payments",
  payroll_run: "payroll runs",
  payout: "payments",
};

/** e.g. "9 bills"; null for a row about one record. */
export function batchCount(row: ActivityRow): string | null {
  if (row.subjects.length < 2) return null;
  const types = new Set(row.subjects.map((entry) => entry.entity.type));
  const [type = "payout"] = [...types];
  const noun = types.size === 1 ? (PLURALS[type] ?? "records") : "payments";
  return `${String(row.subjects.length)} ${noun}`;
}

/** The row's title: the shared action, or what a mixed approval did. */
export function rowTitle(row: ActivityRow): string {
  const actions = new Set(row.subjects.map((entry) => entry.action));
  const [action = ""] = [...actions];
  return actions.size === 1 ? describeAction(action) : "Payments approved";
}

/** A batch's record names: "Jubilee Health and Google Workspace", "A, B and 7 more". */
export function batchNames(row: ActivityRow): string {
  const names = row.subjects.map(
    (entry) => recordName(entry.entity).split(", ")[0] ?? "",
  );
  return names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, 2).join(", ")} and ${String(names.length - 2)} more`;
}

/** The muted line under a row's title. At most one middle dot. */
export function rowMeta(row: ActivityRow): string {
  const [lead] = row.subjects;
  if (!lead) return "";
  if (row.subjects.length > 1) return batchNames(row);
  return [recordName(lead.entity), summaryOf(lead)]
    .filter((part) => part !== null && part !== "")
    .join(" · ");
}

/** "Pick a record" filter value: `bill:<id>`. */
export const recordKey = (entity: ActivityEntry["entity"]): string | null =>
  entity.id ? `${entity.type}:${entity.id}` : null;

export function parseRecordKey(
  key: string | null,
): { readonly type: string; readonly id: string } | null {
  if (!key) return null;
  const at = key.indexOf(":");
  if (at <= 0 || at === key.length - 1) return null;
  const type = key.slice(0, at);
  return /^[a-z][a-z_]{0,49}$/.test(type)
    ? { type, id: key.slice(at + 1) }
    : null;
}

/** Nairobi's calendar day of `now`, as `YYYY-MM-DD`. */
export function nairobiToday(now: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Nairobi",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

const addDays = (isoDate: string, days: number) =>
  new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);

function monthRange(year: number, monthIndex: number) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const last = new Date(Date.UTC(year, monthIndex + 1, 0));
  return {
    value: first.toISOString().slice(0, 7),
    label: `${MONTHS[first.getUTCMonth()] ?? ""} ${String(first.getUTCFullYear())}`,
    from: first.toISOString().slice(0, 10),
    to: last.toISOString().slice(0, 10),
  };
}

export interface DatePreset {
  readonly value: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
}

/** Today, yesterday, the last 7 days and the last three months; both days included. */
export function datePresets(today: string): readonly DatePreset[] {
  const [year = 1970, month = 1] = today.split("-").map(Number);
  return [
    { value: "today", label: "Today", from: today, to: today },
    {
      value: "yesterday",
      label: "Yesterday",
      from: addDays(today, -1),
      to: addDays(today, -1),
    },
    { value: "7d", label: "Last 7 days", from: addDays(today, -6), to: today },
    monthRange(year, month - 1),
    monthRange(year, month - 2),
    monthRange(year, month - 3),
  ];
}

const shortDay = (isoDate: string) =>
  formatIsoDate(isoDate).replace(/ \d{4}$/, "");

/** The date chip's text: a preset's name, or the days chosen. */
export function dateRangeLabel(
  from: string | null,
  to: string | null,
  presets: readonly DatePreset[],
): string | null {
  if (!from && !to) return null;
  const preset = presets.find((p) => p.from === from && p.to === to);
  if (preset) return preset.label;
  if (from && to) {
    if (from === to) return formatIsoDate(from);
    return from.slice(0, 4) === to.slice(0, 4)
      ? `${shortDay(from)} to ${formatIsoDate(to)}`
      : `${formatIsoDate(from)} to ${formatIsoDate(to)}`;
  }
  return from
    ? `From ${formatIsoDate(from)}`
    : `Until ${formatIsoDate(to ?? "")}`;
}
