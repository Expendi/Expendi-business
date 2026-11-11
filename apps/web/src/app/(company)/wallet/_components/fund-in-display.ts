import type {
  FundInChain,
  FundInRequest,
  FundInStatus,
} from "@expendi-business/shared";
import { fundInRequestSchema } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { toUsdcBaseUnits } from "./usdc-amount";

/** How a fund-in from another chain is worded at each status. */
export const FUND_IN_STATUS: Record<
  FundInStatus,
  { readonly label: string; readonly tone: StatusTone; readonly note: string }
> = {
  awaiting_deposit: {
    label: "Waiting for your USDC",
    tone: "waiting",
    note: "Send the USDC from your wallet or exchange. This page updates by itself once it arrives.",
  },
  processing: {
    label: "On its way",
    tone: "moving",
    note: "Your USDC arrived and is on its way to the company wallet.",
  },
  completed: {
    label: "In the wallet",
    tone: "paid",
    note: "The USDC is in the company wallet and shows in the history.",
  },
  returning: {
    label: "Returning",
    tone: "moving",
    note: "It couldn't be completed, so the USDC is on its way back to your company wallet.",
  },
  returned: {
    label: "Returned",
    tone: "rejected",
    note: "It couldn't be completed, so the USDC was returned to your company wallet. It shows in History as a deposit.",
  },
  refunded: {
    label: "Refunded",
    tone: "rejected",
    note: "It couldn't be completed, so the USDC went back to the refund address you gave.",
  },
  failed: {
    label: "Failed",
    tone: "failed",
    note: "It couldn't be completed. Expendi is looking into it.",
  },
  expired: {
    label: "Expired",
    tone: "rejected",
    note: "The deadline passed with nothing sent. Start a new fund-in to get a new address.",
  },
};

export interface FundInFieldErrors {
  readonly amount?: string;
}

export type FundInDraft =
  | { readonly ok: true; readonly request: FundInRequest }
  | { readonly ok: false; readonly errors: FundInFieldErrors };

/** What the admin typed as the request the API takes, checked with its schema. */
export function fundInDraft(chain: FundInChain, amount: string): FundInDraft {
  const units = toUsdcBaseUnits(amount);
  const parsed = fundInRequestSchema.safeParse({
    chain,
    amount: units.ok ? units.baseUnits : "1",
  });
  const errors: { amount?: string } = {};
  if (!units.ok) errors.amount = units.error;
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (field === "amount") errors.amount ??= issue.message;
    }
  }
  return parsed.success && units.ok
    ? { ok: true, request: parsed.data }
    : { ok: false, errors };
}
