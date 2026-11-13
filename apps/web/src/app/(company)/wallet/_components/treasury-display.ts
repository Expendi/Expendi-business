import type {
  TreasuryMoveDirection,
  TreasuryMoveRequest,
  TreasuryMoveStatus,
  TreasuryMoveSummary,
  TreasuryOffer,
  TreasuryOpenMove,
  TreasuryProgress,
  TreasuryProgressStep,
  TreasuryStatus,
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

/** The history shows this many moves at a time, so it never fills the screen. */
export const MOVES_PER_PAGE = 5;

export interface MovesPage {
  readonly rows: readonly TreasuryMoveSummary[];
  readonly page: number;
  readonly pageCount: number;
}

/**
 * The moves on one page, newest first. A page past the end reads as the last
 * one, since the list can shrink or grow while it is being looked at.
 */
export function pageOfMoves(
  moves: readonly TreasuryMoveSummary[],
  requested: number,
): MovesPage {
  const pageCount = Math.max(1, Math.ceil(moves.length / MOVES_PER_PAGE));
  const page = Math.min(Math.max(0, requested), pageCount - 1);
  const first = page * MOVES_PER_PAGE;
  return {
    rows: moves.slice(first, first + MOVES_PER_PAGE),
    page,
    pageCount,
  };
}

/**
 * What a move put where it was going, or what was asked while that isn't
 * known. A returned or failed move put nothing anywhere: its badge says so,
 * and the amount asked for is what the admin recognises.
 */
export function moveAmountShown(move: TreasuryMoveSummary): string {
  if (move.status === "returned" || move.status === "failed") {
    return move.requestedUsdc;
  }
  if (move.direction === "to_wallet") {
    return move.deliveredUsdc ?? move.movedUsdc ?? move.requestedUsdc;
  }
  return move.movedUsdc ?? move.requestedUsdc;
}

export interface MoveFact {
  readonly label: string;
  readonly value: string;
}

/**
 * What a history row keeps folded away: what was asked when less arrived
 * than the row's amount or it was all of Treasury, and what the move cost.
 * Empty when the amount on the row already says everything.
 */
export function moveFacts(move: TreasuryMoveSummary): readonly MoveFact[] {
  const short =
    move.status === "completed" &&
    BigInt(moveAmountShown(move)) < BigInt(move.requestedUsdc);
  const facts: MoveFact[] = [];
  if (move.isAll) {
    facts.push({ label: "Asked for", value: "All of Treasury" });
  } else if (short) {
    facts.push({
      label: "Asked for",
      value: `${formatUsdc(move.requestedUsdc)} USDC`,
    });
  }
  if (move.costUsdc !== null && BigInt(move.costUsdc) > 0n) {
    facts.push({ label: "Cost", value: `${formatUsdc(move.costUsdc)} USDC` });
  }
  return facts;
}

export const PROGRESS_STEP_LABELS: Record<TreasuryProgressStep["key"], string> =
  {
    leaving_wallet: "Leaving your wallet",
    on_its_way: "On its way",
    arriving: "Arriving in Treasury",
    in_treasury: "In Treasury",
    leaving_treasury: "Leaving Treasury",
    in_wallet: "Back in your wallet",
  };

/** Read out after a step's name, since the mark beside it is only a picture. */
export const PROGRESS_STATE_WORDS: Record<
  TreasuryProgressStep["state"],
  string
> = {
  done: "done",
  current: "in progress",
  waiting: "waiting",
  failed: "stopped here",
};

/** A move still open is asked about this often while someone is watching it. */
export const WATCHED_MOVE_POLL_MS = 4_000;

/** How often `GET /treasury` is asked again: while a move is open, and never after it ends. */
export function pollIntervalFor(
  status: TreasuryStatus | undefined,
  pollMs: number,
): number | false {
  return status?.status === "on" && status.openMove ? pollMs : false;
}

/**
 * Whether a move being watched is over. Only an answer read since the watch
 * began counts: one cached from before the move started also has no open
 * move, and says nothing about this one.
 */
export function moveHasEnded(
  status: TreasuryStatus | undefined,
  readAt: number,
  watchedSince: number,
  moveId: string,
): boolean {
  if (status === undefined || readAt < watchedSince) return false;
  return status.status !== "on" || status.openMove?.id !== moveId;
}

export interface MoveOutcome {
  readonly tone: "success" | "warn" | "error";
  readonly title: string;
  readonly text: string;
  readonly progress: TreasuryProgress | null;
}

const arrivedText = (move: TreasuryMoveSummary): string => {
  if (move.direction === "to_treasury") {
    return `${formatUsdc(move.movedUsdc ?? move.requestedUsdc)} USDC is in Treasury.`;
  }
  const shown = move.deliveredUsdc ?? move.movedUsdc ?? move.requestedUsdc;
  return `${formatUsdc(shown)} USDC is back in your wallet and can be spent.`;
};

/** What the sheet says once the move is over, from where it stopped. */
export function endedOutcome(move: TreasuryMoveSummary): MoveOutcome {
  const progress = move.progress ?? null;
  switch (move.status) {
    case "completed":
      return {
        tone: "success",
        title: "Move complete",
        text: arrivedText(move),
        progress,
      };
    case "returned":
      return {
        tone: "warn",
        title: "Move returned",
        text: "The move didn't go through. The USDC came back to your wallet.",
        progress,
      };
    case "needs_review":
      return {
        tone: "warn",
        title: "Being checked",
        text: "Being checked by Expendi.",
        progress,
      };
    case "failed":
    case "open":
      return {
        tone: "error",
        title: "Move didn't go through",
        text: "Nothing moved.",
        progress,
      };
  }
}

/** What the sheet says while the move runs: on its way, or being checked. */
export function runningOutcome(
  started: TreasuryMoveSummary,
  open: TreasuryOpenMove | null,
): MoveOutcome {
  const progress = open?.progress ?? null;
  if (open?.status === "needs_review") {
    return {
      tone: "warn",
      title: "Being checked",
      text: open.statusText,
      progress,
    };
  }
  const amount = started.isAll
    ? "All of Treasury"
    : `${formatUsdc(started.requestedUsdc)} USDC`;
  return {
    tone: "success",
    title: "Move started",
    text:
      started.direction === "to_treasury"
        ? `${amount} is on its way to Treasury.`
        : `${amount} is on its way to your wallet. It can be spent once it arrives.`,
    progress,
  };
}
