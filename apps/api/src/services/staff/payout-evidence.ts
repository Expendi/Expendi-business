import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ResolveOutcome } from "@expendi-business/shared";

import type { Payout, WalletTransaction } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { UsdcTransfer } from "../chain/base.js";
import { walletTransactions } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, ServiceUnavailable } from "../../errors.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { fromMicro } from "../paycrest/amounts.js";
import { Paycrest } from "../paycrest/paycrest-client.js";

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
  "id" | "type" | "usdcAmount" | "txHash" | "createdAt"
>;

export interface PayoutEvidence {
  /** Paycrest's status fetched just now; null for a USDC payout or no order. */
  readonly paycrestStatus: string | null;
  readonly fundingStarted: boolean;
  /** Every USDC transfer from the company wallet to the deposit address. */
  readonly depositTransfers: readonly UsdcTransfer[];
  readonly ledgerDebits: readonly LedgerRow[];
  readonly refunds: readonly LedgerRow[];
}

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

/** Paycrest's view of the order and the chain's view of the funding. */
export function gatherChainAndPaycrest(
  payout: Payout,
  walletAddress: string | null,
): Effect.Effect<
  Pick<
    PayoutEvidence,
    "paycrestStatus" | "fundingStarted" | "depositTransfers"
  >,
  ServiceUnavailable | Conflict,
  Paycrest | BaseRpc
> {
  return Effect.gen(function* () {
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
      return { paycrestStatus, fundingStarted: false, depositTransfers: [] };
    }
    if (!payout.depositAddress || !walletAddress) {
      return yield* Effect.fail(
        new Conflict({
          message:
            "Funding started but the payout has no deposit address or wallet to check. Check it by hand.",
        }),
      );
    }
    const depositAddress = payout.depositAddress;
    const rpc = yield* BaseRpc;
    const depositTransfers = yield* Effect.gen(function* () {
      const latest = yield* rpc.blockNumber();
      const elapsedBlocks = BigInt(
        Math.ceil(
          Math.max(0, Date.now() - fundingStartedAt.getTime()) / BASE_BLOCK_MS,
        ),
      );
      const fromBlock = latest - elapsedBlocks - SEARCH_MARGIN_BLOCKS;
      return yield* rpc.usdcTransfersBetween({
        from: walletAddress,
        to: depositAddress,
        fromBlock: fromBlock > 0n ? fromBlock : 0n,
      });
    }).pipe(
      Effect.mapError((error) =>
        unavailable(
          `Couldn't search the chain for the funding transfer (${error.message}).`,
        ),
      ),
    );
    return { paycrestStatus, fundingStarted: true, depositTransfers };
  });
}

export interface ResolutionPlan {
  /** The transfer to record as the payout's ledger debit, when it has none. */
  readonly debitToRecord: UsdcTransfer | null;
  /** What confirming does, in words, for the review step. */
  readonly consequences: readonly string[];
}

const refuse = (message: string) => Effect.fail(new Conflict({ message }));

const usdc = (amount: bigint) => `${fromMicro(amount)} USDC`;

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
  if (evidence.fundingStarted && payout.fundingStartedAt) {
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
