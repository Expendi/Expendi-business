import { Effect } from "effect";

import type { PayeeDetails, PayeeKind } from "@expendi-business/shared";
import {
  EMPLOYEE_PAYEE_METHODS,
  PAYEE_CHAIN_NAMES,
} from "@expendi-business/shared";

import type { NewPayee, PayeeRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { KesRecipient } from "../paycrest/recipient.js";
import { BadRequest, Conflict } from "../../errors.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { canonicalJson } from "../approval/passkeys.js";
import { toKenyanMobile } from "../auth/phone.js";
import { bankByCode } from "../cash-out/banks.js";
import {
  INVALID_PAYEE_ADDRESS,
  normalisePayeeAddress,
} from "../chain/address.js";
import {
  InvalidRecipient,
  PAYOUT_MEMO,
  toPaycrestRecipient,
} from "../paycrest/recipient.js";
import { UNKNOWN_BANK } from "../payout/cash-out-check.js";

/**
 * A payee's payment details (spec §6.19): validated against the same rules
 * the payout engine applies, normalised so that equal details always hash
 * equally, mapped to and from the `payees` columns, and masked for the
 * audit log and emails.
 */

const collapseSpaces = (value: string) => value.trim().replace(/\s+/g, " ");

const notKenyan = new BadRequest({
  message: "Enter a Kenyan M-Pesa number, like 0712 345 678.",
});

function checkPaycrestRecipient(
  recipient: KesRecipient,
): Effect.Effect<void, BadRequest> {
  try {
    toPaycrestRecipient(recipient, PAYOUT_MEMO);
    return Effect.void;
  } catch (error) {
    if (error instanceof InvalidRecipient) {
      return Effect.fail(new BadRequest({ message: `${error.message}.` }));
    }
    throw error;
  }
}

/**
 * The details in the form they're stored and confirmed: an M-Pesa number in
 * E.164, a USDC address as its payee chain writes it (a Base address
 * lowercased and checked against its EIP-55 checksum), names with single
 * spaces. Applying it twice changes nothing.
 * Whether the payee's kind allows them is `checkDetailsForKind`.
 */
export function normaliseDetails(
  details: PayeeDetails,
): Effect.Effect<PayeeDetails, BadRequest> {
  switch (details.method) {
    case "mpesa_phone": {
      const accountName = collapseSpaces(details.accountName);
      if (details.phone === undefined) {
        return Effect.succeed({ method: "mpesa_phone", accountName });
      }
      const phone = toKenyanMobile(details.phone);
      if (phone === null) return Effect.fail(notKenyan);
      const normalised = { method: "mpesa_phone", phone, accountName } as const;
      return checkPaycrestRecipient(normalised).pipe(Effect.as(normalised));
    }
    case "mpesa_till": {
      const normalised = {
        method: "mpesa_till",
        tillNumber: details.tillNumber,
        accountName: collapseSpaces(details.accountName),
      } as const;
      return checkPaycrestRecipient(normalised).pipe(Effect.as(normalised));
    }
    case "mpesa_paybill": {
      const normalised = {
        method: "mpesa_paybill",
        paybillNumber: details.paybillNumber,
        accountReference: details.accountReference.trim(),
        accountName: collapseSpaces(details.accountName),
      } as const;
      return checkPaycrestRecipient(normalised).pipe(Effect.as(normalised));
    }
    case "bank": {
      const normalised = {
        method: "bank",
        bankCode: details.bankCode.trim(),
        accountNumber: details.accountNumber,
        accountName: collapseSpaces(details.accountName),
      } as const;
      return checkPaycrestRecipient(normalised).pipe(Effect.as(normalised));
    }
    case "usdc": {
      const { chain } = details;
      const address = normalisePayeeAddress(chain, details.address);
      return address === null
        ? Effect.fail(new BadRequest({ message: INVALID_PAYEE_ADDRESS[chain] }))
        : Effect.succeed({ method: "usdc", chain, address });
    }
    case "outside":
      return Effect.succeed({ method: "outside" });
  }
}

/**
 * Employees are paid only to the M-Pesa number they confirmed by SMS, or to
 * a bank account an admin adds (spec §6.19). Everyone else paid by M-Pesa
 * needs their number on the payee.
 */
export function checkDetailsForKind(
  kind: PayeeKind,
  details: PayeeDetails,
): Effect.Effect<void, BadRequest> {
  const employee = kind === "employee";
  if (
    employee &&
    !EMPLOYEE_PAYEE_METHODS.some((method) => method === details.method)
  ) {
    return Effect.fail(
      new BadRequest({
        message:
          "An employee is paid to their confirmed M-Pesa number or to a bank account.",
      }),
    );
  }
  if (details.method !== "mpesa_phone") return Effect.void;
  if (employee && details.phone !== undefined) {
    return Effect.fail(
      new BadRequest({
        message:
          "An employee is paid to the M-Pesa number they confirmed in the app, so leave the number out.",
      }),
    );
  }
  if (!employee && details.phone === undefined) {
    return Effect.fail(new BadRequest({ message: "Enter the M-Pesa number." }));
  }
  return Effect.void;
}

/** Whether saving these details needs the admin's passkey. */
export const isPayable = (
  details: PayeeDetails | undefined,
): details is Exclude<PayeeDetails, { method: "outside" }> =>
  details !== undefined && details.method !== "outside";

/**
 * Checks a bank against Expendi's catalogue, as `preparePayouts` does, and
 * returns its name for the admins' email; null for other methods. Whether
 * the active cash-out provider can pay it is checked when a payment is
 * prepared, so a provider change never stops anyone saving a payee.
 */
export function checkBank(
  details: PayeeDetails | undefined,
): Effect.Effect<string | null, BadRequest> {
  if (details?.method !== "bank") return Effect.succeed(null);
  const bank = bankByCode(details.bankCode);
  return bank
    ? Effect.succeed(bank.name)
    : Effect.fail(new BadRequest({ message: UNKNOWN_BANK }));
}

/**
 * A USDC payee can only be an address already on the company's allowlist,
 * on the same payee chain (spec §6.19, §7). Adding it there is its own passkey-confirmed step.
 */
export function checkAllowlisted(
  tx: Transaction,
  organizationId: string,
  details: PayeeDetails | undefined,
): Effect.Effect<void, Conflict | DatabaseError> {
  if (details?.method !== "usdc") return Effect.void;
  return isAllowlisted(tx, organizationId, details).pipe(
    Effect.flatMap((listed) =>
      listed
        ? Effect.void
        : Effect.fail(
            new Conflict({
              message:
                "That address isn't on the company's allowlist. Add it under Wallet → Allowed addresses with your passkey first, then add the payee.",
            }),
          ),
    ),
  );
}

type DetailColumns = Required<
  Pick<
    NewPayee,
    | "method"
    | "phone"
    | "tillNumber"
    | "paybillNumber"
    | "accountReference"
    | "bankCode"
    | "bankAccountNumber"
    | "accountName"
    | "usdcChain"
    | "usdcAddress"
  >
>;

const NO_DETAILS: DetailColumns = {
  method: null,
  phone: null,
  tillNumber: null,
  paybillNumber: null,
  accountReference: null,
  bankCode: null,
  bankAccountNumber: null,
  accountName: null,
  usdcChain: null,
  usdcAddress: null,
};

/** Every detail column, so saving new details clears the old method's. */
export function detailColumns(
  details: PayeeDetails | undefined,
): DetailColumns {
  if (details === undefined) return NO_DETAILS;
  switch (details.method) {
    case "mpesa_phone":
      return {
        ...NO_DETAILS,
        method: details.method,
        phone: details.phone ?? null,
        accountName: details.accountName,
      };
    case "mpesa_till":
      return {
        ...NO_DETAILS,
        method: details.method,
        tillNumber: details.tillNumber,
        accountName: details.accountName,
      };
    case "mpesa_paybill":
      return {
        ...NO_DETAILS,
        method: details.method,
        paybillNumber: details.paybillNumber,
        accountReference: details.accountReference,
        accountName: details.accountName,
      };
    case "bank":
      return {
        ...NO_DETAILS,
        method: details.method,
        bankCode: details.bankCode,
        bankAccountNumber: details.accountNumber,
        accountName: details.accountName,
      };
    case "usdc":
      return {
        ...NO_DETAILS,
        method: details.method,
        usdcChain: details.chain,
        usdcAddress: details.address,
      };
    case "outside":
      return { ...NO_DETAILS, method: details.method };
  }
}

const missingColumn = (payeeId: string, column: string) =>
  new Error(`payee ${payeeId} has no ${column}`);

/**
 * The details a stored payee row holds; null until some are added. The
 * table's checks guarantee each method's columns, so a gap is a defect.
 */
export function detailsOf(row: PayeeRow): PayeeDetails | null {
  const required = (value: string | null, column: string): string => {
    if (value === null) throw missingColumn(row.id, column);
    return value;
  };
  switch (row.method) {
    case null:
      return null;
    case "mpesa_phone":
      return row.phone === null
        ? {
            method: row.method,
            accountName: required(row.accountName, "account_name"),
          }
        : {
            method: row.method,
            phone: row.phone,
            accountName: required(row.accountName, "account_name"),
          };
    case "mpesa_till":
      return {
        method: row.method,
        tillNumber: required(row.tillNumber, "till_number"),
        accountName: required(row.accountName, "account_name"),
      };
    case "mpesa_paybill":
      return {
        method: row.method,
        paybillNumber: required(row.paybillNumber, "paybill_number"),
        accountReference: required(row.accountReference, "account_reference"),
        accountName: required(row.accountName, "account_name"),
      };
    case "bank":
      return {
        method: row.method,
        bankCode: required(row.bankCode, "bank_code"),
        accountNumber: required(row.bankAccountNumber, "bank_account_number"),
        accountName: required(row.accountName, "account_name"),
      };
    case "usdc":
      if (row.usdcChain === null) throw missingColumn(row.id, "usdc_chain");
      return {
        method: row.method,
        chain: row.usdcChain,
        address: required(row.usdcAddress, "usdc_address"),
      };
    case "outside":
      return { method: row.method };
  }
}

/** The last 4 characters behind a mask; shorter values are hidden entirely. */
export function lastFour(value: string): string {
  return value.length > 4 ? `****${value.slice(-4)}` : "****";
}

/**
 * The details safe for the audit log: phone and account numbers show only
 * their last 4 characters. Till and Paybill business numbers, bank codes,
 * names and USDC addresses are public identifiers and stay whole.
 */
export function maskDetails(details: PayeeDetails): PayeeDetails {
  switch (details.method) {
    case "mpesa_phone":
      return details.phone === undefined
        ? details
        : { ...details, phone: lastFour(details.phone) };
    case "mpesa_paybill":
      return {
        ...details,
        accountReference: lastFour(details.accountReference),
      };
    case "bank":
      return { ...details, accountNumber: lastFour(details.accountNumber) };
    case "mpesa_till":
    case "usdc":
    case "outside":
      return details;
  }
}

const endingIn = (value: string) =>
  value.length > 4 ? `ending ${value.slice(-4)}` : "(hidden)";

/** One line for the admins' email, with the same masking as the audit log. */
export function describeDetails(
  details: PayeeDetails,
  bankName: string | null,
): string {
  switch (details.method) {
    case "mpesa_phone":
      return details.phone === undefined
        ? `their confirmed M-Pesa number, in the name of ${details.accountName}`
        : `M-Pesa number ${endingIn(details.phone)}, in the name of ${details.accountName}`;
    case "mpesa_till":
      return `M-Pesa Till ${details.tillNumber}, ${details.accountName}`;
    case "mpesa_paybill":
      return `M-Pesa Paybill ${details.paybillNumber}, account ${endingIn(details.accountReference)}, ${details.accountName}`;
    case "bank":
      return `${bankName ?? details.bankCode} account ${endingIn(details.accountNumber)}, in the name of ${details.accountName}`;
    case "usdc":
      return `USDC on ${PAYEE_CHAIN_NAMES[details.chain]} to ${details.address}`;
    case "outside":
      return "outside Expendi (Expendi won't pay them)";
  }
}

export const sameDetails = (
  a: PayeeDetails | null,
  b: PayeeDetails | null,
): boolean => canonicalJson(a) === canonicalJson(b);
