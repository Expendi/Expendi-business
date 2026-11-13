import type {
  PaidFromAccountKind,
  PayoutStatus,
  WalletHistoryItem,
} from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { shortAddress } from "~/features/chain-display";
import { formatKes, formatUsdc } from "~/lib/money";

/**
 * How the Accounts page words and groups the wallet's ledger. The wording
 * is the app's (`apps/mobile/src/features/wallet/history-display.ts`);
 * days and times are Nairobi's, whatever the browser's time zone.
 */

const NAIROBI_DAY = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Africa/Nairobi",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const NAIROBI_TIME = new Intl.DateTimeFormat("en-US", {
  timeZone: "Africa/Nairobi",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

/** The Nairobi calendar day of a moment, `YYYY-MM-DD`. */
export function nairobiDay(at: Date | string): string {
  const parts = Object.fromEntries(
    NAIROBI_DAY.formatToParts(new Date(at)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.year ?? ""}-${parts.month ?? ""}-${parts.day ?? ""}`;
}

/** A moment's Nairobi time, e.g. "9:20 AM". */
export function nairobiTime(at: string): string {
  const parts = Object.fromEntries(
    NAIROBI_TIME.formatToParts(new Date(at)).map((part) => [
      part.type,
      part.value,
    ]),
  );
  return `${parts.hour ?? ""}:${parts.minute ?? ""} ${parts.dayPeriod ?? ""}`;
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** "2026-11-05" → "5 Nov". */
export function dayMonth(day: string): string {
  const date = new Date(`${day}T00:00:00Z`);
  return `${String(date.getUTCDate())} ${MONTHS[date.getUTCMonth()] ?? ""}`;
}

/** "Today", "Yesterday", or e.g. "Wednesday 4 Nov". */
export function dayHeading(day: string, today: string): string {
  if (day === today) return "Today";
  if (day === addDays(today, -1)) return "Yesterday";
  const weekday = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()] ?? "";
  return `${weekday} ${dayMonth(day)}`;
}

/** "5 Nov", with the year once it isn't this one: "5 Nov 2025". */
function dayInYear(day: string, today: string): string {
  const year = day.slice(0, 4);
  return year === today.slice(0, 4)
    ? dayMonth(day)
    : `${dayMonth(day)} ${year}`;
}

/** When a row happened, e.g. "Today, 9:20 AM" or "5 Nov, 4:42 PM". */
export function happenedAt(at: string, today: string): string {
  const day = nairobiDay(at);
  const heading = dayHeading(day, today);
  const date =
    heading === "Today" || heading === "Yesterday"
      ? heading
      : dayInYear(day, today);
  return `${date}, ${nairobiTime(at)}`;
}

/** A ledger row's time today, and its date too once the day has passed: "9:20 AM", "5 Nov, 4:42 PM". */
export function movedAt(at: string, today: string): string {
  const day = nairobiDay(at);
  return day === today
    ? nairobiTime(at)
    : `${dayInYear(day, today)}, ${nairobiTime(at)}`;
}

/** "+6,000.00" for money in, "−1,441.86" for money out. */
export function signedUsdc(baseUnits: string): string {
  const formatted = formatUsdc(baseUnits);
  return formatted.startsWith("-") ? `−${formatted.slice(1)}` : `+${formatted}`;
}

/** Whole USDC and its cents apart, so the cents can be muted: ["16,420", ".80"]. */
export function splitUsdc(baseUnits: string): readonly [string, string] {
  const formatted = formatUsdc(baseUnits);
  const point = formatted.indexOf(".");
  return point < 0
    ? [formatted, ""]
    : [formatted.slice(0, point), formatted.slice(point)];
}

/** The most that can be withdrawn as typed text, rounded down to the cent. */
export function maxWithdrawal(baseUnits: string): string {
  const units = BigInt(baseUnits);
  const whole = units / 1_000_000n;
  const cents = (units % 1_000_000n) / 10_000n;
  return `${whole.toString()}.${cents.toString().padStart(2, "0")}`;
}

export type TxKind =
  | "deposit"
  | "topup"
  | "withdrawal"
  | "refund"
  | "payment"
  | "salary"
  | "to_treasury"
  | "from_treasury";

export function txKind(item: WalletHistoryItem): TxKind {
  if (item.type === "payout") {
    return item.payout?.payrollRunId ? "salary" : "payment";
  }
  return item.type;
}

export function txTitle(item: WalletHistoryItem): string {
  switch (txKind(item)) {
    case "deposit":
      return "Deposit";
    case "topup":
      return "Top-up";
    case "withdrawal":
      return "Withdrawal";
    case "refund":
      return "Refund";
    case "to_treasury":
      return "Moved to Treasury";
    case "from_treasury":
      return "Moved to wallet";
    case "payment":
    case "salary":
      return item.payout?.recipientName ?? "Payment";
  }
}

/** What a payment was for, from what it pays. */
export function payoutPurpose(item: WalletHistoryItem): string | null {
  const payout = item.payout;
  if (!payout) return null;
  if (payout.payrollRunId) return "Payroll";
  switch (payout.subjectType) {
    case "claim":
      return "Reimbursement";
    case "bill":
      return "Bill";
    case "float":
      return "Petty cash float";
    case "withdrawal":
      return null;
  }
}

/** The muted line under a row's title. */
export function txDetail(item: WalletHistoryItem): string {
  const payout = item.payout;
  switch (txKind(item)) {
    case "deposit":
    case "topup":
      return item.counterpartyAddress
        ? `From ${shortAddress(item.counterpartyAddress)}`
        : "Money in";
    case "withdrawal":
      return payout ? `To ${payout.recipientName}` : "To an allowed address";
    case "refund":
      return payout
        ? `${payout.recipientName} payment failed, money returned`
        : "A payment failed, money returned";
    case "to_treasury":
      return "To Treasury";
    case "from_treasury":
      return "From Treasury";
    case "payment":
    case "salary": {
      if (!payout) return "Payment";
      const purpose = payoutPurpose(item);
      const kes = `KES ${formatKes(payout.amountKesCents)}`;
      return purpose ? `${kes} · ${purpose}` : kes;
    }
  }
}

export interface PayoutBadge {
  readonly label: string;
  readonly tone: StatusTone;
}

/** The app's payout wording. */
export const PAYOUT_STATUS: Record<PayoutStatus, PayoutBadge> = {
  awaiting_approval: { label: "Waiting for approval", tone: "waiting" },
  approved: { label: "Approved", tone: "moving" },
  order_created: { label: "Sending", tone: "moving" },
  funding: { label: "Sending", tone: "moving" },
  paying: { label: "On its way", tone: "moving" },
  paid: { label: "Paid", tone: "paid" },
  failed: { label: "Failed", tone: "failed" },
  needs_review: { label: "Being checked", tone: "waiting" },
};

/**
 * The badge a row shows, in the Bills table's tints: a payment or
 * withdrawal by where it has got to, green once the money has settled.
 */
export function rowBadge(item: WalletHistoryItem): PayoutBadge | null {
  // The company's own money moving between its wallet and Treasury: neither
  // received from outside nor paid to anyone.
  if (item.type === "to_treasury" || item.type === "from_treasury") {
    return { label: "Moved", tone: "quiet" };
  }
  if (item.type !== "payout" && item.type !== "withdrawal") {
    return { label: "Received", tone: "paid" };
  }
  const status = item.payout?.status;
  if (!status) return null;
  if (status !== "paid") return PAYOUT_STATUS[status];
  return {
    label: item.type === "withdrawal" ? "Sent" : "Paid",
    tone: "paid",
  };
}

export type HistoryFilter = "all" | "in" | "out";

export function filterHistory(
  items: readonly WalletHistoryItem[],
  filter: HistoryFilter,
): WalletHistoryItem[] {
  if (filter === "all") return [...items];
  return items.filter((item) =>
    filter === "in"
      ? BigInt(item.usdcAmount) > 0n
      : BigInt(item.usdcAmount) < 0n,
  );
}

export interface HistoryDay {
  readonly day: string;
  readonly items: readonly WalletHistoryItem[];
}

/** Newest first, as the API sends them, under their Nairobi day. */
export function groupByDay(items: readonly WalletHistoryItem[]): HistoryDay[] {
  const days: { day: string; items: WalletHistoryItem[] }[] = [];
  for (const item of items) {
    const day = nairobiDay(item.createdAt);
    const last = days.at(-1);
    if (last?.day === day) last.items.push(item);
    else days.push({ day, items: [item] });
  }
  return days;
}

/**
 * Money in and out this Nairobi month, USDC base units: out is negative.
 * A move to or from Treasury is neither: the money stays the company's own.
 */
export function monthFlows(
  items: readonly WalletHistoryItem[],
  month: string,
): { readonly in: string; readonly out: string } {
  let moneyIn = 0n;
  let moneyOut = 0n;
  for (const item of items) {
    if (!nairobiDay(item.createdAt).startsWith(month)) continue;
    if (item.type === "to_treasury" || item.type === "from_treasury") continue;
    const amount = BigInt(item.usdcAmount);
    if (amount > 0n) moneyIn += amount;
    else moneyOut += amount;
  }
  return { in: moneyIn.toString(), out: moneyOut.toString() };
}

export interface DailyBalance {
  readonly day: string;
  /** USDC base units at the end of the day. */
  readonly units: string;
}

/**
 * The balance at the end of each of the last `days` days up to today,
 * oldest first: walked back from today's balance through the ledger.
 */
export function dailyBalances(
  balance: string,
  items: readonly WalletHistoryItem[],
  today: string,
  days = 31,
): DailyBalance[] {
  const moved = new Map<string, bigint>();
  for (const item of items) {
    const day = nairobiDay(item.createdAt);
    moved.set(day, (moved.get(day) ?? 0n) + BigInt(item.usdcAmount));
  }
  const series: DailyBalance[] = [];
  let running = BigInt(balance);
  for (let back = 0; back < days; back += 1) {
    const day = addDays(today, -back);
    series.push({ day, units: running.toString() });
    running -= moved.get(day) ?? 0n;
  }
  return series.reverse();
}

/** How many other payments were approved with the same passkey confirmation. */
export function approvedAlongside(
  item: WalletHistoryItem,
  items: readonly WalletHistoryItem[],
): number {
  const approvalId = item.payout?.approvalId;
  if (!approvalId) return 0;
  const others = new Set(
    items
      .filter(
        (other) =>
          other.type === "payout" &&
          other.payout?.approvalId === approvalId &&
          other.payout.id !== item.payout?.id,
      )
      .map((other) => other.payout?.id),
  );
  return others.size;
}

export const PAID_FROM_KIND_LABELS: Record<PaidFromAccountKind, string> = {
  bank: "Bank account",
  card: "Card",
  mobile_money: "Mobile money",
  cash: "Cash",
  other: "Other",
};
