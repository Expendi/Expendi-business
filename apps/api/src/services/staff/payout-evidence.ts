import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ResolveOutcome, WalletChain } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type {
  Payout,
  Wallet,
  WalletTransaction,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpcError } from "../chain/base-rpc.js";
import type { UsdcTransfer } from "../chain/base.js";
import type { NearRpc } from "../chain/near-rpc.js";
import type { NearChain } from "../chain/near.js";
import type { NearEvidence, NearSendEvidence } from "./near-send-evidence.js";
import { walletTransactions } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, ServiceUnavailable } from "../../errors.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { fromMicro } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import {
  gatherNearSends,
  SEND_RELEASE_MARGIN_BLOCKS,
} from "./near-send-evidence.js";

/**
 * What must be true before staff may close a payout under review (README
 * rule 4, spec §6.8): the ledger keeps matching the chain, and nothing is
 * ever sent or re-sent. The evidence is gathered fresh from Paycrest and
 * the chain each time, and an outcome it doesn't support is refused.
 */

/** Paycrest paid the recipient (it says to notify at validated). */
const PAYCREST_PAID = new Set(["validated", "settled"]);
/** Paycrest is paying, or has paid, the recipient. */
const PAYCREST_PAYING_OR_PAID = new Set(["validated", "settling", "settled"]);
/** Paycrest closed the order without taking a deposit. */
const PAYCREST_CLOSED = new Set(["expired", "cancelled"]);

/**
 * How long after funding started a transfer could still land. Past this,
 * finding none on chain means none was sent.
 */
export const SEND_SETTLE_MS = 30 * 60_000;

/** Base makes a block every 2 seconds. */
const BASE_BLOCK_MS = 2_000;
/** Searched before funding started, in case the clocks disagree: an hour. */
const SEARCH_MARGIN_BLOCKS = 1_800n;

export type LedgerRow = Pick<
  WalletTransaction,
  "id" | "type" | "usdcAmount" | "chain" | "txHash" | "createdAt"
>;

export interface PayoutEvidence {
  /** Paycrest's status fetched just now; null for a USDC payout or no order. */
  readonly paycrestStatus: string | null;
  readonly fundingStarted: boolean;
  /**
   * Every USDC transfer from the wallet that funds the payout to the
   * deposit address: from the company wallet on NEAR for a USDC payee
   * there, otherwise from the company's wallet on Base.
   */
  readonly depositTransfers: readonly UsdcTransfer[];
  /** The chain `depositTransfers` were read from. */
  readonly chain: WalletChain;
  /** A NEAR payout's company wallet sends; null for a payout funded on Base. */
  readonly near: NearEvidence | null;
  readonly ledgerDebits: readonly LedgerRow[];
  readonly refunds: readonly LedgerRow[];
}

/** The wallet a payout is funded from, as the evidence needs it. */
export type FundingWallet = Pick<
  Wallet,
  "chain" | "address" | "transitAddress"
>;

/** Whether the payout is USDC paid straight from a company wallet on NEAR. */
export const isPaidOnNear = (payout: Payout, wallet: FundingWallet): boolean =>
  payout.provider === "onchain" &&
  payout.recipient.method === "usdc" &&
  payout.recipient.chain === "near" &&
  wallet.chain === "near";

/** The payout's ledger rows: its debit (at most one) and any refunds. */
export function payoutLedger(
  tx: Transaction,
  payoutId: string,
): Effect.Effect<{ debits: LedgerRow[]; refunds: LedgerRow[] }, DatabaseError> {
  return query(() =>
    tx
      .select({
        id: walletTransactions.id,
        type: walletTransactions.type,
        usdcAmount: walletTransactions.usdcAmount,
        chain: walletTransactions.chain,
        txHash: walletTransactions.txHash,
        createdAt: walletTransactions.createdAt,
      })
      .from(walletTransactions)
      .where(
        and(
          eq(walletTransactions.payoutId, payoutId),
          inArray(walletTransactions.type, ["payout", "withdrawal", "refund"]),
        ),
      )
      .orderBy(walletTransactions.createdAt),
  ).pipe(
    Effect.map((rows) => ({
      debits: rows.filter((row) => row.type !== "refund"),
      refunds: rows.filter((row) => row.type === "refund"),
    })),
  );
}

const unavailable = (what: string) =>
  new ServiceUnavailable({
    message: `${what} Nothing was changed; try again shortly.`,
  });

/**
 * The USDC a NEAR payout's sends moved from the company wallet to the
 * payee, read from the relayer transactions saved with each send.
 */
function nearDepositTransfers(
  payout: Payout,
  walletAddress: string,
  near: NearEvidence,
): UsdcTransfer[] {
  return near.sends.flatMap(({ transactions }) =>
    transactions.flatMap(({ outcome }) =>
      (outcome?.usdcTransfers ?? [])
        .filter(
          (transfer) =>
            transfer.from === walletAddress &&
            transfer.to === payout.depositAddress,
        )
        .map((transfer) => ({
          from: transfer.from,
          to: transfer.to,
          amount: transfer.amount,
          logIndex: transfer.logIndex,
          blockNumber: transfer.blockHeight,
          txHash: transfer.txHash,
        })),
    ),
  );
}

type ChainEvidence = Pick<
  PayoutEvidence,
  "paycrestStatus" | "fundingStarted" | "depositTransfers" | "chain" | "near"
>;

/**
 * Every USDC transfer from `from` to `to` on Base mined since about
 * `since`: the search starts an hour before it, in case the clocks
 * disagree.
 */
export function baseTransfersSince(input: {
  readonly from: string;
  readonly to: string;
  readonly since: Date;
}): Effect.Effect<UsdcTransfer[], BaseRpcError, BaseRpc> {
  return Effect.gen(function* () {
    const rpc = yield* BaseRpc;
    const latest = yield* rpc.blockNumber();
    const elapsedBlocks = BigInt(
      Math.ceil(
        Math.max(0, Date.now() - input.since.getTime()) / BASE_BLOCK_MS,
      ),
    );
    const fromBlock = latest - elapsedBlocks - SEARCH_MARGIN_BLOCKS;
    return yield* rpc.usdcTransfersBetween({
      from: input.from,
      to: input.to,
      fromBlock: fromBlock > 0n ? fromBlock : 0n,
    });
  });
}

/** Paycrest's view of the order and the chain's view of the funding. */
export function gatherChainAndPaycrest(
  payout: Payout,
  wallet: FundingWallet,
): Effect.Effect<
  ChainEvidence,
  ServiceUnavailable | Conflict | DatabaseError,
  DatabaseService | Paycrest | BaseRpc | NearRpc | NearChain
> {
  return Effect.gen(function* () {
    if (isPaidOnNear(payout, wallet)) {
      const near = yield* gatherNearSends(payout.organizationId, payout.id);
      return {
        paycrestStatus: null,
        fundingStarted: payout.fundingStartedAt !== null,
        depositTransfers:
          wallet.address === null
            ? []
            : nearDepositTransfers(payout, wallet.address, near),
        chain: "near",
        near,
      };
    }
    const base = { chain: "base", near: null } as const;
    // A company on NEAR funds its cash-outs from its transit wallet on Base.
    const walletAddress =
      wallet.chain === "base" ? wallet.address : wallet.transitAddress;
    let paycrestStatus: string | null = null;
    if (payout.provider === "paycrest" && payout.providerOrderId) {
      const paycrest = yield* Paycrest;
      const order = yield* paycrest
        .getOrder(payout.providerOrderId)
        .pipe(
          Effect.mapError((error) =>
            unavailable(
              `Paycrest didn't return order ${payout.providerOrderId} (${error.code}).`,
            ),
          ),
        );
      if (
        order.id !== payout.providerOrderId ||
        order.reference !== payout.id
      ) {
        return yield* Effect.fail(
          new Conflict({
            message: `Paycrest's order ${order.id} doesn't belong to this payout. Check it by hand.`,
          }),
        );
      }
      paycrestStatus = order.status.toLowerCase();
    }

    const fundingStartedAt = payout.fundingStartedAt;
    if (!fundingStartedAt) {
      return {
        ...base,
        paycrestStatus,
        fundingStarted: false,
        depositTransfers: [],
      };
    }
    if (!payout.depositAddress || !walletAddress) {
      return yield* Effect.fail(
        new Conflict({
          message:
            "Funding started but the payout has no deposit address or wallet to check. Check it by hand.",
        }),
      );
    }
    const depositTransfers = yield* baseTransfersSince({
      from: walletAddress,
      to: payout.depositAddress,
      since: fundingStartedAt,
    }).pipe(
      Effect.mapError((error) =>
        unavailable(
          `Couldn't search the chain for the funding transfer (${error.message}).`,
        ),
      ),
    );
    return { ...base, paycrestStatus, fundingStarted: true, depositTransfers };
  });
}

/**
 * How resolving a payout also closes a company wallet send that was still
 * open, so the wallet can send again: as run, in the transaction the chain
 * shows, or as never having moved anything.
 */
export interface SendClosure {
  readonly sendId: string;
  readonly status: "executed" | "failed" | "expired";
  readonly txHash: string | null;
  readonly blockHeight: bigint | null;
  readonly failure: string | null;
}

export interface ResolutionPlan {
  /** The transfer to record as the payout's ledger debit, when it has none. */
  readonly debitToRecord: UsdcTransfer | null;
  /** The company wallet sends still open that the resolution closes. */
  readonly sendsToClose: readonly SendClosure[];
  /** What confirming does, in words, for the review step. */
  readonly consequences: readonly string[];
}

const refuse = (message: string) => Effect.fail(new Conflict({ message }));

const usdc = (amount: bigint) => `${fromMicro(amount)} USDC`;

export const isOpen = ({ send }: NearSendEvidence): boolean =>
  send.status === "reserved" || send.status === "signed";

const movedAsSigned = ({ send, transactions }: NearSendEvidence) =>
  transactions.filter(({ outcome }) =>
    outcome?.usdcTransfers.some(
      (transfer) =>
        transfer.from === send.senderAccountId &&
        transfer.to === send.receiverAccountId,
    ),
  );

/**
 * How each company wallet send in `near` that is still open is closed: as
 * run (`ran`) only in the one saved transaction where the chain ran it and
 * moved exactly what was signed, and as never having moved anything
 * (`never_ran`) only once it can no longer run. A send that can't be
 * closed as run is refused with `consequence`, e.g. "the payout can't be
 * marked paid".
 */
export function planSendClosures(
  closeAs: "ran" | "never_ran",
  near: NearEvidence,
  consequence: string,
): Effect.Effect<SendClosure[], Conflict> {
  const closures: SendClosure[] = [];
  for (const evidence of near.sends.filter(isOpen)) {
    const { send, transactions } = evidence;
    const moved = movedAsSigned(evidence);
    if (closeAs === "ran") {
      const [ran, ...others] = moved;
      const exactly =
        others.length === 0 &&
        ran?.outcome?.sendRan === true &&
        ran.outcome.succeeded &&
        ran.outcome.usdcTransfers.length === 1 &&
        ran.outcome.usdcTransfers[0]?.amount === send.usdcAmount;
      if (!ran?.outcome || !exactly) {
        return refuse(
          `The chain doesn't show company wallet send ${send.id} moving exactly the USDC it signed, so ${consequence}.`,
        );
      }
      closures.push({
        sendId: send.id,
        status: "executed",
        txHash: ran.txHash,
        blockHeight: ran.outcome.blockHeight,
        failure: null,
      });
      continue;
    }
    if (moved.length > 0) continue;
    const closesAfter = send.maxBlockHeight + SEND_RELEASE_MARGIN_BLOCKS;
    if (near.finalBlockHeight <= closesAfter) {
      return refuse(
        `Company wallet send ${send.id} could run until block ${send.maxBlockHeight}, and the chain is at block ${near.finalBlockHeight}. Resolve it once the chain has passed block ${closesAfter}.`,
      );
    }
    const ranEmpty = transactions.find(({ outcome }) => outcome?.sendRan);
    closures.push(
      ranEmpty?.outcome
        ? {
            sendId: send.id,
            status: "failed",
            txHash: ranEmpty.txHash,
            blockHeight: ranEmpty.outcome.blockHeight,
            failure:
              "Closed by Expendi staff: the chain ran it, but the USDC contract moved nothing",
          }
        : {
            sendId: send.id,
            status: "expired",
            txHash: null,
            blockHeight: null,
            failure: `Closed by Expendi staff: expired at block ${send.maxBlockHeight} without running`,
          },
    );
  }
  return Effect.succeed(closures);
}

/** USDC a send's transactions moved somewhere it wasn't signed for. */
export const strayTransfers = (near: NearEvidence): number =>
  near.sends.reduce(
    (count, { send, transactions }) =>
      count +
      transactions.reduce(
        (inSend, { outcome }) =>
          inSend +
          (outcome?.usdcTransfers ?? []).filter(
            (transfer) =>
              transfer.from === send.senderAccountId &&
              (transfer.to !== send.receiverAccountId ||
                transfer.amount !== send.usdcAmount),
          ).length,
        0,
      ),
    0,
  );

/**
 * The NEAR Intents quote a payout waits on, if any: a cash-out's Base hop
 * until it has asked Paycrest for an order, and a USDC payout's delivery
 * quote throughout. What became of the quote decides what became of the
 * payout's money, so the quote is what staff resolve.
 */
export const quoteHolding = (payout: Payout): string | null =>
  payout.deliveryQuoteId ??
  (payout.orderRequestedAt === null ? payout.baseHopQuoteId : null);

/**
 * Whether `outcome` may close `payout` given `evidence`, and what closing
 * it records. Refuses anything that would leave the ledger out of step
 * with the chain.
 */
export function planResolution(
  payout: Payout,
  outcome: ResolveOutcome,
  evidence: PayoutEvidence,
  now: number,
): Effect.Effect<ResolutionPlan, Conflict> {
  const heldBy = quoteHolding(payout);
  if (heldBy !== null) {
    return refuse(
      `This payout waits on NEAR Intents quote ${heldBy}, and that quote decides where its money is. Resolve the quote instead.`,
    );
  }
  const { near } = evidence;
  if (near !== null && strayTransfers(near) > 0) {
    return refuse(
      "The company wallet's send moved USDC that doesn't match what was signed. That needs a correction by hand, not a resolution.",
    );
  }
  return planOutcome(payout, outcome, evidence, now).pipe(
    Effect.flatMap((plan) =>
      near === null
        ? Effect.succeed(plan)
        : planSendClosures(
            outcome === "paid" ? "ran" : "never_ran",
            near,
            "the payout can't be marked paid",
          ).pipe(
            Effect.map((sendsToClose) => ({
              ...plan,
              sendsToClose,
              consequences:
                sendsToClose.length === 0
                  ? plan.consequences
                  : [
                      ...plan.consequences,
                      outcome === "paid"
                        ? "The company wallet's open send is recorded as run, so the wallet can send again."
                        : "The company wallet's open send is closed as never having moved anything, so the wallet can send again. It can no longer run.",
                    ],
            })),
          ),
    ),
  );
}

function planOutcome(
  payout: Payout,
  outcome: ResolveOutcome,
  evidence: PayoutEvidence,
  now: number,
): Effect.Effect<ResolutionPlan, Conflict> {
  if (payout.status !== "needs_review") {
    return refuse(
      `Only a payout under review can be resolved; this one is ${payout.status}.`,
    );
  }
  const transfers = evidence.depositTransfers;
  if (transfers.length > 1) {
    return refuse(
      `${transfers.length} transfers went from the wallet to the deposit address. That needs a ledger correction by hand, not a resolution.`,
    );
  }
  const [transfer = null] = transfers;
  const [debit = null] = evidence.ledgerDebits;
  if (debit && !transfer) {
    return refuse(
      "The ledger has a debit for this payout but no transfer was found on chain. Check the chain before resolving.",
    );
  }
  if (debit && transfer && -debit.usdcAmount !== transfer.amount) {
    return refuse(
      `The ledger's debit (${usdc(-debit.usdcAmount)}) doesn't match the transfer on chain (${usdc(transfer.amount)}).`,
    );
  }
  const refunded = evidence.refunds.length > 0;
  const debitToRecord = !debit && transfer ? transfer : null;
  const ledgerLine = debitToRecord
    ? `One ledger debit of ${usdc(debitToRecord.amount)} is recorded for the transfer in ${debitToRecord.txHash}, so the ledger matches the chain.`
    : debit
      ? `The ledger already has this payout's debit of ${usdc(-debit.usdcAmount)}; it isn't changed.`
      : "The ledger isn't changed: nothing left the wallet.";
  const paycrestStatus = evidence.paycrestStatus;

  if (outcome === "paid") {
    if (refunded) {
      return refuse("A refund came back for this payout, so it wasn't paid.");
    }
    if (payout.provider === "paycrest") {
      if (!paycrestStatus || !PAYCREST_PAID.has(paycrestStatus)) {
        return refuse(
          `Paycrest reports the order ${paycrestStatus ?? "missing"}. A Paycrest payout is marked paid only once Paycrest reports it validated or settled.`,
        );
      }
    } else if (!transfer) {
      return refuse(
        `No transfer from the company wallet to ${payout.depositAddress ?? "the recipient"} was found on chain.`,
      );
    }
    if (transfer && transfer.amount !== payout.amountToTransferUsdc) {
      return refuse(
        `The transfer on chain was ${usdc(transfer.amount)}, not the ${usdc(payout.amountToTransferUsdc ?? 0n)} this payout sends.`,
      );
    }
    if (!debit && !transfer) {
      return refuse(
        "The ledger has no debit for this payout and its transfer wasn't found on chain, so the ledger can't be matched to the chain.",
      );
    }
    return Effect.succeed({
      debitToRecord,
      sendsToClose: [],
      consequences: [
        "The payout is marked paid. Nothing is sent.",
        ledgerLine,
        "The USDC held back for it while under review is released.",
      ],
    });
  }

  if (paycrestStatus && PAYCREST_PAYING_OR_PAID.has(paycrestStatus)) {
    return refuse(
      `Paycrest reports the order ${paycrestStatus}: the recipient is being or has been paid.`,
    );
  }
  const released = `The ${usdc(payout.maxDebitUsdc)} held back for it is released, and the company's admin can retry it as a new payout.`;
  if (refunded) {
    if (!transfer) {
      return refuse(
        "A refund came back but the transfer it returns wasn't found on chain, so the ledger can't be matched to the chain.",
      );
    }
    return Effect.succeed({
      debitToRecord,
      sendsToClose: [],
      consequences: [
        "The payout is marked failed. Nothing is sent or re-sent.",
        ledgerLine,
        `The refund of ${usdc(evidence.refunds.reduce((sum, row) => sum + row.usdcAmount, 0n))} already in the ledger stays.`,
        released,
      ],
    });
  }
  if (transfer) {
    return refuse(
      `${usdc(transfer.amount)} went to the deposit address in ${transfer.txHash} and no refund has come back. Wait for the refund before resolving it as failed.`,
    );
  }
  // A NEAR send has an expiry the chain enforces, checked with the send
  // itself; on Base only time says a transfer can no longer land.
  if (
    evidence.near === null &&
    evidence.fundingStarted &&
    payout.fundingStartedAt
  ) {
    const settledAt = payout.fundingStartedAt.getTime() + SEND_SETTLE_MS;
    if (now < settledAt) {
      return refuse(
        `Funding started less than ${SEND_SETTLE_MS / 60_000} minutes ago, so a transfer could still land. Try again after ${new Date(settledAt).toISOString()}.`,
      );
    }
    const depositWindowOpen =
      !payout.depositValidUntil || payout.depositValidUntil.getTime() > now;
    if (
      payout.provider === "paycrest" &&
      !(paycrestStatus && PAYCREST_CLOSED.has(paycrestStatus)) &&
      depositWindowOpen
    ) {
      return refuse(
        `Paycrest's order is ${paycrestStatus ?? "unknown"} and can still take a deposit${payout.depositValidUntil ? ` until ${payout.depositValidUntil.toISOString()}` : ""}. Resolve it once the order has expired.`,
      );
    }
  }
  return Effect.succeed({
    debitToRecord: null,
    sendsToClose: [],
    consequences: [
      "The payout is marked failed. Nothing is sent or re-sent.",
      evidence.fundingStarted
        ? "No transfer from the wallet to the deposit address was found on chain."
        : "Funding never started, so nothing left the wallet.",
      ledgerLine,
      released,
    ],
  });
}
