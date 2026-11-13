import type { PayoutRecipient } from "../paycrest/recipient.js";
import type { PretiumRecipient } from "./pretium-client.js";
import { providerBankCode } from "../cash-out/banks.js";
import { PAYOUT_MEMO, toPaycrestRecipient } from "../paycrest/recipient.js";

/** A payee Pretium can't pay: a USDC payee, or a bank it has no code for. */
export class NotAPretiumCashOut extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotAPretiumCashOut";
  }
}

/**
 * The Pretium destination for `recipient`. Throws `InvalidRecipient` for a
 * field that can't be right, by the same rules as Paycrest, and
 * `NotAPretiumCashOut` for a payee Pretium can't pay.
 */
export function toPretiumRecipient(
  recipient: PayoutRecipient,
  pretiumBankCode: (code: string) => string | null = (code) =>
    providerBankCode("pretium", code),
): PretiumRecipient {
  if (recipient.method === "usdc") {
    throw new NotAPretiumCashOut("A USDC payee isn't paid in shillings");
  }
  // A payee's details are valid or not whichever provider pays them.
  toPaycrestRecipient(recipient, PAYOUT_MEMO);
  switch (recipient.method) {
    case "mpesa_phone":
      return {
        type: "MOBILE",
        shortcode: recipient.phone.slice(1),
        mobileNetwork: "Safaricom",
      };
    case "mpesa_till":
      return { type: "BUY_GOODS", shortcode: recipient.tillNumber };
    case "mpesa_paybill":
      return {
        type: "PAYBILL",
        shortcode: recipient.paybillNumber,
        accountNumber: recipient.accountReference.trim(),
      };
    case "bank": {
      const bankCode = pretiumBankCode(recipient.bankCode);
      if (bankCode === null) {
        throw new NotAPretiumCashOut("Pretium can't pay this bank yet");
      }
      return {
        type: "BANK_TRANSFER",
        accountNumber: recipient.accountNumber,
        bankCode,
      };
    }
  }
}
