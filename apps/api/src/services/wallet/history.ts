import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CashOutReceipt,
  PayeeChain,
  WalletChain,
  WalletTransactionType,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import {
  bills,
  categories,
  payouts,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { cashOutReceiptsOf } from "../payout/receipts.js";

/**
 * The wallet's history (spec §6.9): its ledger, newest first, with the
 * payout behind each payout, refund and withdrawal. Nothing that identifies
 * a person beyond what the admin needs: M-Pesa numbers and bank accounts
 * show their last 4 digits only.
 */

export interface WalletHistoryPayout {
  readonly id: string;
  readonly subjectType: Payout["subjectType"];
  readonly method: Payout["method"];
  readonly recipientName: string;
  readonly recipientDetail: string;
  readonly recipientChain: PayeeChain | null;
  readonly amountKesCents: bigint;
  readonly status: Payout["status"];
  readonly subjectId: string;
  readonly payrollRunId: string | null;
  readonly approvalId: string | null;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly categoryName: string | null;
  readonly paymentReceipts: readonly CashOutReceipt[];
  readonly rate: string | null;
  readonly failureReason: string | null;
  /** Present only for a paid USDC payout delivered through NEAR Intents. */
  readonly deliveryTxHash?: string;
  readonly deliveryTxChain?: PayeeChain;
}

export interface WalletHistoryItem {
  readonly id: string;
  readonly type: WalletTransactionType;
  readonly usdcAmount: bigint;
  readonly chain: WalletChain;
  readonly txHash: string | null;
  readonly counterpartyAddress: string | null;
  readonly createdAt: Date;
  readonly payout: WalletHistoryPayout | null;
}

export interface WalletHistoryPage {
  readonly items: WalletHistoryItem[];
  /** Pass as `before` for the next page; null on the last one. */
  readonly nextCursor: string | null;
}

const lastFour = (value: string) => `•••• ${value.slice(-4)}`;

/** Where a payout went, safe to show in a list. */
export function describeRecipient(recipient: PayoutRecipient): string {
  switch (recipient.method) {
    case "mpesa_phone":
      return lastFour(recipient.phone);
    case "mpesa_till":
      return `Till ${recipient.tillNumber}`;
    case "mpesa_paybill":
      return `Paybill ${recipient.paybillNumber}`;
    case "bank":
      return `${recipient.bankCode} ${lastFour(recipient.accountNumber)}`;
    case "usdc":
      return recipient.address;
  }
}

/**
 * The payee chain's own transaction that delivered a paid USDC payout
 * through NEAR Intents: `providerReference`, which a delivered quote fills
 * with `destinationChainTxHashes[0]`. A payout sent straight from the
 * company wallet has none, and a cash-out's reference is a provider's
 * receipt code, never a hash.
 */
export function deliveryTransactionOf(
  payout: Pick<
    Payout,
    | "provider"
    | "status"
    | "recipient"
    | "deliveryQuoteId"
    | "providerReference"
  >,
): { readonly txHash: string; readonly chain: PayeeChain } | null {
  const { recipient, providerReference } = payout;
  if (
    payout.provider !== "onchain" ||
    payout.status !== "paid" ||
    payout.deliveryQuoteId === null ||
    recipient.method !== "usdc" ||
    providerReference === null ||
    providerReference === ""
  ) {
    return null;
  }
  return { txHash: providerReference, chain: recipient.chain };
}

export function walletHistory(input: {
  readonly tenant: Tenant;
  /** A ledger row's ID: only rows older than it are returned. */
  readonly before: string | null;
  readonly limit: number;
}): Effect.Effect<WalletHistoryPage, DatabaseError, DatabaseService> {
  const { tenant, before, limit } = input;
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [wallet] = yield* query(() =>
        tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(eq(wallets.organizationId, organizationId)),
      );
      if (!wallet) return { items: [], nextCursor: null };

      const olderThanCursor = before
        ? sql`(${walletTransactions.createdAt}, ${walletTransactions.id}) < (SELECT cursor.created_at, cursor.id FROM ${walletTransactions} AS cursor WHERE cursor.id = ${before} AND cursor.wallet_id = ${wallet.id})`
        : undefined;
      const rows = yield* query(() =>
        tx
          .select({
            entry: walletTransactions,
            payout: payouts,
            categoryName: categories.name,
          })
          .from(walletTransactions)
          .leftJoin(payouts, eq(payouts.id, walletTransactions.payoutId))
          .leftJoin(
            bills,
            and(
              eq(payouts.subjectType, "bill"),
              eq(bills.id, payouts.subjectId),
              eq(bills.organizationId, organizationId),
            ),
          )
          .leftJoin(
            categories,
            and(
              eq(categories.id, bills.categoryId),
              eq(categories.organizationId, organizationId),
            ),
          )
          .where(
            and(eq(walletTransactions.walletId, wallet.id), olderThanCursor),
          )
          .orderBy(
            desc(walletTransactions.createdAt),
            desc(walletTransactions.id),
          )
          .limit(limit + 1),
      );

      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ entry, payout, categoryName }) => {
          const delivery = payout && deliveryTransactionOf(payout);
          return {
            id: entry.id,
            type: entry.type,
            usdcAmount: entry.usdcAmount,
            chain: entry.chain,
            txHash: entry.txHash,
            counterpartyAddress: entry.counterpartyAddress,
            createdAt: entry.createdAt,
            payout: payout && {
              id: payout.id,
              subjectType: payout.subjectType,
              method: payout.method,
              recipientName: payout.recipient.accountName,
              recipientDetail: describeRecipient(payout.recipient),
              recipientChain:
                payout.recipient.method === "usdc"
                  ? payout.recipient.chain
                  : null,
              amountKesCents: payout.amountKes,
              status: payout.status,
              subjectId: payout.subjectId,
              payrollRunId: payout.payrollRunId,
              approvalId: payout.approvalId,
              approvedAt: payout.approvedAt,
              paidAt: payout.paidAt,
              categoryName,
              paymentReceipts: cashOutReceiptsOf([payout]),
              rate: payout.rate,
              failureReason: payout.failureReason,
              ...(delivery && {
                deliveryTxHash: delivery.txHash,
                deliveryTxChain: delivery.chain,
              }),
            },
          };
        }),
        nextCursor: rows.length > limit && last ? last.entry.id : null,
      };
    }),
  );
}
