import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
} from "../../db/schema/index.js";

/**
 * Whether a Treasury move under review may have USDC sent back to the
 * company wallet, and how much, read from the move's saved rows alone. It
 * imports nothing that can sign, so the staff view can say what an action
 * would do without reaching code the staff routes may not reach; the actions
 * themselves (`stranded.ts`) decide with the same functions.
 */

/** The saved rows of one move that decide a return. */
export interface MoveRows {
  readonly move: TreasuryMove;
  /** The company wallet's quotes to Treasury. */
  readonly quotes: readonly IntentQuote[];
  /** The Treasury wallet's quotes back to the company wallet. */
  readonly returns: readonly IntentQuote[];
  readonly actions: readonly TreasuryEarnAction[];
}

const COMMITTED_STATUSES: readonly IntentQuote["status"][] = [
  "quoted",
  "depositing",
  "succeeded",
  "needs_review",
];

/** What is sent or on its way: money no longer in the Treasury wallet. */
export const committedOf = (returns: readonly IntentQuote[]): bigint =>
  returns
    .filter((quote) => COMMITTED_STATUSES.includes(quote.status))
    .reduce((sum, quote) => sum + quote.amountIn, 0n);

/** What a move's parts delivered to the Treasury wallet that no deposit took. */
export function undepositedUsdc(rows: MoveRows): bigint {
  return rows.quotes
    .filter(
      (quote) =>
        quote.status === "succeeded" &&
        !rows.actions.some(
          (action) =>
            action.kind === "deposit" &&
            action.intentQuoteId === quote.id &&
            action.status === "succeeded",
        ),
    )
    .reduce((sum, quote) => sum + (quote.swappedAmountOut ?? 0n), 0n);
}

/**
 * What a move to the wallet's withdrawal delivered and the return hasn't
 * sent yet: the delivery, less every part sent or on its way. Never more
 * than the delivery, whatever the Treasury wallet holds.
 */
export function owedBackUsdc(rows: MoveRows): bigint {
  const withdrawal = rows.actions.find(
    (action) => action.kind === "withdraw" && action.status === "succeeded",
  );
  const delivered = withdrawal?.deliveredUsdc ?? null;
  if (delivered === null) return 0n;
  const owed = delivered - committedOf(rows.returns);
  return owed > 0n ? owed : 0n;
}

export type ReturnAssessment =
  | {
      readonly ok: true;
      readonly amountUsdc: bigint;
      /**
       * A return quote taken but never paid, left by an attempt that
       * didn't get as far as reopening the move: reused, not quoted again.
       */
      readonly unsentQuote: IntentQuote | null;
    }
  | { readonly ok: false; readonly message: string };

const refuse = (message: string): ReturnAssessment => ({ ok: false, message });

const isUnsent = (quote: IntentQuote) =>
  quote.status === "quoted" &&
  quote.depositStartedAt === null &&
  quote.depositTxHash === null;

const returnInFlight = (returns: readonly IntentQuote[]) =>
  returns.some((quote) =>
    ["quoted", "depositing", "needs_review"].includes(quote.status),
  );

/**
 * Where the move should be when judged: under review when staff approve,
 * `open` when the job carries the approval out (staff reopened it).
 */
export interface AssessOptions {
  readonly reopened?: boolean;
}

const wrongStatus = (move: MoveRows["move"], options: AssessOptions) =>
  move.status !== (options.reopened ? "open" : "needs_review");

/** A move to Treasury whose deposit Privy rejected, for `returnStrandedDeposit`. */
export function assessStranded(
  rows: MoveRows,
  options: AssessOptions = {},
): ReturnAssessment {
  const { move } = rows;
  if (move.direction !== "to_treasury") {
    return refuse("Only a move to Treasury can have a stranded deposit.");
  }
  if (wrongStatus(move, options)) {
    return refuse("The move isn't waiting for review, so nothing is stranded.");
  }
  if (
    rows.actions.some((action) =>
      ["saved", "pending", "failed"].includes(action.status),
    ) ||
    rows.quotes.some((quote) =>
      ["quoted", "depositing", "needs_review"].includes(quote.status),
    )
  ) {
    return refuse(
      "A deposit or a transfer of this move may still be in flight or reverted. Check it before sending anything back.",
    );
  }
  if (
    !rows.actions.some(
      (action) => action.kind === "deposit" && action.status === "rejected",
    )
  ) {
    return refuse(
      "Privy didn't reject a deposit of this move, so its USDC isn't known to be stranded. Check why it is under review first.",
    );
  }
  const amountUsdc = undepositedUsdc(rows);
  if (amountUsdc <= 0n) {
    return refuse("This move has no undeposited USDC to send back.");
  }
  return { ok: true, amountUsdc, unsentQuote: null };
}

/**
 * A move to the wallet whose withdrawal delivered but whose return didn't
 * finish, for `resumeToWalletReturn`: refused unless the delivery is known,
 * none of its return quotes may still be moving or is unclear, and some of
 * the delivery is still owed.
 */
export function assessResume(
  rows: MoveRows,
  options: AssessOptions = {},
): ReturnAssessment {
  const { move } = rows;
  if (move.direction !== "to_wallet") {
    return refuse("Only a move to the wallet can resume its return.");
  }
  if (wrongStatus(move, options)) {
    return refuse(
      "The move isn't waiting for review, so there is nothing to resume.",
    );
  }
  const withdrawal = rows.actions.find((action) => action.kind === "withdraw");
  if (withdrawal?.status !== "succeeded" || withdrawal.deliveredUsdc === null) {
    return refuse(
      "The withdrawal's delivery isn't confirmed, so there is nothing known to send back. Check the Treasury wallet and the vault first.",
    );
  }
  const unsentQuote = rows.returns.filter(isUnsent).at(-1) ?? null;
  const returns = rows.returns.filter((quote) => !isUnsent(quote));
  if (returnInFlight(returns)) {
    return refuse(
      "A part of the return may still be in flight or its outcome is unclear. Check it before sending anything more.",
    );
  }
  const amountUsdc = owedBackUsdc({ ...rows, returns });
  if (amountUsdc <= 0n) {
    return refuse(
      "Everything the withdrawal delivered has been sent. Check the company wallet's deposits instead.",
    );
  }
  return { ok: true, amountUsdc, unsentQuote };
}
