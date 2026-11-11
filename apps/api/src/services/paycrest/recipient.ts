/**
 * Every KES payment method a payee can have (spec §6.19), and how each maps
 * onto a Paycrest recipient. M-Pesa numbers, Tills and Paybills all go to
 * Safaricom M-Pesa (`SAFAKEPC`), told apart by `metadata.channel`; a bank is
 * its institution code from Paycrest's KES list.
 */

import type { PayeeChain } from "@expendi-business/shared";

export const MPESA_INSTITUTION = "SAFAKEPC";

/** What every Paycrest recipient sees as the payment's description. */
export const PAYOUT_MEMO = "Expendi Business payout";

export type KesRecipient =
  | {
      readonly method: "mpesa_phone";
      /** E.164, a confirmed Kenyan number (spec §6.18), e.g. +254712345678. */
      readonly phone: string;
      readonly accountName: string;
    }
  | {
      readonly method: "mpesa_till";
      readonly tillNumber: string;
      readonly accountName: string;
    }
  | {
      readonly method: "mpesa_paybill";
      readonly paybillNumber: string;
      readonly accountReference: string;
      readonly accountName: string;
    }
  | {
      readonly method: "bank";
      /** A `code` from GET /institutions/KES with type "bank". */
      readonly bankCode: string;
      readonly accountNumber: string;
      readonly accountName: string;
    };

export type KesMethod = KesRecipient["method"];

/** A USDC payee: paid in USDC to an allowlisted address on its payee chain. */
export interface UsdcRecipient {
  readonly method: "usdc";
  readonly chain: PayeeChain;
  /**
   * An address on the company's allowlist, as the allowlist stores it: a
   * Base address lowercased, a NEAR account or Solana address unchanged.
   */
  readonly address: string;
  readonly accountName: string;
}

export type PayoutRecipient = KesRecipient | UsdcRecipient;

export type PaycrestChannel = "Mobile" | "Till" | "Paybill";

export interface PaycrestRecipient {
  readonly institution: string;
  readonly accountIdentifier: string;
  readonly accountName: string;
  readonly memo: string;
  readonly metadata?: {
    readonly channel: PaycrestChannel;
    readonly businessNumber?: string;
  };
}

export class InvalidRecipient extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecipient";
  }
}

const KENYAN_MOBILE = /^\+254[17]\d{8}$/;
const SHORT_CODE = /^\d{5,7}$/;
const BANK_ACCOUNT = /^[0-9A-Za-z]{5,20}$/;
const ACCOUNT_REFERENCE = /^[0-9A-Za-z#\-_/ ]{1,30}$/;
const MAX_NAME_LENGTH = 160;

function requireName(name: string): string {
  const trimmed = name.trim().replace(/\s+/g, " ");
  if (trimmed.length === 0 || trimmed.length > MAX_NAME_LENGTH) {
    throw new InvalidRecipient("The recipient needs a full name");
  }
  return trimmed;
}

/**
 * The Paycrest recipient for `recipient`, or `InvalidRecipient` if a field
 * can't be right (it never reaches Paycrest then). Bank codes are checked
 * against the live institution list separately, since it can change.
 */
export function toPaycrestRecipient(
  recipient: KesRecipient,
  memo: string,
): PaycrestRecipient {
  const accountName = requireName(recipient.accountName);
  switch (recipient.method) {
    case "mpesa_phone":
      if (!KENYAN_MOBILE.test(recipient.phone)) {
        throw new InvalidRecipient("Not a Kenyan mobile number");
      }
      return {
        institution: MPESA_INSTITUTION,
        // Paycrest normalises KES numbers to this form.
        accountIdentifier: recipient.phone.slice(1),
        accountName,
        memo,
        metadata: { channel: "Mobile" },
      };
    case "mpesa_till":
      if (!SHORT_CODE.test(recipient.tillNumber)) {
        throw new InvalidRecipient("A Till number is 5 to 7 digits");
      }
      return {
        institution: MPESA_INSTITUTION,
        accountIdentifier: recipient.tillNumber,
        accountName,
        memo,
        metadata: { channel: "Till" },
      };
    case "mpesa_paybill":
      if (!SHORT_CODE.test(recipient.paybillNumber)) {
        throw new InvalidRecipient("A Paybill number is 5 to 7 digits");
      }
      if (!ACCOUNT_REFERENCE.test(recipient.accountReference.trim())) {
        throw new InvalidRecipient("The Paybill account number is invalid");
      }
      return {
        institution: MPESA_INSTITUTION,
        // The account reference alone isn't a recipient; the business
        // number says which Paybill it belongs to.
        accountIdentifier: recipient.accountReference.trim(),
        accountName,
        memo,
        metadata: {
          channel: "Paybill",
          businessNumber: recipient.paybillNumber,
        },
      };
    case "bank":
      if (!BANK_ACCOUNT.test(recipient.accountNumber)) {
        throw new InvalidRecipient("The bank account number is invalid");
      }
      if (recipient.bankCode.trim().length === 0) {
        throw new InvalidRecipient("Choose the recipient's bank");
      }
      return {
        institution: recipient.bankCode,
        accountIdentifier: recipient.accountNumber,
        accountName,
        memo,
      };
  }
}
