import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { formatUsdAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, TreasuryMove } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { QuoteDepositDeps } from "../intents/quote-deposit.js";
import type { PrivyWallets as PrivyWalletsService } from "../wallet/privy-wallets.js";
import type { Snapshot, Step, TreasuryAdvanceOptions } from "./move-state.js";
import {
  companyWalletSends,
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { advanceCompanyQuote } from "../intents/quote-deposit.js";
import { isIntentPaid } from "../intents/quote-intent.js";
import { openTreasuryQuote } from "../intents/treasury-quote.js";
import {
  ACTOR,
  advanceEarnAction,
  depositsOf,
  endMove,
  idle,
  isDeposited,
  load,
  moved,
  needsReview,
  totalsOf,
  treasuryWalletOf,
} from "./move-state.js";
import {
  carryOutReturnApproval,
  pendingReturnApproval,
  stepStranded,
} from "./stranded.js";
import { stepToWallet } from "./to-wallet.js";
import { earnVaultId } from "./turn-on.js";

export type { TreasuryAdvanceOptions } from "./move-state.js";

/**
 * Moving a company's USDC into Treasury, one part at a time
 * (docs/work/treasury/spec.md, sections 4 and 11). Every step reads the saved
 * rows and does only what they say hasn't been done, so it is safe to run
 * twice, concurrently or after a crash:
 *
 * 1. a part's `EXACT_INPUT` quote is saved (`openTreasuryQuote`);
 * 2. the gas relayer registers the deposit address and the company wallet
 *    pays it, once, through `advanceCompanyQuote`;
 * 3. the `to_treasury` debit is written once the send is known to have run;
 *    for a company whose USDC is in a confidential account there is no send
 *    on chain, so it is written when 1Click's status settles the quote
 *    (`recordIntentOutcome`);
 * 4. 1Click's status settles the quote;
 * 5. what the quote delivered, and never the Treasury wallet's whole
 *    balance, is deposited into the vault with one Privy Earn call, saved
 *    first and repeated only with the same reference;
 * 6. when the Earn action has succeeded the next part starts, or the move
 *    is complete.
 *
 * Only one Earn call is ever live per move, and a part's USDC is deposited
 * once, by unique indexes on `treasury_earn_actions`.
 */

/** Privy rejects a deposit this many times before a person looks. */
export const EARN_MAX_ATTEMPTS = 3;
/** A part's quote that expires unused is taken again this many times. */
const QUOTE_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 30_000;
/** How long a delivery may take to show in the Treasury wallet, or a refund to be credited. */
const ARRIVAL_WAIT_MS = 30 * 60_000;
/** A quote 1Click can't be asked for is retried this long before the move ends. */
const QUOTE_RETRY_MS = 5 * 60_000;
/** One call moves a move as far as it goes, but never loops without end. */
const MAX_STEPS_PER_RUN = 12;

export type TreasuryDeps = QuoteDepositDeps | AuditLog | PrivyWalletsService;

const usdc = formatUsdAmount;

/**
 * A part couldn't go on and nothing of it moved: the move ends `completed`
 * for the smaller amount if earlier parts landed, `failed` if none did.
 */
function endShort(snap: Snapshot, reason: string) {
  const deposited = snap.actions.some(
    (action) => action.kind === "deposit" && action.status === "succeeded",
  );
  return endMove(snap, deposited ? "completed" : "failed", reason);
}

/**
 * A part paid out of a confidential account that 1Click refunded without
 * saying how much, or saying more than was paid: nothing can be credited, so
 * nothing is written and the move goes to review.
 */
const refundUnusable = (quote: IntentQuote): boolean =>
  quote.status === "refunded" &&
  (quote.refundedAmount === null ||
    quote.refundedAmount <= 0n ||
    quote.refundedAmount > quote.amountIn);

/**
 * What a part paid out of a confidential account writes once 1Click has
 * settled it (phase-3-4-design.md, B3). Nothing moves on chain, so a send
 * can't prove the payment: the ledger follows the quote's own outcome, and a
 * 200 from the message's submit is never enough.
 *
 * - `succeeded`: the debit, `-amountIn`;
 * - `refunded`: the debit and a `from_treasury` credit of what 1Click says
 *   it returned, in one transaction, so the ledger is never short by a
 *   refund that is already in the account. The credit isn't
 *   `quote-credit.ts`'s: a refund isn't a delivery.
 *
 * Both rows are unique per quote, so running twice writes nothing twice.
 */
function recordIntentOutcome(
  snap: Snapshot,
  quote: IntentQuote,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog> {
  const { organizationId, id: moveId } = snap.move;
  const refunded = quote.status === "refunded";
  if (quote.status !== "succeeded" && !refunded) {
    return Effect.succeed(false);
  }
  const { refundedAmount } = quote;
  if (refundUnusable(quote)) return Effect.succeed(false);
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const debit = yield* query(() =>
        tx
          .insert(walletTransactions)
          .values({
            organizationId,
            walletId: quote.walletId,
            type: "to_treasury",
            chain: "near",
            usdcAmount: -quote.amountIn,
            txHash: null,
            blockNumber: null,
            counterpartyAddress: quote.depositAddress,
            treasuryMoveId: moveId,
            intentQuoteId: quote.id,
          })
          .onConflictDoNothing()
          .returning({ id: walletTransactions.id }),
      );
      let credited = false;
      if (refunded && refundedAmount !== null) {
        const [credit] = yield* query(() =>
          tx
            .insert(walletTransactions)
            .values({
              organizationId,
              walletId: quote.walletId,
              type: "from_treasury",
              chain: "near",
              usdcAmount: refundedAmount,
              txHash: null,
              blockNumber: null,
              counterpartyAddress: null,
              treasuryMoveId: moveId,
              intentQuoteId: quote.id,
            })
            .onConflictDoNothing()
            .returning({ id: walletTransactions.id }),
        );
        if (credit) {
          credited = true;
          yield* audit.record(tx, {
            actor: ACTOR,
            organizationId,
            action: "wallet.treasury_returned",
            entity: { type: "wallet_transaction", id: credit.id },
            after: {
              treasuryMoveId: moveId,
              treasuryQuoteId: quote.id,
              treasuryQuotePurpose: quote.purpose,
              walletId: quote.walletId,
              chain: "near",
              usdcAmount: refundedAmount,
              source: "one_click_refunded",
            },
          });
        }
      }
      return debit.length > 0 || credited;
    }),
  );
}

/**
 * The part's debit, written once: a quote has at most one `to_treasury`
 * row. For a part paid by a transfer on chain it is written as soon as the
 * company wallet's send is known to have run, which is before anything of
 * this quote can be refunded and credited back. A part paid out of a
 * confidential account follows `recordIntentOutcome` instead, chosen by the
 * quote's own columns and never by the company's `balance_home` now.
 */
function recordDebit(
  snap: Snapshot,
  quote: IntentQuote,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog> {
  if (isIntentPaid(quote)) return recordIntentOutcome(snap, quote);
  const { organizationId, id: moveId } = snap.move;
  const sendId = quote.companyWalletSendId;
  if (sendId === null || quote.depositTxHash === null) {
    return Effect.succeed(false);
  }
  const txHash = quote.depositTxHash;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [send] = yield* query(() =>
        tx
          .select({ blockHeight: companyWalletSends.blockHeight })
          .from(companyWalletSends)
          .where(eq(companyWalletSends.id, sendId)),
      );
      const written = yield* query(() =>
        tx
          .insert(walletTransactions)
          .values({
            organizationId,
            walletId: quote.walletId,
            type: "to_treasury",
            chain: "near",
            usdcAmount: -quote.amountIn,
            txHash,
            blockNumber: send?.blockHeight ?? null,
            counterpartyAddress: quote.depositAddress,
            treasuryMoveId: moveId,
            intentQuoteId: quote.id,
          })
          .onConflictDoNothing()
          .returning({ id: walletTransactions.id }),
      );
      return written.length > 0;
    }),
  );
}

/**
 * Asked immediately before the company wallet's deposit starts: the move is
 * still open, and the quote still pays the company's own Treasury wallet and
 * refunds to its own company wallet, as the `wallets` row says now
 * (spec section 6, rule 5). Nothing the request or the quote row says
 * decides where the money goes.
 */
const gateOnOpenMove =
  (moveId: string, organizationId: string) =>
  (
    quote: IntentQuote,
  ): Effect.Effect<
    | { readonly kind: "go" }
    | { readonly kind: "abandon"; readonly reason: string },
    DatabaseError,
    DatabaseService
  > =>
    withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [current] = yield* query(() =>
          tx
            .select({ status: treasuryMoves.status })
            .from(treasuryMoves)
            .where(eq(treasuryMoves.id, moveId)),
        );
        const [wallet] = yield* query(() =>
          tx
            .select({
              address: wallets.address,
              treasuryAddress: wallets.treasuryAddress,
            })
            .from(wallets)
            .where(eq(wallets.id, quote.walletId)),
        );
        if (current?.status !== "open") {
          return {
            kind: "abandon",
            reason: "The move is no longer open. Nothing was sent.",
          } as const;
        }
        if (
          wallet?.treasuryAddress == null ||
          wallet.address === null ||
          quote.recipient !== wallet.treasuryAddress ||
          quote.refundTo !== wallet.address
        ) {
          return {
            kind: "abandon",
            reason:
              "The quote doesn't pay the company's own Treasury wallet and refund its own company wallet. Nothing was sent.",
          } as const;
        }
        return { kind: "go" } as const;
      }),
    );

function advanceQuote(snap: Snapshot, quote: IntentQuote) {
  return Effect.gen(function* () {
    const advanced = yield* advanceCompanyQuote({
      quote,
      beforeDeposit: gateOnOpenMove(snap.move.id, snap.move.organizationId),
    });
    const wrote = yield* recordDebit(snap, advanced);
    const changed =
      advanced.status !== quote.status ||
      advanced.companyWalletSendId !== quote.companyWalletSendId ||
      advanced.depositStartedAt?.getTime() !==
        quote.depositStartedAt?.getTime();
    return changed || wrote ? moved(snap.move) : idle(snap.move);
  });
}

function nextPart(snap: Snapshot) {
  const { move, wallet } = snap;
  return Effect.gen(function* () {
    const finished = snap.quotes.filter((quote) => isDeposited(snap, quote));
    const remaining =
      move.requestedUsdc -
      finished.reduce((sum, quote) => sum + quote.amountIn, 0n);
    if (remaining <= 0n) return yield* endMove(snap, "completed", null);

    // Even parts rather than full parts and a remainder, which could be too
    // small for 1Click to quote.
    const cap = wallet.perTransactionMaxUsdc;
    const partsLeft = (remaining + cap - 1n) / cap;
    const part = (remaining + partsLeft - 1n) / partsLeft;
    const keyPrefix = `treasury:${move.id}:${finished.length}:`;
    const attempt =
      snap.quotes.filter((quote) => quote.quoteKey.startsWith(keyPrefix))
        .length + 1;
    if (attempt > QUOTE_MAX_ATTEMPTS) {
      return yield* endShort(
        snap,
        "The quote for the next part expired unused three times. Nothing was sent for it.",
      );
    }
    const lastProgress = Math.max(
      move.createdAt.getTime(),
      ...snap.actions.flatMap((action) =>
        action.settledAt ? [action.settledAt.getTime()] : [],
      ),
    );
    const opened = yield* openTreasuryQuote({
      organizationId: move.organizationId,
      moveId: move.id,
      quoteKey: `${keyPrefix}${attempt}`,
      amountIn: part,
    }).pipe(Effect.either);
    if (opened._tag === "Right") return moved(move);
    if (opened.left._tag === "DatabaseError") {
      return yield* Effect.fail(opened.left);
    }
    if (
      opened.left.reason === "one_click_unavailable" &&
      Date.now() - lastProgress < QUOTE_RETRY_MS
    ) {
      return idle(move);
    }
    return yield* endShort(
      snap,
      `The next part couldn't be quoted: ${opened.left.message} Nothing was sent for it.`,
    );
  });
}

function depositPart(
  snap: Snapshot,
  quote: IntentQuote,
  options: TreasuryAdvanceOptions,
) {
  const { move, wallet } = snap;
  const { organizationId } = move;
  return Effect.gen(function* () {
    const treasury = treasuryWalletOf(wallet);
    const vault = yield* earnVaultId;
    if (treasury === null || Option.isNone(vault)) {
      return yield* needsReview(
        snap,
        "Treasury's wallet or vault isn't set up, so the delivered USDC can't be deposited.",
      );
    }
    // What 1Click says it delivered. Never the wallet's balance, which may
    // hold USDC someone else sent.
    const delivered = quote.swappedAmountOut;
    if (delivered === null || delivered <= 0n) {
      return yield* needsReview(
        snap,
        "1Click reported the part as delivered without saying how much. Check the Treasury wallet before depositing anything.",
      );
    }
    const attempts = depositsOf(snap, quote);
    const latest = attempts.at(-1);

    if (latest === undefined || latest.status === "rejected") {
      if (latest !== undefined) {
        if (attempts.length >= EARN_MAX_ATTEMPTS) {
          return yield* needsReview(
            snap,
            `Privy rejected the vault deposit of ${usdc(delivered)} ${attempts.length} times (${latest.failure ?? "no reason given"}). The USDC sits in the Treasury wallet. Staff can send it back to the company wallet.`,
          );
        }
        const retryDelay = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
        if (Date.now() - (latest.settledAt?.getTime() ?? 0) < retryDelay) {
          return idle(move);
        }
      }
      const balance = yield* baseUsdcBalance(treasury.address).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (balance === null) return idle(move);
      if (balance < delivered) {
        const since = (quote.settledAt ?? quote.updatedAt).getTime();
        return Date.now() - since > ARRIVAL_WAIT_MS
          ? yield* needsReview(
              snap,
              `1Click delivered ${usdc(delivered)} but the Treasury wallet holds ${usdc(balance)}. Check the Treasury wallet before depositing anything.`,
            )
          : idle(move);
      }
      const attempt = attempts.length + 1;
      const id = randomUUID();
      const [saved] = yield* withScope({ organizationId }, (tx) =>
        query(() =>
          tx
            .insert(treasuryEarnActions)
            .values({
              id,
              organizationId,
              treasuryMoveId: move.id,
              intentQuoteId: quote.id,
              kind: "deposit",
              attempt,
              referenceId: `tr-${id}-${attempt}`,
              rawAmount: delivered,
            })
            .onConflictDoNothing()
            .returning(),
        ),
      );
      return saved ? moved(move) : idle(move);
    }

    if (latest.status === "saved" || latest.status === "pending") {
      return yield* advanceEarnAction(snap, latest);
    }

    if (latest.status === "failed") {
      return yield* needsReview(
        snap,
        `The vault deposit ${latest.referenceId} reverted on Base (${latest.failure ?? "no reason given"}). The ${usdc(latest.rawAmount)} USDC is in the Treasury wallet or the vault: check both before doing anything.`,
      );
    }
    return idle(move);
  });
}

/**
 * 1Click refunded a part: the USDC is back in the company wallet, and the
 * deposit watcher credits it as `from_treasury` (a part paid from a
 * confidential account had its refund credited with its debit). The move ends `returned`
 * only once that credit is in the ledger, so the ledger never lags a move
 * that says its money is home.
 */
function endWhenRefundCredited(snap: Snapshot, quote: IntentQuote) {
  const { organizationId, id } = snap.move;
  return Effect.gen(function* () {
    if (isIntentPaid(quote) && refundUnusable(quote)) {
      return yield* needsReview(
        snap,
        "1Click refunded a part paid from the confidential account without saying how much came back. Nothing was written to the ledger. Check the account before doing anything.",
      );
    }
    const totals = yield* withScope({ organizationId }, (tx) =>
      totalsOf(tx, id),
    );
    const expected = quote.refundedAmount ?? 1n;
    if (totals.creditedBack >= expected) {
      return yield* endMove(
        snap,
        "returned",
        "NEAR Intents refunded a part of the move: that USDC is back in the company wallet.",
      );
    }
    const since = (quote.settledAt ?? quote.updatedAt).getTime();
    return Date.now() - since > ARRIVAL_WAIT_MS
      ? yield* needsReview(
          snap,
          `1Click refunded the part but the company wallet's ledger hasn't been credited with ${usdc(expected)} in 30 minutes. Check the company wallet's deposits before doing anything.`,
        )
      : idle(snap.move);
  });
}

/**
 * One step of an open move: the next thing the saved rows say hasn't been
 * done. Moves to the wallet are stepped in `to-wallet.ts`. `progressed` says whether it changed anything, so the
 * caller knows whether a following step may build on it.
 */
export function stepTreasuryMove(
  input: { readonly organizationId: string; readonly moveId: string },
  options: TreasuryAdvanceOptions = {},
): Effect.Effect<Step, DatabaseError, TreasuryDeps> {
  return Effect.gen(function* () {
    const snap = yield* load(input.organizationId, input.moveId);
    if (snap === null) return idle(null);
    const { move } = snap;
    if (move.status !== "open") return idle(move);
    // Staff reopened a move under review and approved sending its USDC back.
    const approval = yield* pendingReturnApproval(move);
    if (approval !== null) return yield* carryOutReturnApproval(snap, approval);
    if (move.direction === "to_wallet") return yield* stepToWallet(snap);
    // A move whose deposit Privy rejected, and which staff sent back from
    // the Treasury wallet: its parts to the vault are over.
    if (snap.returns.length > 0) return yield* stepStranded(snap);
    const quote = snap.quotes.at(-1);

    // A send that ran, or a part paid out of a confidential account that
    // 1Click has settled, and isn't debited yet: the ledger comes first.
    if (
      quote !== undefined &&
      !snap.debited.has(quote.id) &&
      (quote.companyWalletSendId !== null ||
        (isIntentPaid(quote) &&
          (quote.status === "succeeded" ||
            (quote.status === "refunded" && !refundUnusable(quote)))))
    ) {
      return (yield* recordDebit(snap, quote)) ? moved(move) : idle(move);
    }

    if (quote === undefined || isDeposited(snap, quote)) {
      return yield* nextPart(snap);
    }
    switch (quote.status) {
      case "quoted":
      case "depositing":
        return yield* advanceQuote(snap, quote);
      case "succeeded":
        return yield* depositPart(snap, quote, options);
      case "refunded":
        return yield* endWhenRefundCredited(snap, quote);
      case "needs_review":
        return yield* needsReview(
          snap,
          quote.failure ??
            "The outcome of a part's deposit to NEAR Intents is unclear. Check it before doing anything.",
        );
      case "failed":
        return yield* endShort(
          snap,
          `${quote.failure ?? "The part couldn't be sent."} Nothing was sent for it.`,
        );
      case "expired":
        return yield* nextPart(snap);
    }
  });
}

/**
 * Moves an open move to Treasury as far as it goes right now: steps until
 * one changes nothing, so a part that settles in seconds doesn't wait a
 * whole job interval for each stage. Returns the move as it then stands.
 */
export function advanceTreasuryMove(
  input: { readonly organizationId: string; readonly moveId: string },
  options: TreasuryAdvanceOptions = {},
): Effect.Effect<TreasuryMove | null, DatabaseError, TreasuryDeps> {
  return Effect.gen(function* () {
    let current: TreasuryMove | null = null;
    for (let steps = 0; steps < MAX_STEPS_PER_RUN; steps += 1) {
      const step = yield* stepTreasuryMove(input, options);
      current = step.move;
      if (!step.progressed || current?.status !== "open") break;
    }
    return current;
  });
}

interface MoveRef extends Record<string, unknown> {
  readonly move_id: string;
  readonly organization_id: string;
}

export interface TreasuryMovesSummary {
  readonly moves: number;
  readonly errors: number;
}

/**
 * The `treasury-moves` job: advances every open move to Treasury, each on
 * its own so one failing never stops the rest. A paused company's open move
 * still finishes (spec section 5): nothing here reads the pause flags.
 */
export function advanceTreasuryMoves(
  maxRows = 50,
  options: TreasuryAdvanceOptions = {},
): Effect.Effect<TreasuryMovesSummary, DatabaseError, TreasuryDeps> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<MoveRef>(
          sql`SELECT move_id, organization_id FROM treasury_moves_to_advance(${maxRows})`,
        ),
      ),
    );
    let errors = 0;
    for (const ref of rows) {
      const exit = yield* Effect.exit(
        advanceTreasuryMove(
          { organizationId: ref.organization_id, moveId: ref.move_id },
          options,
        ),
      );
      if (Exit.isFailure(exit)) {
        errors += 1;
        console.error(
          `[treasury-moves] move ${ref.move_id} broke`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { moves: rows.length, errors };
  });
}
