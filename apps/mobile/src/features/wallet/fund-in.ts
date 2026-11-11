import type {
  FundIn,
  FundInChain,
  FundInRequest,
  FundInStatus,
} from "@expendi-business/shared";
import { fundInRequestSchema } from "@expendi-business/shared";

import type { Tone } from "./history-display";
import { toUsdcBaseUnits } from "./usdc-amount";

/** How a fund-in from another chain is worded at each status. */
export const FUND_IN_STATUS: Record<
  FundInStatus,
  { readonly label: string; readonly tone: Tone; readonly note: string }
> = {
  awaiting_deposit: {
    label: "Waiting for your USDC",
    tone: "neutral",
    note: "Send the USDC from your wallet or exchange. This screen updates by itself once it arrives.",
  },
  processing: {
    label: "On its way",
    tone: "neutral",
    note: "Your USDC arrived and is on its way to the company wallet.",
  },
  completed: {
    label: "In the wallet",
    tone: "success",
    note: "The USDC is in the company wallet and shows in the wallet history.",
  },
  refunded: {
    label: "Refunded",
    tone: "warning",
    note: "It couldn’t be completed, so the USDC went back to your refund address.",
  },
  failed: {
    label: "Failed",
    tone: "warning",
    note: "It couldn’t be completed. Expendi is looking into it.",
  },
  expired: {
    label: "Expired",
    tone: "warning",
    note: "The deadline passed with nothing sent. Start a new fund-in to get a new address.",
  },
};

/** A fund-in in one of these has stopped changing. */
const FINAL_STATUSES: readonly FundInStatus[] = [
  "completed",
  "refunded",
  "failed",
  "expired",
];

export function isFinalFundIn(status: FundInStatus): boolean {
  return FINAL_STATUSES.includes(status);
}

const FUND_IN_POLL_MS = 5000;

/** How long until a fund-in is asked about again; false once it's final. */
export function fundInPollInterval(fundIn: FundIn | undefined): number | false {
  return fundIn && isFinalFundIn(fundIn.status) ? false : FUND_IN_POLL_MS;
}

export interface FundInFieldErrors {
  readonly amount?: string;
  readonly refundAddress?: string;
}

export type FundInDraft =
  | { readonly ok: true; readonly request: FundInRequest }
  | { readonly ok: false; readonly errors: FundInFieldErrors };

/**
 * What the admin typed as the request the API takes, checked with the API's
 * own schema so the refund address must be one on the chosen chain.
 */
export function fundInDraft(
  chain: FundInChain,
  amount: string,
  refundAddress: string,
): FundInDraft {
  const units = toUsdcBaseUnits(amount);
  const parsed = fundInRequestSchema.safeParse({
    chain,
    amount: units.ok ? units.baseUnits : "1",
    refundAddress,
  });
  const errors: { amount?: string; refundAddress?: string } = {};
  if (!units.ok) errors.amount = units.error;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "amount" || field === "refundAddress") {
        errors[field] ??= issue.message;
      }
    }
  }
  return parsed.success && units.ok
    ? { ok: true, request: parsed.data }
    : { ok: false, errors };
}
