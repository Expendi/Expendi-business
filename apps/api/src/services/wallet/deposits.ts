import { and, eq, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { BaseRpcError } from "../chain/base-rpc.js";
import type { UsdcTransfer } from "../chain/base.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";

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

function creditDeposit(
  wallet: DepositWallet,
  transfer: UsdcTransfer,
  actor: AuditActor,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog> {
  return withScope({ organizationId: wallet.organization_id }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      // Paycrest returns a failed order's USDC from the deposit address we
      // paid, which is unique to that order: so that transfer is the payout's
      // refund, not a new deposit (T10).
      const [refunded] = yield* query(() =>
        tx
          .select({ id: payouts.id })
          .from(payouts)
          .where(
            and(
              eq(payouts.organizationId, wallet.organization_id),
              // Only Paycrest's per-order addresses: an allowlisted address
              // the company itself owns can send it money as a deposit.
              eq(payouts.provider, "paycrest"),
              sql`lower(${payouts.depositAddress}) = ${transfer.from}`,
            ),
          )
          .limit(1),
      );
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
      yield* audit.record(tx, {
        actor,
        organizationId: wallet.organization_id,
        action: refunded ? "wallet.refund_received" : "wallet.deposit_received",
        entity: { type: "wallet_transaction", id: credit.id },
        after: {
          ...(refunded && { payoutId: refunded.id }),
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
        if (yield* creditDeposit(wallet, transfer, actor)) credited += 1;
        else alreadyCredited += 1;
      }
    }

    return { credited, alreadyCredited };
  });
}
