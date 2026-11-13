import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { formatUsdAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type {
  IntentQuote,
  TreasuryEarnAction,
  TreasuryMove,
  Wallet,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { QuoteDepositDeps } from "../intents/quote-deposit.js";
import type {
  EarnActionRecord,
  PrivyWallets as PrivyWalletsService,
} from "../wallet/privy-wallets.js";
import {
  companyWalletSends,
  intentQuotes,
  treasuryEarnActions,
  treasuryMoves,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { advanceCompanyQuote } from "../intents/quote-deposit.js";
import { openTreasuryQuote } from "../intents/treasury-quote.js";
import { notify } from "../notification/notify.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { earnVaultId } from "./turn-on.js";

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

const ACTOR = { type: "system", id: "treasury-moves" } as const;

/** Privy rejects a deposit this many times before a person looks. */
export const EARN_MAX_ATTEMPTS = 3;
/** A part's quote that expires unused is taken again this many times. */
const QUOTE_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_DELAY_MS = 30_000;
/** Privy keeps an idempotency key for 24 hours; a repeat is never sent near that. */
const UNKNOWN_CALL_LIMIT_MS = 60 * 60_000;
/** How long a delivery may take to show in the Treasury wallet, or a refund to be credited. */
const ARRIVAL_WAIT_MS = 30 * 60_000;
/** A quote 1Click can't be asked for is retried this long before the move ends. */
const QUOTE_RETRY_MS = 5 * 60_000;
/** One call moves a move as far as it goes, but never loops without end. */
const MAX_STEPS_PER_RUN = 12;

export type TreasuryDeps = QuoteDepositDeps | AuditLog | PrivyWalletsService;

export interface TreasuryAdvanceOptions {
  /** How long after a rejected deposit the next attempt waits; tests pass 0. */
  readonly retryDelayMs?: number;
}

interface Snapshot {
  readonly move: TreasuryMove;
  readonly wallet: Wallet;
  /** The move's quotes, oldest first: one per attempt at a part. */
  readonly quotes: readonly IntentQuote[];
  readonly actions: readonly TreasuryEarnAction[];
  /** Quotes whose send has already been debited. */
  readonly debited: ReadonlySet<string>;
}

interface Step {
  readonly move: TreasuryMove | null;
  /** Whether something changed that a following step may build on. */
  readonly progressed: boolean;
}

const idle = (move: TreasuryMove | null): Step => ({ move, progressed: false });
const moved = (move: TreasuryMove | null): Step => ({ move, progressed: true });

const usdc = formatUsdAmount;

function load(
  organizationId: string,
  moveId: string,
): Effect.Effect<Snapshot | null, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [move] = yield* query(() =>
        tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, moveId)),
      );
      if (!move) return null;
      const [wallet] = yield* query(() =>
        tx.select().from(wallets).where(eq(wallets.id, move.walletId)),
      );
      if (!wallet) return null;
      const quotes = yield* query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(eq(intentQuotes.treasuryMoveId, moveId))
          .orderBy(asc(intentQuotes.createdAt), asc(intentQuotes.id)),
      );
      const actions = yield* query(() =>
        tx
          .select()
          .from(treasuryEarnActions)
          .where(eq(treasuryEarnActions.treasuryMoveId, moveId))
          .orderBy(
            asc(treasuryEarnActions.createdAt),
            asc(treasuryEarnActions.attempt),
          ),
      );
      const debits = yield* query(() =>
        tx
          .select({ quoteId: walletTransactions.intentQuoteId })
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.treasuryMoveId, moveId),
              eq(walletTransactions.type, "to_treasury"),
            ),
          ),
      );
      return {
        move,
        wallet,
        quotes,
        actions,
        debited: new Set(
          debits.flatMap(({ quoteId }) => (quoteId === null ? [] : [quoteId])),
        ),
      };
    }),
  );
}

const depositsOf = (snap: Snapshot, quote: IntentQuote) =>
  snap.actions.filter(
    (action) => action.kind === "deposit" && action.intentQuoteId === quote.id,
  );

const isDeposited = (snap: Snapshot, quote: IntentQuote) =>
  depositsOf(snap, quote).some((action) => action.status === "succeeded");

const sumOf = (rows: readonly { readonly value: string | null }[]): bigint =>
  BigInt(rows[0]?.value ?? "0");

/** What the move has debited, credited back and put in the vault so far. */
function totalsOf(tx: Transaction, moveId: string) {
  return Effect.gen(function* () {
    const debits = yield* query(() =>
      tx
        .select({
          value: sql<string>`coalesce(-sum(${walletTransactions.usdcAmount}), 0)::text`,
        })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.treasuryMoveId, moveId),
            eq(walletTransactions.type, "to_treasury"),
          ),
        ),
    );
    const credits = yield* query(() =>
      tx
        .select({
          value: sql<string>`coalesce(sum(${walletTransactions.usdcAmount}), 0)::text`,
        })
        .from(walletTransactions)
        .where(
          and(
            eq(walletTransactions.treasuryMoveId, moveId),
            eq(walletTransactions.type, "from_treasury"),
          ),
        ),
    );
    const deposits = yield* query(() =>
      tx
        .select({
          value: sql<string>`coalesce(sum(${treasuryEarnActions.rawAmount}), 0)::text`,
        })
        .from(treasuryEarnActions)
        .where(
          and(
            eq(treasuryEarnActions.treasuryMoveId, moveId),
            eq(treasuryEarnActions.kind, "deposit"),
            eq(treasuryEarnActions.status, "succeeded"),
          ),
        ),
    );
    const debited = sumOf(debits);
    const creditedBack = sumOf(credits);
    const deposited = sumOf(deposits);
    return {
      debited,
      creditedBack,
      deposited,
      cost: debited - creditedBack - deposited,
    };
  });
}

type Ending = "completed" | "returned" | "failed" | "needs_review";

/**
 * Ends the move, once: only an `open` move changes, so a second call finds
 * it settled and does nothing. The totals, the audit entry and the
 * notification are written in the same transaction. A move under review
 * keeps its reservation and its totals stay empty until a person settles it.
 */
function endMove(
  snap: Snapshot,
  status: Ending,
  failure: string | null,
): Effect.Effect<Step, DatabaseError, DatabaseService | AuditLog> {
  const { organizationId, id } = snap.move;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const totals = yield* totalsOf(tx, id);
      const reviewing = status === "needs_review";
      const [ended] = yield* query(() =>
        tx
          .update(treasuryMoves)
          .set({
            status,
            failure,
            movedUsdc: reviewing ? null : totals.deposited,
            costUsdc: reviewing ? null : totals.cost,
            settledAt: reviewing ? null : new Date(),
          })
          .where(
            and(eq(treasuryMoves.id, id), eq(treasuryMoves.status, "open")),
          )
          .returning(),
      );
      if (!ended) {
        const [current] = yield* query(() =>
          tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, id)),
        );
        return idle(current ?? null);
      }
      const short =
        status === "completed" && totals.debited < ended.requestedUsdc;
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId,
        action: `treasury_move.${status}`,
        entity: { type: "treasury_move", id },
        before: { status: "open" },
        after: {
          status,
          requestedUsdc: ended.requestedUsdc,
          movedUsdc: ended.movedUsdc,
          costUsdc: ended.costUsdc,
          failure,
          ...(short && { partlyFilled: true }),
        },
      });
      const outcome = short
        ? ("partly_filled" as const)
        : status === "completed"
          ? null
          : status;
      yield* notify(
        tx,
        outcome === null
          ? {
              kind: "treasury_move_completed",
              organizationId,
              moveId: id,
            }
          : {
              kind: "treasury_move_ended",
              organizationId,
              moveId: id,
              outcome,
            },
      );
      return moved(ended);
    }),
  );
}

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

const needsReview = (snap: Snapshot, reason: string) =>
  endMove(snap, "needs_review", reason);

/**
 * The send's debit, written once: a quote has at most one `to_treasury`
 * row. Written as soon as the company wallet's send is known to have run,
 * which is before anything of this quote can be refunded and credited back.
 */
function recordDebit(
  snap: Snapshot,
  quote: IntentQuote,
): Effect.Effect<boolean, DatabaseError, DatabaseService> {
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

/** Moves an Earn action to what Privy reports, once, from the status it was last seen in. */
function applyAction(
  snap: Snapshot,
  action: TreasuryEarnAction,
  record: EarnActionRecord,
) {
  const terminal = record.status !== "pending";
  return withScope({ organizationId: snap.move.organizationId }, (tx) =>
    query(() =>
      tx
        .update(treasuryEarnActions)
        .set({
          privyActionId: record.actionId,
          status: record.status,
          shareAmount: record.shareAmount,
          txHash: record.txHash,
          failure: record.failureReason,
          settledAt: terminal ? new Date() : null,
        })
        .where(
          and(
            eq(treasuryEarnActions.id, action.id),
            eq(treasuryEarnActions.status, action.status),
          ),
        )
        .returning(),
    ),
  ).pipe(Effect.map(([updated]) => updated ?? null));
}

const treasuryWalletOf = (wallet: Wallet) =>
  wallet.treasuryPrivyWalletId !== null && wallet.treasuryAddress !== null
    ? {
        privyWalletId: wallet.treasuryPrivyWalletId,
        address: wallet.treasuryAddress,
      }
    : null;

function depositPart(
  snap: Snapshot,
  quote: IntentQuote,
  options: TreasuryAdvanceOptions,
) {
  const { move, wallet } = snap;
  const { organizationId } = move;
  return Effect.gen(function* () {
    const privy = yield* PrivyWallets;
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
            `Privy rejected the vault deposit of ${usdc(delivered)} ${attempts.length} times (${latest.failure ?? "no reason given"}). The USDC sits in the Treasury wallet. Returning it to the company wallet isn't automatic yet: a person has to send it back.`,
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

    if (latest.status === "saved") {
      const startedAt = latest.callStartedAt;
      if (
        startedAt !== null &&
        Date.now() - startedAt.getTime() > UNKNOWN_CALL_LIMIT_MS
      ) {
        return yield* needsReview(
          snap,
          `Privy hasn't confirmed the vault deposit ${latest.referenceId} for over an hour, and it only honours a repeated call for a day. Look the reference up in Privy before doing anything.`,
        );
      }
      if (startedAt === null) {
        yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .update(treasuryEarnActions)
              .set({ callStartedAt: new Date() })
              .where(
                and(
                  eq(treasuryEarnActions.id, latest.id),
                  isNull(treasuryEarnActions.callStartedAt),
                ),
              ),
          ),
        );
      }
      const called = yield* privy
        .earnDeposit({
          privyWalletId: treasury.privyWalletId,
          vaultId: vault.value,
          rawAmount: latest.rawAmount,
          referenceId: latest.referenceId,
        })
        .pipe(Effect.either);
      if (called._tag === "Left") {
        if (called.left._tag === "SendOutcomeUnknown") return idle(move);
        if (startedAt !== null) {
          return yield* needsReview(
            snap,
            `Privy refused a repeated vault deposit ${latest.referenceId} (${called.left.message}), so the first call may have gone through. Look the reference up in Privy before doing anything.`,
          );
        }
        yield* withScope({ organizationId }, (tx) =>
          query(() =>
            tx
              .update(treasuryEarnActions)
              .set({
                status: "rejected",
                failure: called.left.message,
                settledAt: new Date(),
              })
              .where(
                and(
                  eq(treasuryEarnActions.id, latest.id),
                  eq(treasuryEarnActions.status, "saved"),
                ),
              ),
          ),
        );
        return moved(move);
      }
      if (
        called.right.rawAmount !== 0n &&
        called.right.rawAmount !== latest.rawAmount
      ) {
        return yield* needsReview(
          snap,
          `Privy's action ${called.right.actionId} is for ${called.right.rawAmount} USDC base units, not the ${latest.rawAmount} that was asked.`,
        );
      }
      yield* applyAction(snap, latest, called.right);
      return moved(move);
    }

    if (latest.status === "pending" && latest.privyActionId !== null) {
      const read = yield* privy
        .getWalletAction({
          privyWalletId: treasury.privyWalletId,
          actionId: latest.privyActionId,
        })
        .pipe(Effect.either);
      if (read._tag === "Left" || read.right.status === "pending") {
        return idle(move);
      }
      yield* applyAction(snap, latest, read.right);
      return moved(move);
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
 * deposit watcher credits it as `from_treasury`. The move ends `returned`
 * only once that credit is in the ledger, so the ledger never lags a move
 * that says its money is home.
 */
function endWhenRefundCredited(snap: Snapshot, quote: IntentQuote) {
  const { organizationId, id } = snap.move;
  return Effect.gen(function* () {
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
 * One step of an open move to Treasury: the next thing the saved rows say
 * hasn't been done. `progressed` says whether it changed anything, so the
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
    if (move.status !== "open" || move.direction !== "to_treasury") {
      return idle(move);
    }
    const quote = snap.quotes.at(-1);

    // A send that ran but wasn't debited yet: the ledger comes first.
    if (quote?.companyWalletSendId != null && !snap.debited.has(quote.id)) {
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
