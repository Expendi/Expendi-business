import type {
  PayeeDetails,
  PayeeKind,
  PayeeMethod,
} from "@expendi-business/shared";
import {
  EMPLOYEE_PAYEE_METHODS,
  PAYEE_CHAIN_NAMES,
  PAYEE_CHAINS,
  PAYEE_METHODS,
  payeeDetailsSchema,
} from "@expendi-business/shared";

/**
 * The payment-details form (spec §6.19): which fields each method asks
 * for, their labels, and turning what the admin typed into the details the
 * API takes. Field names match the keys of `payeeDetailsSchema`.
 */

export const DETAIL_FIELDS = [
  "phone",
  "tillNumber",
  "paybillNumber",
  "accountReference",
  "bankCode",
  "accountNumber",
  "accountName",
  "chain",
  "address",
] as const;

export type DetailField = (typeof DETAIL_FIELDS)[number];

export type DetailValues = Record<DetailField, string>;

export type DetailFieldErrors = Partial<Record<DetailField | "form", string>>;

export const EMPTY_DETAIL_VALUES: DetailValues = {
  phone: "",
  tillNumber: "",
  paybillNumber: "",
  accountReference: "",
  bankCode: "",
  accountNumber: "",
  accountName: "",
  chain: "near",
  address: "",
};

const METHOD_FIELDS: Record<PayeeMethod, readonly DetailField[]> = {
  mpesa_phone: ["phone", "accountName"],
  mpesa_till: ["tillNumber", "accountName"],
  mpesa_paybill: ["paybillNumber", "accountReference", "accountName"],
  bank: ["bankCode", "accountNumber", "accountName"],
  usdc: ["chain", "address"],
  outside: [],
};

const FIELD_LABELS: Record<DetailField, string> = {
  phone: "M-Pesa number",
  tillNumber: "Till number",
  paybillNumber: "Business number",
  accountReference: "Account number",
  bankCode: "Bank",
  accountNumber: "Account number",
  accountName: "Account name",
  chain: "Payee chain",
  address: "Address",
};

/** Employees can't be paid to a Till, a Paybill or a USDC wallet. */
export function methodsForKind(kind: PayeeKind): readonly PayeeMethod[] {
  return kind === "employee" ? EMPLOYEE_PAYEE_METHODS : PAYEE_METHODS;
}

/** Every field a method's details can hold. */
export function methodFields(method: PayeeMethod): readonly DetailField[] {
  return METHOD_FIELDS[method];
}

/**
 * The fields the form asks for. An employee paid by M-Pesa is paid to the
 * number they confirmed by SMS, so the form leaves the number out.
 */
export function detailFields(
  method: PayeeMethod,
  kind: PayeeKind,
): readonly DetailField[] {
  const fields = METHOD_FIELDS[method];
  return kind === "employee" && method === "mpesa_phone"
    ? fields.filter((field) => field !== "phone")
    : fields;
}

/** Tills and Paybills belong to businesses, so their account name is the business name. */
export function fieldLabel(method: PayeeMethod, field: DetailField): string {
  if (
    field === "accountName" &&
    (method === "mpesa_till" || method === "mpesa_paybill")
  ) {
    return "Business name";
  }
  return FIELD_LABELS[field];
}

/** The details' fields by name; `method` is left out. */
export function detailValues(
  details: PayeeDetails,
): Partial<Record<DetailField, string>> {
  const { method: _method, ...values } = details;
  return values;
}

/** A field's value as people read it: a payee chain by its name. */
export function displayValue(field: DetailField, value: string): string {
  if (field !== "chain") return value;
  const chain = PAYEE_CHAINS.find((candidate) => candidate === value);
  return chain ? PAYEE_CHAIN_NAMES[chain] : value;
}

/**
 * The values after the admin changes one field. An address belongs to its
 * payee chain, so choosing another chain clears it.
 */
export function changeDetailValue(
  values: DetailValues,
  field: DetailField,
  value: string,
): DetailValues {
  return field === "chain" && value !== values.chain
    ? { ...values, chain: value, address: "" }
    : { ...values, [field]: value };
}

/** The form prefilled with a payee's current details. */
export function detailsToValues(details: PayeeDetails | null): DetailValues {
  return details
    ? { ...EMPTY_DETAIL_VALUES, ...detailValues(details) }
    : EMPTY_DETAIL_VALUES;
}

export type DetailsValidation =
  | { readonly ok: true; readonly details: PayeeDetails }
  | { readonly ok: false; readonly errors: DetailFieldErrors };

function isDetailField(key: PropertyKey | undefined): key is DetailField {
  return DETAIL_FIELDS.some((field) => field === key);
}

/**
 * Checks the method's fields with the API's own schema, so the admin sees
 * the same messages the API would send. Fields of other methods are
 * ignored, so switching method keeps what was typed.
 */
export function validateDetails(
  method: PayeeMethod,
  kind: PayeeKind,
  values: DetailValues,
): DetailsValidation {
  const input: Partial<DetailValues> = {};
  for (const field of detailFields(method, kind)) input[field] = values[field];

  const parsed = payeeDetailsSchema.safeParse({ ...input, method });
  if (parsed.success) return { ok: true, details: parsed.data };

  const errors: DetailFieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = isDetailField(issue.path[0]) ? issue.path[0] : "form";
    errors[key] ??= issue.message;
  }
  return { ok: false, errors };
}
