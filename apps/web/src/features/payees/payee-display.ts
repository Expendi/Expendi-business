import type {
  Payee,
  PayeeDetails,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  PAYEE_CHANGE_HOLD_HOURS,
  PAYEE_METHODS,
} from "@expendi-business/shared";

import type { DetailField } from "./payee-fields";
import { detailValues, fieldLabel, methodFields } from "./payee-fields";

/**
 * From `apps/mobile/src/features/payees/payee-display.ts`. The dashboard
 * shows payment details as the API returns them, unmasked: admins and
 * accountants check them against invoices on a big screen.
 */

export const KIND_LABELS: Record<PayeeKind, string> = {
  employee: "Employee",
  personnel: "Other personnel",
  supplier: "Supplier",
  vendor: "Subscription vendor",
  statutory: "Statutory body",
};

export const KIND_DESCRIPTIONS: Record<PayeeKind, string> = {
  employee: "Someone in your team on Expendi.",
  personnel: "Paid by the company but not on the app, e.g. casual workers.",
  supplier: "A business you buy goods or services from.",
  vendor: "A subscription or service you pay regularly.",
  statutory: "KRA, NSSF, SHA and other statutory payments.",
};

export const METHOD_LABELS: Record<PayeeMethod, string> = {
  mpesa_phone: "M-Pesa number",
  mpesa_till: "M-Pesa Till",
  mpesa_paybill: "M-Pesa Paybill",
  bank: "Bank account",
  usdc: "USDC wallet",
  outside: "Paid outside Expendi",
};

export const METHOD_DESCRIPTIONS: Record<PayeeMethod, string> = {
  mpesa_phone: "Sent to a personal M-Pesa number.",
  mpesa_till: "Buy Goods: a business Till number.",
  mpesa_paybill: "A business number and an account number.",
  bank: "A Kenyan bank account.",
  usdc: "USDC on Base, to an address on the company's allowlist.",
  outside: "Paid by card or elsewhere. Expendi only sends reminders.",
};

export const CHANGE_WARNING =
  "Changing payment details is the most common payment fraud. Every admin will get an email.";

export const RECENTLY_CHANGED_LABEL = "Details changed in the last 24 hours";

const HOLD_MS = PAYEE_CHANGE_HOLD_HOURS * 60 * 60_000;

/** `0x1234…abcd`: enough to recognise an address at a glance. */
export function shortAddress(address: string): string {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : address;
}

/** Employee payees are paid to the number they confirmed in the app. */
function confirmedNumber(payoutPhoneConfirmed: boolean | null): string {
  return payoutPhoneConfirmed === false
    ? "Their confirmed number (not confirmed yet)"
    : "Their confirmed number";
}

/** The method's main detail, e.g. "522522, account KP-1182"; null when it has none. */
export function detailSummary(
  details: PayeeDetails,
  payoutPhoneConfirmed: boolean | null,
  bankName: string | null,
): string | null {
  switch (details.method) {
    case "mpesa_phone":
      return details.phone ?? confirmedNumber(payoutPhoneConfirmed);
    case "mpesa_till":
      return details.tillNumber;
    case "mpesa_paybill":
      return `${details.paybillNumber}, account ${details.accountReference}`;
    case "bank":
      return `${bankName ?? details.bankCode} ${details.accountNumber}`;
    case "usdc":
      return shortAddress(details.address);
    case "outside":
      return null;
  }
}

/** One line for the payee list: the method and its main detail. */
export function listSummary(
  payee: Pick<Payee, "details" | "payoutPhoneConfirmed">,
  bankName: string | null,
): string {
  const { details } = payee;
  if (!details) return "No payment details yet";
  const detail = detailSummary(details, payee.payoutPhoneConfirmed, bankName);
  return detail === null
    ? METHOD_LABELS[details.method]
    : `${METHOD_LABELS[details.method]} · ${detail}`;
}

/**
 * Whether the details changed within the 24 hours before `asOf` (epoch
 * ms), when paying the payee needs a second confirmation (spec §6.19).
 */
export function changedRecently(
  detailsChangedAt: string | null,
  asOf: number,
): boolean {
  if (detailsChangedAt === null) return false;
  const changedAt = Date.parse(detailsChangedAt);
  return !Number.isNaN(changedAt) && asOf - changedAt < HOLD_MS;
}

export interface DetailRow {
  readonly label: string;
  readonly value: string;
}

/** The details as labelled rows, each value as the API returned it. */
export function detailRows(
  details: PayeeDetails,
  {
    bankName,
    payoutPhoneConfirmed,
  }: {
    readonly bankName: string | null;
    readonly payoutPhoneConfirmed: boolean | null;
  },
): DetailRow[] {
  const values = detailValues(details);
  const display = (field: DetailField): string => {
    const value = values[field];
    if (value === undefined) return confirmedNumber(payoutPhoneConfirmed);
    return field === "bankCode" ? (bankName ?? value) : value;
  };
  return [
    { label: "Paid by", value: METHOD_LABELS[details.method] },
    ...methodFields(details.method).map((field) => ({
      label: fieldLabel(details.method, field),
      value: display(field),
    })),
  ];
}

/** Case-insensitive match on the name; an empty search matches everything. */
export function matchesSearch(name: string, search: string): boolean {
  const query = search.trim().toLocaleLowerCase();
  return query === "" || name.toLocaleLowerCase().includes(query);
}

/** "Employee · brian@mwangaza.co.ke", or the kind alone. */
export function payeeMetaLine(payee: Pick<Payee, "kind" | "member">): string {
  return payee.kind === "employee" && payee.member
    ? `${KIND_LABELS.employee} · ${payee.member.email}`
    : KIND_LABELS[payee.kind];
}

/** People get a round mark; businesses a square one. */
export function isPerson(payee: Pick<Payee, "kind">): boolean {
  return payee.kind === "employee" || payee.kind === "personnel";
}

const NAIROBI_TIME = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** An API timestamp's Nairobi wall-clock time, e.g. "16:40". */
export function formatNairobiTime(isoDateTime: string): string {
  return NAIROBI_TIME.format(new Date(isoDateTime));
}

export type PayeeSortKey = "name" | "method" | "changed";

export const PAYEE_SORT_FIRST: Record<PayeeSortKey, "asc" | "desc"> = {
  name: "asc",
  method: "asc",
  changed: "desc",
};

const methodRank = (payee: Pick<Payee, "details">): number =>
  payee.details
    ? PAYEE_METHODS.indexOf(payee.details.method)
    : PAYEE_METHODS.length;

const changedAt = (payee: Pick<Payee, "detailsChangedAt">): number =>
  payee.detailsChangedAt ? Date.parse(payee.detailsChangedAt) : 0;

/** A to Z unless a header says otherwise; ties go A to Z. */
export function sortPayees<P extends Payee>(
  payees: readonly P[],
  sort: { readonly key: PayeeSortKey; readonly dir: "asc" | "desc" },
): P[] {
  return [...payees].sort((a, b) => {
    const byName = a.name.localeCompare(b.name);
    const primary =
      sort.key === "method"
        ? methodRank(a) - methodRank(b)
        : sort.key === "changed"
          ? changedAt(a) - changedAt(b)
          : byName;
    return (sort.dir === "asc" ? primary : -primary) || byName;
  });
}
