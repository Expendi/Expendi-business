import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import type {
  IntentQuoteResolution,
  PayeeChain,
  WalletChain,
} from "@expendi-business/shared";
import { PAYEE_CHAIN_NAMES, PAYEE_CHAINS } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { FastNearTransferPage } from "../chain/fast-near.js";
import type { NearEvidence } from "./near-send-evidence.js";
import type { LedgerRow, SendClosure } from "./payout-evidence.js";
import { payouts } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, ServiceUnavailable } from "../../errors.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";
import { FAST_NEAR_MAX_PAGE_SIZE, FastNear } from "../chain/fast-near.js";
import { NearRpc } from "../chain/near-rpc.js";
import { NearChain, nearUsdcReceiptTransfersIn } from "../chain/near.js";
import { ONE_CLICK_USDC_ASSET_IDS } from "../intents/one-click.js";
import { quoteSendKey, UNSETTLED_REVIEW_MS } from "../intents/quote-settle.js";
import { fromMicro } from "../paycrest/amounts.js";
import { gatherNearSendsByKey } from "./near-send-evidence.js";
import {
  baseTransfersSince,
  payoutLedger,
  planSendClosures,
  strayTransfers,
} from "./payout-evidence.js";

/**
 * What must be true before staff may resolve a NEAR Intents quote under
 * review (docs/decisions/near-main-chain.md, spec §6.8): the outcome is
 * shown by the chains, never taken on anyone's word, and resolving only
 * corrects records. Nothing is signed, sent or re-sent; the payouts the
 * quote held go back to the code that follows them, which applies the
 * outcome as it would have had 1Click reported it.
 *
 * A quote's transactions are found through the hashes 1Click lists for it:
 * a refund, a sweep's delivery and anyone's withdrawal all reach a NEAR
 * account from `intents.near`, so only 1Click's listing ties a transfer to
 * this quote. Each one is then read from the chain itself.
 */

const BASE_TX_HASH = /^0x[0-9a-fA-F]{64}$/;

/**
 * How many pages of a NEAR account's transfers are searched for one listed
 * by 1Click: 5,000 transfers. The indexer lists them oldest first, so a
 * transfer further in is not found and the outcome it would show is
 * refused.
 */
const NEAR_SEARCH_MAX_PAGES = 50;

export interface QuoteTransfer {
  readonly chain: WalletChain;
  /** Base58 on NEAR (never lowercase it), lowercased 0x on Base. */
  readonly txHash: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly blockNumber: bigint;
  /** Tells two transfers in one transaction apart. */
  readonly position: string;
}

/**
 * What Base shows of the deposit transaction Privy gave for a quote the
 * transit wallet pays: none was saved, not mined (yet), reverted, or mined.
 */
export type SavedBaseDeposit = "none" | "pending" | "reverted" | "mined";

export interface QuoteEvidence {
  readonly originChain: WalletChain;
  readonly destinationChain: PayeeChain;
  /** The paying wallet's transfers to the deposit address, on the origin chain. */
  readonly deposits: readonly QuoteTransfer[];
  /** Transfers to the recipient in a transaction 1Click lists. */
  readonly deliveries: readonly QuoteTransfer[];
  /** Transfers to the refund address in a transaction 1Click lists. */
  readonly refunds: readonly QuoteTransfer[];
  /** Destination transactions 1Click lists on a chain nothing here reads. */
  readonly unreadDeliveries: readonly string[];
  /** The company wallet sends paying the quote; null when it starts on Base. */
  readonly near: NearEvidence | null;
  readonly savedDeposit: SavedBaseDeposit;
}

export type EvidenceDeps =
  DatabaseService | BaseRpc | NearRpc | NearChain | FastNear;

const unavailable = (what: string) =>
  new ServiceUnavailable({
    message: `${what} Nothing was changed; try again shortly.`,
  });

const refuse = (message: string) => Effect.fail(new Conflict({ message }));

const usdc = (amount: bigint) => `${fromMicro(amount)} USDC`;

const total = (transfers: readonly QuoteTransfer[]): bigint =>
  transfers.reduce((sum, transfer) => sum + transfer.amount, 0n);

/** The chain a 1Click USDC asset ID is on, or null for any other asset. */
export function chainOfAsset(assetId: string): PayeeChain | null {
  return (
    PAYEE_CHAINS.find((chain) => ONE_CLICK_USDC_ASSET_IDS[chain] === assetId) ??
    null
  );
}

/** The chain the quote's USDC leaves from: NEAR or Base. */
export function originChainOf(
  quote: Pick<IntentQuote, "originAsset">,
): WalletChain | null {
  const chain = chainOfAsset(quote.originAsset);
  return chain === "near" || chain === "base" ? chain : null;
}

/** Every transaction 1Click has listed for the quote, once each. */
const listedHashes = (
  quote: Pick<
    IntentQuote,
    "nearTxHashes" | "originChainTxHashes" | "destinationChainTxHashes"
  >,
): string[] => [
  ...new Set([
    ...quote.nearTxHashes,
    ...quote.originChainTxHashes,
    ...quote.destinationChainTxHashes,
  ]),
];

/**
 * The least the recipient is owed: the exact amount for `EXACT_OUTPUT`,
 * the quote's floor for `EXACT_INPUT`. A refund of a deposit is at least
 * this too, while what an `EXACT_OUTPUT` quote returns after delivering is
 * only its unused buffer.
 */
const guaranteedOut = (
  quote: Pick<IntentQuote, "minAmountOut" | "amountOut">,
): bigint => quote.minAmountOut ?? quote.amountOut;

/**
 * USDC transfers to `accountId` on NEAR in the transactions `txHashes`
 * names. The indexer says where to look; each transfer is then read from
 * the transaction's final outcome, as the deposit watcher reads them.
 */
function nearTransfersTo(
  accountId: string,
  txHashes: ReadonlySet<string>,
): Effect.Effect<QuoteTransfer[], ServiceUnavailable, EvidenceDeps> {
  if (txHashes.size === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const fastNear = yield* FastNear;
    const rpc = yield* NearRpc;
    const chain = yield* NearChain;
    const found: QuoteTransfer[] = [];
    let resumeToken: string | null = null;
    for (let page = 0; page < NEAR_SEARCH_MAX_PAGES; page += 1) {
      const listed: FastNearTransferPage = yield* fastNear.usdcTransfersTo({
        accountId,
        limit: FAST_NEAR_MAX_PAGE_SIZE,
        resumeToken,
      });
      for (const row of listed.transfers) {
        if (!txHashes.has(row.transactionId)) continue;
        const outcome = yield* rpc.transactionOutcome(
          row.transactionId,
          row.signerId,
        );
        if (outcome === null) continue;
        for (const transfer of nearUsdcReceiptTransfersIn(
          outcome,
          chain.usdcContractId,
        )) {
          const position = `${transfer.receiptId}:${transfer.receiptLogIndex}:${transfer.transferIndex}`;
          if (
            transfer.to !== accountId ||
            transfer.receiptId !== row.receiptId ||
            transfer.amount !== row.amount ||
            found.some((seen) => seen.position === position)
          ) {
            continue;
          }
          found.push({
            chain: "near",
            txHash: transfer.txHash,
            from: transfer.from,
            to: transfer.to,
            amount: transfer.amount,
            blockNumber: transfer.blockHeight,
            position,
          });
        }
      }
      const next = listed.resumeToken;
      if (
        listed.transfers.length < FAST_NEAR_MAX_PAGE_SIZE ||
        next === null ||
        next === resumeToken
      ) {
        break;
      }
      resumeToken = next;
    }
    return found;
  }).pipe(
    Effect.mapError((error) =>
      unavailable(
        `Couldn't read NEAR transfers to ${accountId} (${error.message}).`,
      ),
    ),
  );
}

const baseTransfer = (transfer: {
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly logIndex: number;
  readonly blockNumber: bigint;
  readonly txHash: string;
}): QuoteTransfer => ({
  chain: "base",
  txHash: transfer.txHash,
  from: transfer.from,
  to: transfer.to,
  amount: transfer.amount,
  blockNumber: transfer.blockNumber,
  position: String(transfer.logIndex),
});

/**
 * What 1Click, the chains and the company wallet's saved sends show of a
 * quote, read fresh. Only reads.
 */
export function gatherQuoteEvidence(
  quote: IntentQuote,
): Effect.Effect<
  QuoteEvidence,
  ServiceUnavailable | Conflict | DatabaseError,
  EvidenceDeps
> {
  return Effect.gen(function* () {
    const originChain = originChainOf(quote);
    const destinationChain = chainOfAsset(quote.destinationAsset);
    if (originChain === null || destinationChain === null) {
      return yield* refuse(
        "This quote moves an asset other than USDC on NEAR, Base or Solana. Check it by hand.",
      );
    }
    const listed = listedHashes(quote);
    const nearHashes = new Set(
      listed.filter((hash) => !BASE_TX_HASH.test(hash)),
    );
    const rpc = yield* BaseRpc;
    const baseReceipts = yield* Effect.forEach(
      listed.filter((hash) => BASE_TX_HASH.test(hash)),
      (hash) => rpc.getTransactionReceipt(hash),
    ).pipe(
      Effect.mapError((error) =>
        unavailable(
          `Couldn't read 1Click's transactions on Base (${error.message}).`,
        ),
      ),
    );
    const listedOnBase = (to: string) =>
      baseReceipts
        .flatMap((receipt) => (receipt ? usdcTransfersIn(receipt) : []))
        .filter((transfer) => transfer.to === to.toLowerCase())
        .map(baseTransfer);

    let near: NearEvidence | null = null;
    let deposits: QuoteTransfer[] = [];
    let savedDeposit: SavedBaseDeposit = "none";
    if (originChain === "near") {
      near = yield* gatherNearSendsByKey(
        quote.organizationId,
        quoteSendKey(quote.id),
      );
      deposits = near.sends.flatMap(({ transactions }) =>
        transactions.flatMap(({ outcome }) =>
          (outcome?.usdcTransfers ?? [])
            .filter(
              (transfer) =>
                transfer.from === quote.refundTo &&
                transfer.to === quote.depositAddress,
            )
            .map((transfer) => ({
              chain: "near" as const,
              txHash: transfer.txHash,
              from: transfer.from,
              to: transfer.to,
              amount: transfer.amount,
              blockNumber: transfer.blockHeight,
              position: String(transfer.logIndex),
            })),
        ),
      );
    } else {
      const startedAt = quote.depositStartedAt;
      const searched = startedAt
        ? yield* baseTransfersSince({
            from: quote.refundTo,
            to: quote.depositAddress,
            since: startedAt,
          }).pipe(
            Effect.mapError((error) =>
              unavailable(
                `Couldn't search Base for the transit wallet's deposit (${error.message}).`,
              ),
            ),
          )
        : [];
      deposits = searched.map(baseTransfer);
      if (quote.depositTxHash !== null) {
        const receipt = yield* rpc
          .getTransactionReceipt(quote.depositTxHash)
          .pipe(
            Effect.mapError((error) =>
              unavailable(
                `Couldn't read the deposit transaction from Base (${error.message}).`,
              ),
            ),
          );
        savedDeposit =
          receipt === null
            ? "pending"
            : receipt.status === "0x1"
              ? "mined"
              : "reverted";
        for (const transfer of receipt ? usdcTransfersIn(receipt) : []) {
          const found = baseTransfer(transfer);
          if (
            transfer.from === quote.refundTo.toLowerCase() &&
            transfer.to === quote.depositAddress.toLowerCase() &&
            !deposits.some(
              (seen) =>
                seen.txHash === found.txHash &&
                seen.position === found.position,
            )
          ) {
            deposits.push(found);
          }
        }
      }
    }

    const deliveries =
      destinationChain === "base"
        ? listedOnBase(quote.recipient)
        : destinationChain === "near"
          ? yield* nearTransfersTo(quote.recipient, nearHashes)
          : [];
    const refunds =
      originChain === "base"
        ? listedOnBase(quote.refundTo)
        : yield* nearTransfersTo(quote.refundTo, nearHashes);
    return {
      originChain,
      destinationChain,
      deposits,
      deliveries,
      refunds,
      unreadDeliveries:
        destinationChain === "solana" ? quote.destinationChainTxHashes : [],
      near,
      savedDeposit,
    };
  });
}

/** One payout a quote moves money for, with its ledger rows. */
export interface QuotePayout {
  readonly payout: Payout;
  readonly debits: readonly LedgerRow[];
  readonly refunds: readonly LedgerRow[];
}

/**
 * The payouts `quote` moves money for: a Base hop's cash-outs, or a
 * delivery's one USDC payout. With `lock`, each row is locked for the rest
 * of `tx`.
 */
export function quotePayouts(
  tx: Transaction,
  quote: Pick<IntentQuote, "id" | "organizationId" | "purpose">,
  lock = false,
): Effect.Effect<QuotePayout[], DatabaseError> {
  const link =
    quote.purpose === "base_hop"
      ? eq(payouts.baseHopQuoteId, quote.id)
      : quote.purpose === "usdc_payout"
        ? eq(payouts.deliveryQuoteId, quote.id)
        : null;
  if (link === null) return Effect.succeed([]);
  return Effect.gen(function* () {
    const select = tx
      .select()
      .from(payouts)
      .where(and(eq(payouts.organizationId, quote.organizationId), link))
      .orderBy(asc(payouts.createdAt), asc(payouts.id));
    const rows = yield* query(() => (lock ? select.for("update") : select));
    return yield* Effect.forEach(rows, (payout) =>
      payoutLedger(tx, payout.id).pipe(
        Effect.map((ledger) => ({ payout, ...ledger })),
      ),
    );
  });
}

/**
 * Whether the quote holds `payout` under review: a cash-out its Base hop
 * put there before any order was asked for, or the USDC payout it
 * delivers. What the quote did decides where the payout's money is.
 */
export function isHeldBy(
  quote: Pick<IntentQuote, "purpose">,
  payout: Pick<Payout, "status" | "orderRequestedAt">,
): boolean {
  if (payout.status !== "needs_review") return false;
  return (
    quote.purpose === "usdc_payout" ||
    (quote.purpose === "base_hop" && payout.orderRequestedAt === null)
  );
}

/** Where a payout the quote held goes back to, for the code that follows it. */
export interface PayoutReturn {
  readonly payoutId: string;
  readonly status: "approved" | "funding" | "paying";
}

export interface QuoteResolutionPlan {
  /** The status the quote is settled as now; null when 1Click settled it. */
  readonly settleAs: "succeeded" | "refunded" | "failed" | null;
  readonly failure: string | null;
  /** The deposit the quote's row lacks, once the chain shows it ran. */
  readonly deposit: {
    readonly txHash: string;
    readonly companyWalletSendId: string | null;
  } | null;
  readonly sendsToClose: readonly SendClosure[];
  readonly payoutsToReturn: readonly PayoutReturn[];
  /** What confirming does, in words, for the review step. */
  readonly consequences: readonly string[];
}

const SETTLED_BY_ONE_CLICK: Partial<
  Record<IntentQuote["status"], IntentQuoteResolution>
> = { succeeded: "delivered", refunded: "refunded" };

const RESOLVED_AS: Readonly<
  Record<IntentQuoteResolution, "succeeded" | "refunded" | "failed">
> = { delivered: "succeeded", refunded: "refunded", never_deposited: "failed" };

/**
 * Whether `outcome` may resolve `quote` given `evidence`, and what resolving
 * it records. Refuses whatever the evidence doesn't show, and anything that
 * would leave the ledger out of step with the chain.
 */
export function planQuoteResolution(input: {
  readonly quote: IntentQuote;
  readonly outcome: IntentQuoteResolution;
  readonly evidence: QuoteEvidence;
  readonly payouts: readonly QuotePayout[];
  readonly now: number;
}): Effect.Effect<QuoteResolutionPlan, Conflict> {
  const { quote, outcome, evidence, now } = input;
  const wallet =
    evidence.originChain === "near"
      ? "the company wallet"
      : "the transit wallet";
  const origin = PAYEE_CHAIN_NAMES[evidence.originChain];
  const destination = PAYEE_CHAIN_NAMES[evidence.destinationChain];
  const owed = guaranteedOut(quote);
  const held = input.payouts.filter(({ payout }) => isHeldBy(quote, payout));
  const openSends = (evidence.near?.sends ?? []).filter(
    ({ send }) => send.status === "reserved" || send.status === "signed",
  );

  if (quote.purpose === "fund_in") {
    return refuse("A fund-in isn't resolved here: it moves no payout's money.");
  }
  const settledBy = SETTLED_BY_ONE_CLICK[quote.status];
  if (quote.status !== "needs_review") {
    if (settledBy === undefined) {
      return refuse(
        `Only a quote under review can be resolved; this one is ${quote.status}.`,
      );
    }
    if (held.length === 0 && openSends.length === 0) {
      return refuse(
        `1Click settled this quote as ${quote.status}, and nothing it holds is left under review.`,
      );
    }
    if (outcome !== settledBy) {
      return refuse(
        `1Click reports this quote ${quote.oneClickStatus ?? quote.status}: it was ${settledBy.replace("_", " ")}, not ${outcome.replace("_", " ")}.`,
      );
    }
  } else {
    const reviewFrom = quote.deadline.getTime() + UNSETTLED_REVIEW_MS;
    if (now < reviewFrom) {
      return refuse(
        `1Click may still settle this quote: its deadline was ${quote.deadline.toISOString()}. Resolve it after ${new Date(reviewFrom).toISOString()}.`,
      );
    }
  }
  if (evidence.near !== null && strayTransfers(evidence.near) > 0) {
    return refuse(
      "The company wallet's send moved USDC that doesn't match what was signed. That needs a correction by hand, not a resolution.",
    );
  }
  if (evidence.deposits.length > 1) {
    return refuse(
      `${evidence.deposits.length} transfers went from ${wallet} to the deposit address. That needs a correction by hand, not a resolution.`,
    );
  }
  const [deposit = null] = evidence.deposits;
  if (deposit !== null && deposit.amount !== quote.amountIn) {
    return refuse(
      `${wallet} sent ${usdc(deposit.amount)} to the deposit address, not the quote's ${usdc(quote.amountIn)}. That needs a correction by hand.`,
    );
  }
  const delivered = total(evidence.deliveries);
  const refunded = total(evidence.refunds);
  const deliveryShown =
    evidence.destinationChain === "solana"
      ? evidence.unreadDeliveries.length > 0
      : delivered >= owed;
  const refundShown = refunded >= owed;

  return Effect.gen(function* () {
    let sendsToClose: SendClosure[] = [];
    const lines: string[] = [];
    if (outcome === "never_deposited") {
      if (deposit !== null) {
        return yield* refuse(
          `${usdc(deposit.amount)} went from ${wallet} to the deposit address in ${deposit.txHash}, so the deposit did leave it.`,
        );
      }
      if (
        (quote.oneClickStatus !== null &&
          quote.oneClickStatus !== "PENDING_DEPOSIT") ||
        quote.depositedAmount !== null
      ) {
        return yield* refuse(
          `1Click reports ${quote.oneClickStatus ?? "a deposit"}${quote.depositedAmount === null ? "" : ` of ${usdc(quote.depositedAmount)}`}: it has seen a deposit, so the deposit can't be closed as never sent.`,
        );
      }
      if (
        evidence.deliveries.length > 0 ||
        evidence.refunds.length > 0 ||
        evidence.unreadDeliveries.length > 0
      ) {
        return yield* refuse(
          "1Click lists transactions that moved USDC for this quote, so its deposit did leave the wallet. Check it by hand.",
        );
      }
      if (evidence.near?.sends.some(({ send }) => send.status === "executed")) {
        return yield* refuse(
          "A company wallet send for this quote is recorded as run, but the chain doesn't show it now. Check it by hand.",
        );
      }
      if (evidence.savedDeposit === "pending") {
        return yield* refuse(
          `Privy gave ${quote.depositTxHash ?? "a transaction"} for the transit wallet's deposit, and Base doesn't show it yet: it could still be mined.`,
        );
      }
      if (evidence.savedDeposit === "mined") {
        return yield* refuse(
          `Base shows the transit wallet's deposit ${quote.depositTxHash ?? ""} mined. Check what it moved by hand.`,
        );
      }
      if (evidence.near !== null) {
        sendsToClose = yield* planSendClosures(
          "never_ran",
          evidence.near,
          "the deposit can't be closed as never sent",
        );
      }
      lines.push(
        `The quote is closed as failed: its deposit never left ${wallet}. Nothing is sent or re-sent.`,
      );
    } else {
      if (deposit === null) {
        return yield* refuse(
          `No deposit of ${usdc(quote.amountIn)} from ${wallet} to the deposit address was found on ${origin}, so the quote can't have been ${outcome}.`,
        );
      }
      if (outcome === "delivered") {
        if (!deliveryShown) {
          return yield* refuse(
            evidence.destinationChain === "solana"
              ? "1Click lists no Solana transaction for the delivery. Solana isn't read here, so a delivery there needs 1Click's transaction."
              : `${destination} shows ${usdc(delivered)} reaching ${quote.recipient} in the transactions 1Click lists, not the ${usdc(owed)} the quote delivers.`,
          );
        }
        if (refundShown) {
          return yield* refuse(
            `${origin} also shows ${usdc(refunded)} refunded to ${wallet}. Delivered and refunded can't both be true; check it by hand.`,
          );
        }
      } else {
        if (!refundShown) {
          return yield* refuse(
            `${origin} shows ${usdc(refunded)} back in ${wallet} in the transactions 1Click lists, not a refund of at least ${usdc(owed)}.`,
          );
        }
        if (
          evidence.deliveries.length > 0 ||
          evidence.unreadDeliveries.length > 0
        ) {
          return yield* refuse(
            `1Click lists a delivery to ${quote.recipient} on ${destination} as well. Delivered and refunded can't both be true; check it by hand.`,
          );
        }
      }
      if (evidence.near !== null) {
        sendsToClose = yield* planSendClosures(
          "ran",
          evidence.near,
          "the quote's deposit can't be recorded as run",
        );
      }
      const shown =
        outcome === "refunded"
          ? `${origin} shows ${usdc(refunded)} back in ${wallet}`
          : evidence.destinationChain === "solana"
            ? `1Click lists ${evidence.unreadDeliveries.join(", ")} as the delivery on Solana, which isn't read here`
            : `${destination} shows ${usdc(delivered)} delivered to ${quote.recipient}`;
      lines.push(
        quote.status === "needs_review"
          ? `The quote is closed as ${RESOLVED_AS[outcome]}: ${shown}. Nothing is sent or re-sent.`
          : `1Click already settled the quote as ${quote.status}, and ${shown}.`,
      );
    }
    if (sendsToClose.length > 0) {
      lines.push(
        outcome === "never_deposited"
          ? "The company wallet's open send is closed as never having moved anything, so the wallet can send again. It can no longer run."
          : "The company wallet's open send is recorded as run, so the wallet can send again.",
      );
    }

    const ranIn = sendsToClose.find((closure) => closure.status === "executed");
    const executed = evidence.near?.sends.find(
      ({ send }) =>
        send.status === "executed" && send.txHash === deposit?.txHash,
    );
    const recordedDeposit =
      outcome === "never_deposited" || deposit === null
        ? null
        : evidence.originChain === "near"
          ? quote.companyWalletSendId === null
            ? {
                txHash: deposit.txHash,
                companyWalletSendId: ranIn?.sendId ?? executed?.send.id ?? null,
              }
            : null
          : quote.depositTxHash === null
            ? { txHash: deposit.txHash, companyWalletSendId: null }
            : null;
    if (
      recordedDeposit !== null &&
      evidence.originChain === "near" &&
      recordedDeposit.companyWalletSendId === null
    ) {
      return yield* refuse(
        "The deposit shows on chain, but not as one of the company wallet's saved sends. Check it by hand.",
      );
    }

    const payoutsToReturn: PayoutReturn[] = [];
    for (const { payout, debits, refunds } of input.payouts) {
      const debited = debits.length > 0;
      const netted =
        debits.reduce((sum, row) => sum + row.usdcAmount, 0n) +
          refunds.reduce((sum, row) => sum + row.usdcAmount, 0n) ===
        0n;
      if (quote.purpose === "usdc_payout") {
        if (payout.status === "paid" && outcome !== "delivered") {
          return yield* refuse(
            `Payout ${payout.id} was closed as paid, but the evidence shows the USDC ${outcome.replace("_", " ")}. That needs a ledger correction by hand.`,
          );
        }
        if (
          payout.status === "failed" &&
          (outcome === "delivered" || !netted)
        ) {
          return yield* refuse(
            `Payout ${payout.id} was closed as failed, and its ledger doesn't match the quote being ${outcome.replace("_", " ")}. That needs a ledger correction by hand.`,
          );
        }
        if (outcome === "never_deposited" && debited) {
          return yield* refuse(
            `Payout ${payout.id} is debited for a deposit, but the chain shows none. That needs a ledger correction by hand.`,
          );
        }
      }
      if (!isHeldBy(quote, payout)) continue;
      payoutsToReturn.push({
        payoutId: payout.id,
        status:
          quote.purpose === "base_hop"
            ? "approved"
            : debited
              ? "paying"
              : "funding",
      });
    }
    if (payoutsToReturn.length > 0) {
      lines.push(
        quote.purpose === "base_hop"
          ? outcome === "delivered"
            ? `${payoutsToReturn.length} cash-out${payoutsToReturn.length === 1 ? "" : "s"} go back to approved. The outbound quotes job orders and funds them from the transit wallet as after any delivered hop; one whose approval lapsed meanwhile is released by reconciliation instead, with nothing sent.`
            : `${payoutsToReturn.length} cash-out${payoutsToReturn.length === 1 ? "" : "s"} go back to approved, and the outbound quotes job fails them with nothing sent, as for any hop that ${outcome === "refunded" ? "was refunded" : "never happened"}. The company's admin can retry them.`
          : outcome === "delivered"
            ? "The payout goes back to the delivery code, which marks it paid with 1Click's delivery transaction as its reference and debits the ledger once, if it isn't already."
            : outcome === "refunded"
              ? "The payout goes back to the delivery code, which fails it and credits the refund to the ledger, as for any refunded delivery. The company's admin can retry it."
              : "The payout goes back to the delivery code, which fails it with nothing sent and no ledger entry. The company's admin can retry it.",
      );
    }
    if (quote.purpose === "sweep") {
      lines.push(
        "A sweep moves the company's money between its own wallets, so the ledger isn't changed.",
      );
    }
    if (quote.status === "needs_review") {
      lines.push(
        "The company's sweeps, and the crediting of deposits this quote could explain, are no longer held up by it.",
      );
    }
    return {
      settleAs: quote.status === "needs_review" ? RESOLVED_AS[outcome] : null,
      failure:
        outcome === "delivered"
          ? null
          : outcome === "refunded"
            ? `Resolved by Expendi staff as refunded: ${origin} shows the deposit back in ${wallet}.`
            : `Closed by Expendi staff: the deposit never left ${wallet}. Nothing moved.`,
      deposit: recordedDeposit,
      sendsToClose,
      payoutsToReturn,
      consequences: lines,
    };
  });
}
