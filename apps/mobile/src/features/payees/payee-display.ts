import type {
  Payee,
  PayeeDetails,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import { PAYEE_CHANGE_HOLD_HOURS } from "@expendi-business/shared";

import type { DetailField } from "./payee-fields";
import { shortAddress } from "../wallet/usdc-amount";
import { detailValues, fieldLabel, methodFields } from "./payee-fields";

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

const MASK = "••••";
const HOLD_MS = PAYEE_CHANGE_HOLD_HOURS * 60 * 60_000;
const MASKED_FIELDS: ReadonlySet<DetailField> = new Set([
  "phone",
  "accountReference",
  "accountNumber",
]);

/** `•••• 5678`; values of 4 characters or fewer are hidden entirely. */
export function lastFour(value: string): string {
  return value.length > 4 ? `${MASK} ${value.slice(-4)}` : MASK;
}

/** Employee payees are paid to the number they confirmed in the app. */
function confirmedNumber(payoutPhoneConfirmed: boolean | null): string {
  return payoutPhoneConfirmed === false
    ? "Their confirmed number (not confirmed yet)"
    : "Their confirmed number";
}

function maskedDetail(
  details: PayeeDetails,
  payoutPhoneConfirmed: boolean | null,
  bankName: string | null,
): string | null {
  switch (details.method) {
    case "mpesa_phone":
      return details.phone === undefined
        ? confirmedNumber(payoutPhoneConfirmed)
        : lastFour(details.phone);
    case "mpesa_till":
      return details.tillNumber;
    case "mpesa_paybill":
      return `${details.paybillNumber}, account ${lastFour(details.accountReference)}`;
    case "bank":
      return `${bankName ?? details.bankCode} ${lastFour(details.accountNumber)}`;
    case "usdc":
      return shortAddress(details.address);
    case "outside":
      return null;
  }
}

/**
 * One line for the payee list: the method and a masked detail. Never a
 * full phone or account number.
 */
export function listSummary(
  payee: Pick<Payee, "details" | "payoutPhoneConfirmed">,
  bankName: string | null,
): string {
  const { details } = payee;
  if (!details) return "No payment details yet";
  const detail = maskedDetail(details, payee.payoutPhoneConfirmed, bankName);
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

interface DetailRowOptions {
  /** Hides all but the last 4 characters of phone and account numbers. */
  readonly mask: boolean;
  readonly bankName: string | null;
  readonly payoutPhoneConfirmed: boolean | null;
}

/**
 * The details as labelled rows. Unmasked for the review the admin confirms
 * with their passkey; masked everywhere else. Till and Paybill business
 * numbers and Base addresses are public, so they're never masked.
 */
export function detailRows(
  details: PayeeDetails,
  { mask, bankName, payoutPhoneConfirmed }: DetailRowOptions,
): DetailRow[] {
  const values = detailValues(details);
  const display = (field: DetailField): string => {
    const value = values[field];
    if (value === undefined) return confirmedNumber(payoutPhoneConfirmed);
    if (field === "bankCode") return bankName ?? value;
    return mask && MASKED_FIELDS.has(field) ? lastFour(value) : value;
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
