import { and, eq, isNull, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { BaseRpcError } from "../chain/base-rpc.js";
import type { TransactionReceipt, UsdcTransfer } from "../chain/base.js";
import type { GatewayOrderInfo } from "../paycrest/gateway.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { USDC_BASE_ADDRESS, usdcTransfersIn } from "../chain/base.js";
import {
  decodeGatewayOrderInfo,
  gatewayOrderInfoCalldata,
  gatewayRefundOrderId,
  isFromPaycrestGateway,
  PAYCREST_GATEWAY_BASE_ADDRESS,
} from "../paycrest/gateway.js";

/** Not mined yet, or not on Base: the caller should retry later. */
export class ReceiptUnavailable extends Data.TaggedError("ReceiptUnavailable")<{
  readonly txHash: string;
}> {}

interface DepositWallet extends Record<string, unknown> {
  readonly wallet_id: string;
  readonly organization_id: string;
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
        sql`SELECT wallet_id, organization_id, address FROM active_wallets_by_address(ARRAY[${list}]::text[])`,
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

function creditDeposit(
  wallet: DepositWallet,
  receipt: TransactionReceipt,
  transfer: UsdcTransfer,
  actor: AuditActor,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog | BaseRpc> {
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
          ? yield* refundedFromDepositAddress(
              tx,
              wallet.organization_id,
              transfer,
            )
          : gatewayOrderId
            ? yield* refundedFromGateway(
                tx,
                wallet.organization_id,
                gatewayOrderId,
                onChain,
              )
            : undefined;
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
        if (!credit) return false;
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
        return true;
      }),
    );
  });
}

/**
 * Credits the USDC that the given Base transactions sent to company
 * wallets. A notification only says where to look: every amount, sender,
 * recipient and log index comes from the transaction receipt, so only real,
 * successful USDC transfers on Base are ever credited (spec §6.9). Each
 * transfer log is credited at most once, however often it's reported.
 */
export function creditUsdcDeposits(
  txHashes: readonly string[],
  actor: AuditActor,
): Effect.Effect<
  DepositSummary,
  ReceiptUnavailable | BaseRpcError | DatabaseError,
  BaseRpc | DatabaseService | AuditLog
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
        if (!wallet) continue;
        if (yield* creditDeposit(wallet, receipt, transfer, actor))
          credited += 1;
        else alreadyCredited += 1;
      }
    }

    return { credited, alreadyCredited };
  });
}
