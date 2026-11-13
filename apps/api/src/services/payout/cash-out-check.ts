import type { CashOutProvider } from "../cash-out/provider.js";
import type { KesRecipient } from "../paycrest/recipient.js";
import { bankByCode, providerCanPayBank } from "../cash-out/banks.js";
import { cashOutLimits } from "../cash-out/quote.js";
import { MIN_ORDER_USDC } from "../paycrest/quote.js";
import {
  InvalidRecipient,
  PAYOUT_MEMO,
  toPaycrestRecipient,
} from "../paycrest/recipient.js";
import {
  NotAPretiumCashOut,
  toPretiumRecipient,
} from "../pretium/recipient.js";

export const BANK_UNAVAILABLE =
  "That bank can't be paid right now. Choose another bank or another way to pay.";

export const UNKNOWN_BANK =
  "We don't know that bank. Choose one from the list.";

/**
 * Why `provider` can't pay `recipient`, in words for the company's admin
 * (they never see provider names), or null when it can. Banks are checked
 * against Expendi's catalogue, never a provider's live list.
 */
export function cashOutRecipientProblem(
  provider: CashOutProvider,
  recipient: KesRecipient,
): string | null {
  try {
    toPaycrestRecipient(recipient, PAYOUT_MEMO);
  } catch (error) {
    if (error instanceof InvalidRecipient) return error.message;
    throw error;
  }
  if (recipient.method === "bank") {
    if (bankByCode(recipient.bankCode) === null) return UNKNOWN_BANK;
    if (!providerCanPayBank(provider, recipient.bankCode)) {
      return BANK_UNAVAILABLE;
    }
  }
  if (provider === "pretium") {
    try {
      toPretiumRecipient(recipient);
    } catch (error) {
      if (error instanceof InvalidRecipient) return error.message;
      if (error instanceof NotAPretiumCashOut) return BANK_UNAVAILABLE;
      throw error;
    }
  }
  return null;
}

/**
 * Whether `provider` takes a cash-out of `amountKes`. Paycrest's minimum
 * is 0.5 USDC, so it is judged on the USDC the cash-out was priced at.
 */
export function withinCashOutLimits(
  provider: CashOutProvider,
  amountKes: bigint,
  quotedUsdc: bigint,
): boolean {
  const { minKesCents, maxKesCents } = cashOutLimits(provider);
  if (amountKes > maxKesCents) return false;
  return minKesCents === null
    ? quotedUsdc >= MIN_ORDER_USDC
    : amountKes >= minKesCents;
}
