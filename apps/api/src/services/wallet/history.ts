import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { WalletTransactionType } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import { payouts, wallets, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";

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
  readonly amountKesCents: bigint;
  readonly status: Payout["status"];
  readonly subjectId: string;
  readonly payrollRunId: string | null;
  readonly approvalId: string | null;
  readonly approvedAt: Date | null;
  readonly paidAt: Date | null;
  readonly rate: string | null;
  readonly failureReason: string | null;
}

export interface WalletHistoryItem {
  readonly id: string;
  readonly type: WalletTransactionType;
  readonly usdcAmount: bigint;
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

export function walletHistory(input: {
  readonly organizationId: string;
  /** A ledger row's ID: only rows older than it are returned. */
  readonly before: string | null;
  readonly limit: number;
}): Effect.Effect<WalletHistoryPage, DatabaseError, DatabaseService> {
  const { organizationId, before, limit } = input;
  return withScope({ organizationId }, (tx) =>
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
          .select({ entry: walletTransactions, payout: payouts })
          .from(walletTransactions)
          .leftJoin(payouts, eq(payouts.id, walletTransactions.payoutId))
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
        items: page.map(({ entry, payout }) => ({
          id: entry.id,
          type: entry.type,
          usdcAmount: entry.usdcAmount,
          txHash: entry.txHash,
          counterpartyAddress: entry.counterpartyAddress,
          createdAt: entry.createdAt,
          payout: payout && {
            id: payout.id,
            subjectType: payout.subjectType,
            method: payout.method,
            recipientName: payout.recipient.accountName,
            recipientDetail: describeRecipient(payout.recipient),
            amountKesCents: payout.amountKes,
            status: payout.status,
            subjectId: payout.subjectId,
            payrollRunId: payout.payrollRunId,
            approvalId: payout.approvalId,
            approvedAt: payout.approvedAt,
            paidAt: payout.paidAt,
            rate: payout.rate,
            failureReason: payout.failureReason,
          },
        })),
        nextCursor: rows.length > limit && last ? last.entry.id : null,
      };
    }),
  );
}
