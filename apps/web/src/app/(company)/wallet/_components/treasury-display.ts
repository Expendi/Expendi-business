import type {
  TreasuryMoveDirection,
  TreasuryMoveRequest,
  TreasuryMoveStatus,
  TreasuryOffer,
} from "@expendi-business/shared";
import { MIN_TREASURY_MOVE_USDC } from "@expendi-business/shared";

import type { StatusTone } from "~/components/data/status-badge";
import { formatUsdc } from "~/lib/money";
import { compareBaseUnits, toUsdcBaseUnits } from "./usdc-amount";

const MIN_MOVE = MIN_TREASURY_MOVE_USDC.toString();

export const MOVE_TITLES: Record<TreasuryMoveDirection, string> = {
  to_treasury: "Move to Treasury",
  to_wallet: "Move to wallet",
};

/** The ledger's own wording for a move, as the wallet history reads it. */
export const MOVE_HISTORY_TITLES: Record<TreasuryMoveDirection, string> = {
  to_treasury: "Moved to Treasury",
  to_wallet: "Moved to wallet",
};

/** 519 → "5.19%": the vault's yearly rate to two decimals, from integer basis points. */
export function formatRate(rateBps: number): string {
  const whole = Math.floor(rateBps / 100);
  const hundredths = String(rateBps % 100).padStart(2, "0");
  return `${String(whole)}.${hundredths}%`;
}

/** "about a minute", "about 4 minutes", "about 2 hours". */
export function formatDuration(seconds: number): string {
  const minutes = Math.max(1, Math.round(seconds / 60));
  if (minutes === 1) return "about a minute";
  if (minutes < 90) return `about ${String(minutes)} minutes`;
  const hours = Math.round(minutes / 60);
  return `about ${String(hours)} hours`;
}

/** USDC as typed text, without separators: "1052.31". */
export function plainUsdc(baseUnits: string): string {
  return formatUsdc(baseUnits).replaceAll(",", "");
}

export type MoveAmount =
  | { readonly ok: true; readonly request: TreasuryMoveRequest }
  | { readonly ok: false; readonly error: string };

/**
 * What the admin typed (or the "All" choice) as the move to ask about. The
 * least is 10 USDC either way, except "all". The most is checked by the API
 * against what is available, so its own refusal is what the admin reads.
 */
export function parseMoveAmount(
  direction: TreasuryMoveDirection,
  input: string,
  all: boolean,
): MoveAmount {
  if (all) {
    return direction === "to_wallet"
      ? { ok: true, request: { direction, amountUsdc: "all" } }
      : { ok: false, error: 'Only a move to your wallet can be "all".' };
  }
  const parsed = toUsdcBaseUnits(input);
  if (!parsed.ok) return parsed;
  if (compareBaseUnits(parsed.baseUnits, MIN_MOVE) < 0) {
    return { ok: false, error: "The least you can move is 10 USDC." };
  }
  return {
    ok: true,
    request: { direction, amountUsdc: parsed.baseUnits },
  };
}

/** Where the move-to-wallet sheet starts when a short wallet's offer opens it. */
export type MovePrefill =
  | { readonly all: true; readonly amount: "" }
  | { readonly all: false; readonly amount: string };

/**
 * The offer's suggested amount as typed text. When it covers everything
 * Treasury holds, or is under the 10 USDC least, "all" is the one choice
 * that can move it.
 */
export function prefillFromOffer(offer: TreasuryOffer): MovePrefill {
  const wholeTreasury =
    compareBaseUnits(offer.suggestedUsdc, offer.inTreasuryUsdc) >= 0;
  const underLeast = compareBaseUnits(offer.suggestedUsdc, MIN_MOVE) < 0;
  return wholeTreasury || underLeast
    ? { all: true, amount: "" }
    : { all: false, amount: plainUsdc(offer.suggestedUsdc) };
}

export const MOVE_STATUS_BADGES: Record<
  TreasuryMoveStatus,
  { readonly label: string; readonly tone: StatusTone } | null
> = {
  open: { label: "On its way", tone: "moving" },
  completed: null,
  returned: { label: "Returned to wallet", tone: "waiting" },
  failed: { label: "Failed", tone: "failed" },
  needs_review: { label: "Being checked", tone: "waiting" },
};
