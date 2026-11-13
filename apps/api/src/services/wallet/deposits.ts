import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { Cause, Data, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { BaseRpcError } from "../chain/base-rpc.js";
import type { TransactionReceipt, UsdcTransfer } from "../chain/base.js";
import type { OneClick } from "../intents/one-click.js";
import type { GatewayOrderInfo } from "../paycrest/gateway.js";
import {
  intentQuotes,
  organizations,
  payouts,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { raiseAlert } from "../alerts/ops-alerts.js";
import { AuditLog } from "../audit/audit-log.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { USDC_BASE_ADDRESS, usdcTransfersIn } from "../chain/base.js";
import {
  quotesToRecheck,
  refreshQuoteStatus,
} from "../intents/quote-status.js";
import {
  decodeGatewayOrderInfo,
  gatewayOrderInfoCalldata,
  gatewayRefundOrderId,
  isFromPaycrestGateway,
  PAYCREST_GATEWAY_BASE_ADDRESS,
} from "../paycrest/gateway.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../pretium/settlement.js";

/** Not mined yet, or not on Base: the caller should retry later. */
export class ReceiptUnavailable extends Data.TaggedError("ReceiptUnavailable")<{
  readonly txHash: string;
}> {}

/**
 * A Base hop may be arriving at a transit wallet, or a sweep's refund coming
 * back to it, but 1Click doesn't list the transaction yet: the caller should
 * retry later, when it will be known whether this is the company's own
 * money or something nobody expected.
 */
export class HopArrivalUnconfirmed extends Data.TaggedError(
  "HopArrivalUnconfirmed",
)<{
  readonly txHash: string;
}> {}

interface DepositWallet extends Record<string, unknown> {
  readonly wallet_id: string;
  readonly organization_id: string;
  readonly chain: string;
  /** `company`: the company wallet itself. `transit`: its transit wallet. */
  readonly kind: "company" | "transit";
  readonly address: string;
}

export interface DepositSummary {
  readonly credited: number;
  readonly alreadyCredited: number;
}

function activeWalletsByAddress(
  addresses: readonly string[],
): Effect.Effect<Map<string, DepositWallet>, DatabaseError, DatabaseService> {
  if (addresses.length === 0) {
    return Effect.succeed(new Map<string, DepositWallet>());
  }
  const list = sql.join(
    addresses.map((address) => sql`${address}`),
    sql`, `,
  );
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<DepositWallet>(
        sql`SELECT wallet_id, organization_id, chain, kind, address FROM wallets_by_receiving_address(ARRAY[${list}]::text[])`,
      ),
    ),
  ).pipe(
    Effect.map(
      ({ rows }) =>
        new Map(rows.map((row) => [row.address.toLowerCase(), row])),
    ),
  );
}

interface RefundedPayout {
  readonly id: string;
}

/**
 * T10: Paycrest returned the USDC from the deposit address we paid, which
 * is unique to that order. Only Paycrest's payouts count: an allowlisted
 * address the company itself owns can send it money as a deposit.
 */
function refundedFromDepositAddress(
  tx: Transaction,
  organizationId: string,
  transfer: UsdcTransfer,
): Effect.Effect<RefundedPayout | undefined, DatabaseError> {
  return query(() =>
    tx
      .select({ id: payouts.id })
      .from(payouts)
      .where(
        and(
          eq(payouts.organizationId, organizationId),
          eq(payouts.provider, "paycrest"),
          sql`lower(${payouts.depositAddress}) = ${transfer.from}`,
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([payout]) => payout));
}

/**
 * The Gateway's own record of the order a refund names. Only a USDC order
 * refunding to the wallet that received the transfer counts. A failed or
 * unreadable call is logged and gives null, so the transfer is still
 * credited (as a deposit), never held back.
 */
function gatewayOrderOnChain(
  gatewayOrderId: string,
  transfer: UsdcTransfer,
): Effect.Effect<GatewayOrderInfo | null, never, BaseRpc> {
  return Effect.gen(function* () {
    const rpc = yield* BaseRpc;
    const data = yield* rpc
      .ethCall(
        PAYCREST_GATEWAY_BASE_ADDRESS,
        gatewayOrderInfoCalldata(gatewayOrderId),
      )
      .pipe(
        Effect.catchTag("BaseRpcError", (error) =>
          Effect.sync(() => {
            console.warn(
              `[deposits] couldn't read Gateway order ${gatewayOrderId} for ${transfer.txHash}: ${error.message}`,
            );
            return null;
          }),
        ),
      );
    const info = data === null ? null : decodeGatewayOrderInfo(data);
    return info?.refundAddress === transfer.to &&
      info.token === USDC_BASE_ADDRESS.toLowerCase()
      ? info
      : null;
  });
}

/**
 * The payout a Gateway refund returns: the one sync saved the Gateway
 * order on, or else (the refund can land before sync sees the order) the
 * one whose deposit address created that order on the Gateway, for that
 * amount. That payout then gets the order saved: set once, under its lock.
 */
function refundedFromGateway(
  tx: Transaction,
  organizationId: string,
  gatewayOrderId: string,
  onChain: GatewayOrderInfo | null,
): Effect.Effect<RefundedPayout | undefined, DatabaseError> {
  return Effect.gen(function* () {
    const paycrestPayouts = and(
      eq(payouts.organizationId, organizationId),
      eq(payouts.provider, "paycrest"),
    );
    const [saved] = yield* query(() =>
      tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(and(paycrestPayouts, eq(payouts.gatewayOrderId, gatewayOrderId)))
        .limit(1),
    );
    if (saved || !onChain) return saved;

    const [payout, another] = yield* query(() =>
      tx
        .select({ id: payouts.id, gatewayOrderId: payouts.gatewayOrderId })
        .from(payouts)
        .where(
          and(
            paycrestPayouts,
            sql`lower(${payouts.depositAddress}) = ${onChain.sender}`,
            eq(payouts.usdcAmount, onChain.amount),
          ),
        )
        .limit(2)
        .for("update"),
    );
    if (!payout) return undefined;
    if (another) {
      console.error(
        `[deposits] Gateway order ${gatewayOrderId} was created by ${onChain.sender}, the deposit address of more than one payout; not linked`,
      );
      return undefined;
    }
    if (payout.gatewayOrderId !== null) {
      console.error(
        `[deposits] Gateway order ${gatewayOrderId} was created by payout ${payout.id}'s deposit address, but the payout has Gateway order ${payout.gatewayOrderId}; not linked`,
      );
      return undefined;
    }
    yield* query(() =>
      tx
        .update(payouts)
        .set({ gatewayOrderId })
        .where(and(eq(payouts.id, payout.id), isNull(payouts.gatewayOrderId))),
    );
    return { id: payout.id };
  });
}

/**
 * A Pretium cash-out's refund. Pretium returns the USDC to the wallet that
 * sent it, and the refund is this payout's when:
 *
 * 1. its hash is the one Pretium named when the refund was asked for; or
 * 2. it comes from the pinned settlement address and exactly one of the
 *    company's Pretium cash-outs is waiting for a refund of exactly this
 *    amount, with no hash named and nothing credited back yet. Two that
 *    could match are left unlinked for a person.
 */
function refundedByPretium(
  tx: Transaction,
  organizationId: string,
  transfer: UsdcTransfer,
): Effect.Effect<RefundedPayout | undefined, DatabaseError> {
  return Effect.gen(function* () {
    const pretiumPayouts = and(
      eq(payouts.organizationId, organizationId),
      eq(payouts.provider, "pretium"),
    );
    const [named] = yield* query(() =>
      tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(and(pretiumPayouts, eq(payouts.refundTxHash, transfer.txHash)))
        .limit(1),
    );
    if (named) return named;
    if (transfer.from !== PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase()) {
      return undefined;
    }

    const [payout, another] = yield* query(() =>
      tx
        .select({ id: payouts.id })
        .from(payouts)
        .where(
          and(
            pretiumPayouts,
            isNotNull(payouts.refundRequestedAt),
            isNull(payouts.refundTxHash),
            eq(payouts.amountToTransferUsdc, transfer.amount),
            sql`NOT EXISTS (SELECT 1 FROM ${walletTransactions} WHERE ${walletTransactions.payoutId} = ${payouts.id} AND ${walletTransactions.type} = 'refund')`,
          ),
        )
        .limit(2),
    );
    if (another) {
      console.error(
        `[deposits] ${transfer.amount} USDC base units from Pretium in ${transfer.txHash} (log ${transfer.logIndex}) could be the refund of more than one cash-out of company ${organizationId}; not linked`,
      );
      return undefined;
    }
    return payout;
  });
}

type CreditOutcome = "credited" | "already_credited" | "not_a_refund";

/**
 * Credits one transfer into a wallet on Base. At a company wallet made
 * before NEAR became the main chain it is a refund or a deposit. At a
 * transit wallet only a cash-out's refund (Paycrest's or Pretium's) is
 * ever credited: anything else gives `not_a_refund` and writes nothing.
 */
function creditDeposit(
  wallet: DepositWallet,
  receipt: TransactionReceipt,
  transfer: UsdcTransfer,
  actor: AuditActor,
): Effect.Effect<
  CreditOutcome,
  DatabaseError,
  DatabaseService | AuditLog | BaseRpc
> {
  // A failed Paycrest order's USDC comes back either from the deposit
  // address we paid (T10) or from Paycrest's Gateway, which names the
  // on-chain order in the same receipt. Either way it is the payout's
  // refund, not a new deposit.
  const fromGateway = isFromPaycrestGateway(transfer);
  const gatewayOrderId = gatewayRefundOrderId(receipt, transfer);
  return Effect.gen(function* () {
    const onChain = gatewayOrderId
      ? yield* gatewayOrderOnChain(gatewayOrderId, transfer)
      : null;
    return yield* withScope({ organizationId: wallet.organization_id }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const refunded = !fromGateway
          ? ((yield* refundedFromDepositAddress(
              tx,
              wallet.organization_id,
              transfer,
            )) ??
            (yield* refundedByPretium(tx, wallet.organization_id, transfer)))
          : gatewayOrderId
            ? yield* refundedFromGateway(
                tx,
                wallet.organization_id,
                gatewayOrderId,
                onChain,
              )
            : undefined;
        if (wallet.kind === "transit" && !refunded) {
          return "not_a_refund" as const;
        }
        const [credit] = yield* query(() =>
          tx
            .insert(walletTransactions)
            .values({
              organizationId: wallet.organization_id,
              walletId: wallet.wallet_id,
              type: refunded ? "refund" : "deposit",
              payoutId: refunded?.id ?? null,
              usdcAmount: transfer.amount,
              txHash: transfer.txHash,
              logIndex: transfer.logIndex,
              blockNumber: transfer.blockNumber,
              counterpartyAddress: transfer.from,
            })
            .onConflictDoNothing()
            .returning({ id: walletTransactions.id }),
        );
        if (!credit) return "already_credited" as const;
        if (fromGateway && !refunded) {
          console.warn(
            gatewayOrderId
              ? `[deposits] Gateway refund of order ${gatewayOrderId} in ${transfer.txHash} (log ${transfer.logIndex}) matches no payout of company ${wallet.organization_id}; credited as a deposit`
              : `[deposits] USDC from Paycrest's Gateway in ${transfer.txHash} (log ${transfer.logIndex}) has no OrderRefunded event; credited as a deposit`,
          );
        }
        yield* audit.record(tx, {
          actor,
          organizationId: wallet.organization_id,
          action: refunded
            ? "wallet.refund_received"
            : "wallet.deposit_received",
          entity: { type: "wallet_transaction", id: credit.id },
          after: {
            ...(refunded && { payoutId: refunded.id }),
            ...(gatewayOrderId && { gatewayOrderId }),
            walletId: wallet.wallet_id,
            usdcAmount: transfer.amount,
            txHash: transfer.txHash,
            logIndex: transfer.logIndex,
            from: transfer.from,
          },
        });
        return "credited" as const;
      }),
    );
  });
}

/**
 * Whether one of the company's Base hops or sweeps lists `transfer`'s
 * transaction anywhere in its 1Click record: a hop's delivery, or a sweep's
 * deposit coming back to the transit wallet it was sent from.
 */
function isOwnQuoteTransfer(
  organizationId: string,
  transfer: UsdcTransfer,
): Effect.Effect<boolean, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ id: intentQuotes.id })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.organizationId, organizationId),
            inArray(intentQuotes.purpose, [...TRANSIT_QUOTE_PURPOSES]),
            sql`EXISTS (SELECT 1 FROM unnest(${intentQuotes.originChainTxHashes} || ${intentQuotes.destinationChainTxHashes} || ${intentQuotes.nearTxHashes}) AS hash WHERE lower(hash) = ${transfer.txHash})`,
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/** The quotes that move a company's USDC into or back to its transit wallet. */
const TRANSIT_QUOTE_PURPOSES = ["base_hop", "sweep"] as const;

const isUnsettled = (quote: IntentQuote): boolean =>
  UNSETTLED_INTENT_QUOTE_STATUSES.some((status) => status === quote.status);

/**
 * Whether `quote` could still turn out to be why `amount` reached the
 * transit wallet, once 1Click lists the transaction. A hop delivers exactly
 * its `amountOut`. A sweep that 1Click refunds returns what was deposited,
 * at most its `amountIn`, to the transit wallet; one that succeeded returns
 * nothing. `asked` is false when 1Click couldn't be asked about the quote
 * just now, so nothing rules it out.
 */
function couldExplain(
  quote: IntentQuote,
  amount: bigint,
  asked: boolean,
): boolean {
  if (quote.purpose === "base_hop") {
    return quote.amountOut === amount && (!asked || isUnsettled(quote));
  }
  return (
    amount <= quote.amountIn &&
    (!asked ||
      isUnsettled(quote) ||
      quote.status === "refunded" ||
      quote.status === "failed")
  );
}

type TransitOutcome = "internal" | "flagged";

/**
 * USDC at a transit wallet that isn't a Paycrest refund. It is the
 * company's own money when one of its Base hops or sweeps lists the
 * transaction (a hop arriving, or a sweep 1Click refunded); that is
 * internal and never a ledger entry. Otherwise nobody expected it: it is
 * raised for review and never credited (docs/decisions/near-main-chain.md,
 * "The ledger").
 *
 * 1Click can list a transaction a little after it lands. So while a hop or
 * sweep could still explain this amount, or one that could wasn't
 * answerable, the answer is "not yet" rather than an alert.
 */
function settleTransitTransfer(
  wallet: DepositWallet,
  transfer: UsdcTransfer,
): Effect.Effect<
  TransitOutcome,
  HopArrivalUnconfirmed | DatabaseError,
  DatabaseService | OneClick
> {
  const organizationId = wallet.organization_id;
  return Effect.gen(function* () {
    if (yield* isOwnQuoteTransfer(organizationId, transfer)) return "internal";

    let stillPossible = false;
    for (const quote of yield* quotesToRecheck(
      organizationId,
      TRANSIT_QUOTE_PURPOSES,
    )) {
      const exit = yield* Effect.exit(refreshQuoteStatus(quote));
      if (Exit.isFailure(exit)) {
        console.warn(
          `[deposits] quote ${quote.id} not refreshed`,
          Cause.pretty(exit.cause),
        );
      }
      stillPossible ||= Exit.isSuccess(exit)
        ? couldExplain(exit.value, transfer.amount, true)
        : couldExplain(quote, transfer.amount, false);
    }
    if (yield* isOwnQuoteTransfer(organizationId, transfer)) return "internal";
    if (stillPossible) {
      return yield* Effect.fail(
        new HopArrivalUnconfirmed({ txHash: transfer.txHash }),
      );
    }

    const [company] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select({ name: organizations.name })
          .from(organizations)
          .where(eq(organizations.id, organizationId))
          .limit(1),
      ),
    );
    const companyName = company?.name ?? organizationId;
    console.warn(
      `[deposits] unexpected USDC at the transit wallet of company ${organizationId} in ${transfer.txHash} (log ${transfer.logIndex}); not credited`,
    );
    yield* raiseAlert({
      kind: "unexpected_transit_transfer",
      subjectKey: `${transfer.txHash}:${transfer.logIndex}`,
      organizationId,
      title: `Unexpected USDC at the transit wallet of ${companyName}`,
      details: [
        { label: "Company", value: companyName },
        { label: "Transit wallet", value: wallet.address },
        {
          label: "Amount (USDC base units)",
          value: transfer.amount.toString(),
        },
        { label: "From", value: transfer.from },
        { label: "Base transaction", value: transfer.txHash },
        { label: "Log index", value: String(transfer.logIndex) },
        {
          label: "What it means",
          value:
            "USDC reached this transit wallet and it is neither a Paycrest refund nor one of the company's Base hops or sweeps. It has not been added to the company's balance. Find out who sent it, then credit or return it by hand.",
        },
      ],
    });
    return "flagged";
  });
}

/**
 * Credits the USDC that the given Base transactions sent to a company's
 * wallet on Base: its transit wallet, or the company wallet itself if it
 * was made before NEAR became the main chain. A notification only says where
 * to look: every amount, sender, recipient and log index comes from the
 * transaction receipt, so only real, successful USDC transfers on Base are
 * ever credited (spec §6.9). Each transfer log is credited at most once,
 * however often it's reported.
 *
 * At a transit wallet only a Paycrest refund is credited. A Base hop
 * arriving is the company's own money and is left alone; anything else is
 * raised for review.
 */
export function creditUsdcDeposits(
  txHashes: readonly string[],
  actor: AuditActor,
): Effect.Effect<
  DepositSummary,
  ReceiptUnavailable | HopArrivalUnconfirmed | BaseRpcError | DatabaseError,
  BaseRpc | DatabaseService | AuditLog | OneClick
> {
  return Effect.gen(function* () {
    const rpc = yield* BaseRpc;
    let credited = 0;
    let alreadyCredited = 0;

    for (const txHash of new Set(txHashes.map((hash) => hash.toLowerCase()))) {
      const receipt = yield* rpc.getTransactionReceipt(txHash);
      if (!receipt)
        return yield* Effect.fail(new ReceiptUnavailable({ txHash }));

      const transfers = usdcTransfersIn(receipt).filter(
        (transfer) => transfer.amount > 0n,
      );
      const walletsByAddress = yield* activeWalletsByAddress([
        ...new Set(transfers.map((transfer) => transfer.to)),
      ]);
      for (const transfer of transfers) {
        const wallet = walletsByAddress.get(transfer.to);
        // A company wallet on NEAR has no address on Base to receive at.
        if (!wallet || (wallet.kind === "company" && wallet.chain !== "base")) {
          continue;
        }
        const outcome = yield* creditDeposit(wallet, receipt, transfer, actor);
        if (outcome === "credited") credited += 1;
        else if (outcome === "already_credited") alreadyCredited += 1;
        else yield* settleTransitTransfer(wallet, transfer);
      }
    }

    return { credited, alreadyCredited };
  });
}
