import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type {
  IntentQuotePurpose,
  IntentQuoteStatus,
} from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AlertSignal, CheckResult } from "../alerts/ops-alerts.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { FastNearError, FastNearTransfer } from "../chain/fast-near.js";
import type { NearRpcError } from "../chain/near-rpc.js";
import type { NearUsdcReceiptTransfer } from "../chain/near.js";
import type { OneClick } from "../intents/one-click.js";
import {
  intentQuotes,
  organizations,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { applyCheck } from "../alerts/ops-alerts.js";
import { AuditLog } from "../audit/audit-log.js";
import { FAST_NEAR_MAX_PAGE_SIZE, FastNear } from "../chain/fast-near.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { NearChain, nearUsdcReceiptTransfersIn } from "../chain/near.js";
import { refreshFundIn } from "../intents/fund-in.js";
import {
  quotesToRecheck,
  refreshQuoteStatus,
} from "../intents/quote-status.js";

/**
 * The deposit watcher (docs/decisions/near-main-chain.md, "The ledger" and
 * "Telling internal transfers from deposits"). For each company wallet it
 * reads the USDC transfers the indexer lists, confirms each against the RPC
 * at `FINAL`, decides whether it is the company's own money moving between
 * its wallets or new money, and credits only new money, once.
 */

/** Where NEAR Intents pays out from: deliveries, refunds and withdrawals alike. */
export const NEAR_INTENTS_ACCOUNT_ID = "intents.near";

const ACTOR: AuditActor = { type: "system", id: "near-deposit-watcher" };

/** Pages read per wallet in one run; a longer backlog continues next run. */
const MAX_PAGES_PER_WALLET = 5;

/**
 * How many blocks the chain must have finalised past the transfer a wallet
 * waits at before staff are alerted: about 15 minutes at NEAR's 600 ms
 * blocks, later if blocks slow down. A wait normally lasts a run or two,
 * until the transaction is final or 1Click lists it, and a company quote
 * takes its deposit within 10 minutes (`COMPANY_QUOTE_TTL_MS`). So a
 * wallet still waiting after this is stuck behind a quote, 1Click or the
 * RPC, not slow, and staff hear of it well before a quote 1Click never
 * settles reaches needs_review half an hour after its deadline.
 *
 * When the wait began is read from the chain rather than stored: it is the
 * block the indexer gives for the transfer, because neither the indexer row
 * nor the RPC outcome carries a time and nothing records a wait while it
 * lasts. The watcher reaches a transfer within a run of it becoming final,
 * so the two agree, except after the watcher was stopped. The alert then
 * fires sooner, which is when the company has waited that long anyway.
 */
export const DEPOSITS_HELD_ALERT_BLOCKS = 1_500n;

interface WatchedWallet extends Record<string, unknown> {
  readonly wallet_id: string;
  readonly organization_id: string;
  readonly address: string;
  readonly deposits_resume_token: string | null;
}

export interface NearDepositSummary {
  readonly credited: number;
  readonly alreadyCredited: number;
  /** The company's own money moving between its wallets: never ledger entries. */
  readonly internal: number;
  /** Listed by the indexer but not what the chain shows; skipped. */
  readonly unconfirmed: number;
  /** Wallets that stopped at a transfer that can't be judged yet. */
  readonly held: number;
  /** Wallets whose run failed; they are read again next run. */
  readonly failed: number;
}

type Verdict = "credited" | "already_credited" | "internal";

interface UnsettledQuote {
  readonly id: string;
  readonly purpose: IntentQuotePurpose;
  readonly status: IntentQuoteStatus;
}

/** Why a wallet waits at a transfer instead of judging it. */
type HoldReason =
  | { readonly kind: "not_final" }
  | { readonly kind: "quotes_unanswered" }
  | { readonly kind: "unsettled_quote"; readonly quote: UnsettledQuote };

interface Held {
  readonly kind: "held";
  readonly reason: HoldReason;
}

const held = (reason: HoldReason): Held => ({ kind: "held", reason });

type WatcherDeps =
  | DatabaseService
  | AuditLog
  | FastNear
  | NearRpc
  | NearChain
  | NearRelayer
  | OneClick;

type WatcherError = DatabaseError | FastNearError | NearRpcError;

/**
 * The purposes of the company's quotes whose 1Click record lists `txHash`.
 * NEAR hashes are case-sensitive, so they are compared exactly.
 */
function quotesListing(
  organizationId: string,
  txHash: string,
): Effect.Effect<
  readonly { readonly id: string; readonly purpose: string }[],
  DatabaseError,
  DatabaseService
> {
  const hash = sql`ARRAY[${txHash}]::text[]`;
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ id: intentQuotes.id, purpose: intentQuotes.purpose })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            sql`(${intentQuotes.nearTxHashes} @> ${hash} OR ${intentQuotes.destinationChainTxHashes} @> ${hash})`,
          ),
        ),
    ),
  );
}

/**
 * One of the company's unsettled quotes, or null if none is. A quote in
 * needs_review comes first: it is the one that waits for a person.
 */
function firstUnsettledQuote(
  organizationId: string,
): Effect.Effect<UnsettledQuote | null, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          id: intentQuotes.id,
          purpose: intentQuotes.purpose,
          status: intentQuotes.status,
        })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.status, [...UNSETTLED_INTENT_QUOTE_STATUSES]),
          ),
        )
        .orderBy(
          desc(sql`${intentQuotes.status} = 'needs_review'`),
          asc(intentQuotes.createdAt),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([quote]) => quote ?? null));
}

/**
 * Asks 1Click again about every quote of the company that could still list
 * a new transaction. False when any of them couldn't be asked: what it would
 * have said is then unknown.
 */
function refreshQuotes(
  organizationId: string,
): Effect.Effect<boolean, DatabaseError, DatabaseService | OneClick> {
  return Effect.gen(function* () {
    const quotes = yield* quotesToRecheck(organizationId);
    let allAnswered = true;
    for (const quote of quotes) {
      const exit = yield* Effect.exit(
        quote.purpose === "fund_in"
          ? refreshFundIn(quote)
          : refreshQuoteStatus(quote),
      );
      if (Exit.isFailure(exit)) {
        allAnswered = false;
        console.warn(
          `[near-deposits] quote ${quote.id} not refreshed`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return allAnswered;
  });
}

/** The quote whose delivery a deposit is, when 1Click lists the transfer. */
interface DeliveringQuote {
  readonly id: string;
  readonly purpose: "fund_in" | "fund_in_return";
}

function deliveringQuote(quote: {
  readonly id: string;
  readonly purpose: string;
}): DeliveringQuote | null {
  return quote.purpose === "fund_in" || quote.purpose === "fund_in_return"
    ? { id: quote.id, purpose: quote.purpose }
    : null;
}

function creditDeposit(
  wallet: WatchedWallet,
  transfer: NearUsdcReceiptTransfer,
  delivering: DeliveringQuote | null,
): Effect.Effect<Verdict, DatabaseError, DatabaseService | AuditLog> {
  return withScope({ organizationId: wallet.organization_id }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [credit] = yield* query(() =>
        tx
          .insert(walletTransactions)
          .values({
            organizationId: wallet.organization_id,
            walletId: wallet.wallet_id,
            type: "deposit",
            chain: "near",
            usdcAmount: transfer.amount,
            txHash: transfer.txHash,
            receiptId: transfer.receiptId,
            logIndex: transfer.receiptLogIndex,
            transferIndex: transfer.transferIndex,
            // The block that included the transaction, as the RPC reports
            // it: the receipt that moved the USDC may have run a block or
            // two later.
            blockNumber: transfer.blockHeight,
            counterpartyAddress: transfer.from,
          })
          .onConflictDoNothing()
          .returning({ id: walletTransactions.id }),
      );
      if (!credit) return "already_credited" as const;
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: wallet.organization_id,
        action: "wallet.deposit_received",
        entity: { type: "wallet_transaction", id: credit.id },
        after: {
          ...(delivering?.purpose === "fund_in" && {
            fundInId: delivering.id,
          }),
          ...(delivering?.purpose === "fund_in_return" && {
            fundInReturnId: delivering.id,
          }),
          walletId: wallet.wallet_id,
          chain: "near",
          usdcAmount: transfer.amount,
          txHash: transfer.txHash,
          receiptId: transfer.receiptId,
          logIndex: transfer.receiptLogIndex,
          transferIndex: transfer.transferIndex,
          from: transfer.from,
        },
      });
      return "credited" as const;
    }),
  );
}

/**
 * Decides what one confirmed transfer into a company wallet is, in the
 * order the decision record gives:
 *
 * 1. from the gas relayer: its fee cover, internal;
 * 2. in a transaction one of the company's quotes lists: a deposit if that
 *    quote is a fund-in or a fund-in return (money that never reached the
 *    company wallet before), otherwise a hop refund, a sweep or a payout
 *    refund, internal;
 * 3. from NEAR Intents, unexplained, while a quote of the company's is
 *    still unsettled: held, because 1Click may not have listed it yet;
 * 4. anything else: a deposit.
 */
function settleTransfer(
  wallet: WatchedWallet,
  transfer: NearUsdcReceiptTransfer,
): Effect.Effect<Verdict | Held, DatabaseError, WatcherDeps> {
  const organizationId = wallet.organization_id;
  return Effect.gen(function* () {
    const relayer = yield* NearRelayer;
    if (transfer.from === relayer.accountId) return "internal";

    const explained = (
      listing: readonly { readonly id: string; readonly purpose: string }[],
    ) => {
      if (listing.length === 0) return null;
      const delivering = listing.map(deliveringQuote);
      return delivering.every((quote) => quote !== null)
        ? creditDeposit(wallet, transfer, delivering[0] ?? null)
        : Effect.succeed<Verdict>("internal");
    };

    const known = explained(
      yield* quotesListing(organizationId, transfer.txHash),
    );
    if (known !== null) return yield* known;

    if (transfer.from === NEAR_INTENTS_ACCOUNT_ID) {
      const allAnswered = yield* refreshQuotes(organizationId);
      const now = explained(
        yield* quotesListing(organizationId, transfer.txHash),
      );
      if (now !== null) return yield* now;
      if (!allAnswered) return held({ kind: "quotes_unanswered" });
      const unsettled = yield* firstUnsettledQuote(organizationId);
      if (unsettled !== null) {
        return held({ kind: "unsettled_quote", quote: unsettled });
      }
    }
    return yield* creditDeposit(wallet, transfer, null);
  });
}

type RowOutcome =
  | { readonly kind: "handled"; readonly verdicts: readonly Verdict[] }
  | { readonly kind: "unconfirmed" }
  | Held;

/**
 * Handles one row the indexer listed. The row only says where to look: the
 * transfer must be in a final transaction, emitted by the USDC contract, to
 * this wallet, in the receipt and for the amount the row gives. Everything
 * recorded comes from the RPC's outcome.
 */
function handleRow(
  wallet: WatchedWallet,
  row: FastNearTransfer,
): Effect.Effect<RowOutcome, DatabaseError | NearRpcError, WatcherDeps> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const chain = yield* NearChain;
    const outcome = yield* rpc.transactionOutcome(
      row.transactionId,
      row.signerId,
    );
    if (outcome === null) {
      // Not final yet, or this node no longer has it. Skipping could lose a
      // real deposit, so the wallet waits here and says so.
      console.warn(
        `[near-deposits] ${row.transactionId} for wallet ${wallet.wallet_id} isn't final on the RPC; waiting`,
      );
      return held({ kind: "not_final" });
    }
    const confirmed = nearUsdcReceiptTransfersIn(
      outcome,
      chain.usdcContractId,
    ).filter(
      (transfer) =>
        transfer.to === wallet.address &&
        transfer.receiptId === row.receiptId &&
        transfer.amount === row.amount,
    );
    if (confirmed.length === 0) {
      console.warn(
        `[near-deposits] ${row.transactionId} (receipt ${row.receiptId}) doesn't send wallet ${wallet.wallet_id} the USDC the indexer listed; skipped`,
      );
      return { kind: "unconfirmed" };
    }
    const verdicts: Verdict[] = [];
    for (const transfer of confirmed) {
      const verdict = yield* settleTransfer(wallet, transfer);
      if (typeof verdict !== "string") return verdict;
      verdicts.push(verdict);
    }
    return { kind: "handled", verdicts };
  });
}

/** The transfer a wallet stopped at, as the indexer listed it, and why. */
interface WalletHold {
  readonly row: FastNearTransfer;
  readonly reason: HoldReason;
}

interface WalletRun {
  readonly credited: number;
  readonly alreadyCredited: number;
  readonly internal: number;
  readonly unconfirmed: number;
  readonly hold: WalletHold | null;
}

/**
 * Reads one wallet's transfers from where it last stopped, oldest first. The
 * saved position moves only past a page whose every transfer was handled, so
 * a held transfer and everything after it are read again next run; whatever
 * before it was already credited is credited once, by the ledger's unique
 * index.
 */
function watchWallet(
  wallet: WatchedWallet,
): Effect.Effect<WalletRun, WatcherError, WatcherDeps> {
  return Effect.gen(function* () {
    const fastNear = yield* FastNear;
    const tally = { credited: 0, alreadyCredited: 0, internal: 0 };
    let unconfirmed = 0;
    let resumeToken = wallet.deposits_resume_token;

    for (let page = 0; page < MAX_PAGES_PER_WALLET; page += 1) {
      const { transfers, resumeToken: next } = yield* fastNear.usdcTransfersTo({
        accountId: wallet.address,
        limit: FAST_NEAR_MAX_PAGE_SIZE,
        resumeToken,
      });
      for (const row of transfers) {
        const outcome = yield* handleRow(wallet, row);
        if (outcome.kind === "held") {
          return {
            ...tally,
            unconfirmed,
            hold: { row, reason: outcome.reason },
          };
        }
        if (outcome.kind === "unconfirmed") {
          unconfirmed += 1;
          continue;
        }
        for (const verdict of outcome.verdicts) {
          if (verdict === "credited") tally.credited += 1;
          if (verdict === "already_credited") tally.alreadyCredited += 1;
          if (verdict === "internal") tally.internal += 1;
        }
      }
      if (next === null || next === resumeToken) break;
      yield* withScope({ organizationId: wallet.organization_id }, (tx) =>
        query(() =>
          tx
            .update(wallets)
            .set({ depositsResumeToken: next })
            .where(eq(wallets.id, wallet.wallet_id)),
        ),
      );
      resumeToken = next;
      if (transfers.length < FAST_NEAR_MAX_PAGE_SIZE) break;
    }
    return { ...tally, unconfirmed, hold: null };
  });
}

const QUOTE_PURPOSE_NAMES: Readonly<Record<IntentQuotePurpose, string>> = {
  base_hop: "Base hop",
  sweep: "sweep",
  fund_in: "fund-in",
  usdc_payout: "USDC payout",
  fund_in_return: "fund-in return",
};

function holdExplained(reason: HoldReason): string {
  switch (reason.kind) {
    case "not_final":
      return "The NEAR RPC doesn't return this transaction as final, so the transfer can't be checked against the chain. Look it up on a NEAR explorer: if it is final there, the RPC node no longer keeps transactions that old and NEAR_RPC_URL needs an archival node.";
    case "quotes_unanswered":
      return "It came from NEAR Intents, which also returns the company's own money, and 1Click couldn't be asked about the company's quotes, so it can't yet be told apart from a refund or a sweep. Check that 1Click is answering; the API's logs name the quote.";
    case "unsettled_quote": {
      const { quote } = reason;
      const review =
        quote.status === "needs_review"
          ? " A quote in needs_review settles only once someone has checked it."
          : "";
      return `It came from NEAR Intents while the company's ${QUOTE_PURPOSE_NAMES[quote.purpose]} quote ${quote.id} is ${quote.status}, so it may be that quote's own refund or delivery. It waits until 1Click lists it or the quote settles.${review}`;
    }
  }
}

/**
 * Leaves out the amount: a held transfer can be a refund of a USDC payout,
 * and alerts never show what a salary could be read from.
 */
function depositsHeldAlert(
  wallet: WatchedWallet,
  hold: WalletHold,
): Effect.Effect<AlertSignal, DatabaseError, DatabaseService> {
  return withScope({ organizationId: wallet.organization_id }, (tx) =>
    query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, wallet.organization_id))
        .limit(1),
    ),
  ).pipe(
    Effect.map(([company]) => {
      const companyName = company?.name ?? wallet.organization_id;
      return {
        kind: "deposits_held",
        subjectKey: wallet.wallet_id,
        organizationId: wallet.organization_id,
        title: `Deposits held at ${companyName}`,
        details: [
          { label: "Company", value: companyName },
          { label: "Company wallet", value: wallet.address },
          { label: "Held at NEAR transaction", value: hold.row.transactionId },
          { label: "Receipt", value: hold.row.receiptId },
          { label: "Block", value: hold.row.blockHeight.toString() },
          {
            label: "From",
            value: hold.row.otherAccountId ?? hold.row.signerId,
          },
          { label: "Why it's held", value: holdExplained(hold.reason) },
          {
            label: "What it means",
            value:
              "Neither this transfer nor any USDC sent to the company wallet after it is credited until the hold clears; this alert resolves on its own once it does.",
          },
        ],
      };
    }),
  );
}

/**
 * Alerts staff to each company wallet that has waited at the same transfer
 * for `DEPOSITS_HELD_ALERT_BLOCKS`, one alert per wallet however many runs
 * see it. The alert stays while the wallet still waits or couldn't be read,
 * and resolves once a run gets past every transfer. If the chain's height
 * can't be read, every waiting wallet's alert is left as it is.
 */
function depositsHeldCheck(
  waiting: readonly { wallet: WatchedWallet; hold: WalletHold }[],
  unread: readonly WatchedWallet[],
): Effect.Effect<CheckResult, DatabaseError, DatabaseService | NearRpc> {
  return Effect.gen(function* () {
    const keep = unread.map((wallet) => wallet.wallet_id);
    const firing: AlertSignal[] = [];
    if (waiting.length === 0) return { kind: "deposits_held", firing, keep };

    const rpc = yield* NearRpc;
    const final = yield* Effect.exit(rpc.finalBlock());
    if (Exit.isFailure(final)) {
      console.warn(
        "[near-deposits] final block unreadable; held-deposit alerts left as they are",
        Cause.pretty(final.cause),
      );
      keep.push(...waiting.map(({ wallet }) => wallet.wallet_id));
      return { kind: "deposits_held", firing, keep };
    }
    for (const { wallet, hold } of waiting) {
      const waitedBlocks = final.value.height - hold.row.blockHeight;
      if (waitedBlocks < DEPOSITS_HELD_ALERT_BLOCKS) {
        keep.push(wallet.wallet_id);
        continue;
      }
      firing.push(yield* depositsHeldAlert(wallet, hold));
    }
    return { kind: "deposits_held", firing, keep };
  });
}

/**
 * One run of the deposit watcher over every active company wallet. A wallet
 * whose run fails (the indexer, the RPC or the database didn't answer) is
 * logged and read again next run; the others carry on. Then staff are
 * alerted to wallets that have waited too long at a transfer.
 */
export function watchNearDeposits(): Effect.Effect<
  NearDepositSummary,
  DatabaseError,
  WatcherDeps
> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<WatchedWallet>(
          sql`SELECT wallet_id, organization_id, address, deposits_resume_token FROM active_main_chain_wallets()`,
        ),
      ),
    );
    const summary = {
      credited: 0,
      alreadyCredited: 0,
      internal: 0,
      unconfirmed: 0,
      held: 0,
      failed: 0,
    };
    const waiting: { wallet: WatchedWallet; hold: WalletHold }[] = [];
    const unread: WatchedWallet[] = [];
    for (const wallet of rows) {
      const exit = yield* Effect.exit(watchWallet(wallet));
      if (Exit.isFailure(exit)) {
        summary.failed += 1;
        unread.push(wallet);
        console.error(
          `[near-deposits] wallet ${wallet.wallet_id} not read`,
          Cause.pretty(exit.cause),
        );
        continue;
      }
      summary.credited += exit.value.credited;
      summary.alreadyCredited += exit.value.alreadyCredited;
      summary.internal += exit.value.internal;
      summary.unconfirmed += exit.value.unconfirmed;
      if (exit.value.hold !== null) {
        summary.held += 1;
        waiting.push({ wallet, hold: exit.value.hold });
      }
    }
    yield* applyCheck(yield* depositsHeldCheck(waiting, unread));
    return summary;
  });
}
