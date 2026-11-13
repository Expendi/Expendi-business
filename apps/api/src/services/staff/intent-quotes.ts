import { and, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  IntentQuotePurpose,
  IntentQuoteStatus,
  OneClickStatus,
  PayeeChain,
  PayoutStatus,
  WalletChain,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { BadRequest, Conflict, DatabaseError } from "../../errors.js";
import type { OneClickSwapStatus } from "../intents/one-click.js";
import type { AuditEntryView } from "./audit-search.js";
import type {
  EvidenceDeps,
  QuoteEvidence,
  QuotePayout,
} from "./intent-quote-evidence.js";
import type { CompanyWalletSendView } from "./near-send-evidence.js";
import type { LedgerEntryView, StaffPayoutSummaryView } from "./payouts.js";
import {
  companyWalletSends,
  intentQuotes,
  organizations,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound, ServiceUnavailable } from "../../errors.js";
import { OneClick } from "../intents/one-click.js";
import { quoteSendKey } from "../intents/quote-settle.js";
import { touchesConfidentialAccount } from "../intents/quote-status.js";
import { searchAuditLog } from "./audit-search.js";
import {
  chainOfAsset,
  gatherQuoteEvidence,
  isHeldBy,
  originChainOf,
  quotePayouts,
} from "./intent-quote-evidence.js";
import { companyWalletSendView } from "./near-send-evidence.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "./paging.js";
import { ledgerView, payoutSummary } from "./payouts.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * NEAR Intents quotes that need a person (spec §6.15): what they are, what
 * they hold up, and what 1Click and the chains show of them. Lists go
 * through `staff_intent_quote_queue`; one quote is read in its company's
 * scope, in a read-only transaction.
 */

export interface StaffIntentQuoteSummaryView {
  readonly id: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly purpose: IntentQuotePurpose;
  readonly status: IntentQuoteStatus;
  readonly oneClickStatus: OneClickStatus | null;
  readonly amountIn: bigint;
  readonly amountOut: bigint;
  readonly depositAddress: string;
  readonly recipient: string;
  readonly deadline: string;
  readonly failure: string | null;
  readonly payoutsInReview: number;
  readonly openSends: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface QueueRow extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly purpose: IntentQuotePurpose;
  readonly status: IntentQuoteStatus;
  readonly one_click_status: OneClickStatus | null;
  readonly amount_in: string;
  readonly amount_out: string;
  readonly deposit_address: string;
  readonly recipient: string;
  readonly deadline: string;
  readonly failure: string | null;
  readonly payouts_in_review: number;
  readonly open_sends: number;
  readonly created_at: string;
  readonly updated_at: string;
}

const fromQueueRow = (row: QueueRow): StaffIntentQuoteSummaryView => ({
  id: row.quote_id,
  organization: { id: row.organization_id, name: row.organization_name },
  purpose: row.purpose,
  status: row.status,
  oneClickStatus: row.one_click_status,
  amountIn: BigInt(row.amount_in),
  amountOut: BigInt(row.amount_out),
  depositAddress: row.deposit_address,
  recipient: row.recipient,
  deadline: row.deadline,
  failure: row.failure,
  payoutsInReview: row.payouts_in_review,
  openSends: row.open_sends,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export interface IntentQuoteQueuePage {
  readonly quotes: StaffIntentQuoteSummaryView[];
  readonly nextCursor: string | null;
}

/** Newest first, from every company unless one is given. */
export function intentQuoteQueue(input: {
  readonly companyId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}): Effect.Effect<
  IntentQuoteQueuePage,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const cursor = input.cursor ? yield* decodeCursor(input.cursor) : null;
    return yield* withStaffReadScope({}, (tx) =>
      query(() =>
        tx.execute<QueueRow>(sql`
          SELECT q.quote_id, q.organization_id, q.organization_name,
                 q.purpose, q.status, q.one_click_status,
                 q.amount_in::text AS amount_in,
                 q.amount_out::text AS amount_out,
                 q.deposit_address, q.recipient,
                 ${isoUtc(sql`q.deadline`)} AS deadline,
                 q.failure, q.payouts_in_review, q.open_sends,
                 ${isoUtc(sql`q.created_at`)} AS created_at,
                 ${isoUtc(sql`q.updated_at`)} AS updated_at
          FROM staff_intent_quote_queue(
            ${input.companyId ?? null}::uuid,
            ${cursor?.at ?? null}::timestamptz,
            ${cursor?.id ?? null}::uuid,
            ${input.limit + 1}::integer
          ) AS q`),
      ),
    ).pipe(
      Effect.map(({ rows }) => {
        const page = rows.slice(0, input.limit);
        const last = page.at(-1);
        return {
          quotes: page.map(fromQueueRow),
          nextCursor:
            rows.length > input.limit && last
              ? encodeCursor({ at: last.created_at, id: last.quote_id })
              : null,
        };
      }),
    );
  });
}

const noSuchQuote = new NotFound({
  message: "No NEAR Intents quote with this ID",
});

/** The company a quote belongs to, so it can be read in that scope. */
export function quoteOrganization(
  quoteId: string,
): Effect.Effect<string, NotFound | DatabaseError, DatabaseService> {
  if (!UUID.test(quoteId)) return Effect.fail(noSuchQuote);
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<{ organization_id: string | null }>(
        sql`SELECT organization_of_intent_quote(${quoteId}::uuid) AS organization_id`,
      ),
    ),
  ).pipe(
    Effect.flatMap(({ rows: [row] }) =>
      row?.organization_id
        ? Effect.succeed(row.organization_id)
        : Effect.fail(noSuchQuote),
    ),
  );
}

export interface ScopedQuote {
  readonly quote: IntentQuote;
  readonly organizationName: string;
  readonly payouts: readonly QuotePayout[];
  /** The chain of the company wallet the quote and its payouts belong to. */
  readonly walletChain: WalletChain;
  readonly openSends: number;
}

/** The quote, its company's name and its payouts, read in its company scope. */
export function readScopedQuote(
  organizationId: string,
  quoteId: string,
): Effect.Effect<ScopedQuote, NotFound | DatabaseError, DatabaseService> {
  return withStaffReadScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [row] = yield* query(() =>
        tx
          .select({
            quote: intentQuotes,
            organizationName: organizations.name,
            walletChain: wallets.chain,
          })
          .from(intentQuotes)
          .innerJoin(
            organizations,
            eq(organizations.id, intentQuotes.organizationId),
          )
          .innerJoin(wallets, eq(wallets.id, intentQuotes.walletId))
          .where(eq(intentQuotes.id, quoteId)),
      );
      if (!row) return null;
      const [open] = yield* query(() =>
        tx
          .select({ count: sql<number>`count(*)::int` })
          .from(companyWalletSends)
          .where(
            and(
              eq(companyWalletSends.organizationId, organizationId),
              eq(companyWalletSends.sendKey, quoteSendKey(quoteId)),
              inArray(companyWalletSends.status, ["reserved", "signed"]),
            ),
          ),
      );
      return {
        ...row,
        payouts: yield* quotePayouts(tx, row.quote),
        openSends: open?.count ?? 0,
      };
    }),
  ).pipe(
    Effect.flatMap((scoped) =>
      scoped ? Effect.succeed(scoped) : Effect.fail(noSuchQuote),
    ),
  );
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

function quoteSummary(scoped: ScopedQuote): StaffIntentQuoteSummaryView {
  const { quote } = scoped;
  return {
    id: quote.id,
    organization: { id: quote.organizationId, name: scoped.organizationName },
    purpose: quote.purpose,
    status: quote.status,
    oneClickStatus: quote.oneClickStatus,
    amountIn: quote.amountIn,
    amountOut: quote.amountOut,
    depositAddress: quote.depositAddress,
    recipient: quote.recipient,
    deadline: quote.deadline.toISOString(),
    failure: quote.failure,
    payoutsInReview: scoped.payouts.filter(({ payout }) =>
      isHeldBy(quote, payout),
    ).length,
    openSends: scoped.openSends,
    createdAt: quote.createdAt.toISOString(),
    updatedAt: quote.updatedAt.toISOString(),
  };
}

export interface StaffIntentQuoteDetailView extends StaffIntentQuoteSummaryView {
  readonly originChain: WalletChain | null;
  readonly destinationChain: PayeeChain | null;
  readonly swapType: IntentQuote["swapType"];
  readonly minAmountOut: bigint | null;
  readonly refundTo: string;
  readonly depositStartedAt: string | null;
  readonly depositTxHash: string | null;
  readonly companyWalletSendId: string | null;
  readonly depositPrivyTransactionId: string | null;
  readonly depositType: IntentQuote["depositType"];
  readonly recipientType: IntentQuote["recipientType"];
  readonly refundType: IntentQuote["refundType"];
  /**
   * What a quote paid out of a confidential account records of its signed
   * message. The message itself is never read here: it is spendable until
   * its deadline.
   */
  readonly intentHash: string | null;
  readonly intentDeadline: string | null;
  readonly intentSubmittedAt: string | null;
  readonly oneClickCheckedAt: string | null;
  readonly nearTxHashes: readonly string[];
  readonly originChainTxHashes: readonly string[];
  readonly destinationChainTxHashes: readonly string[];
  readonly depositedAmount: bigint | null;
  readonly swappedAmountIn: bigint | null;
  readonly swappedAmountOut: bigint | null;
  readonly refundedAmount: bigint | null;
  readonly refundReason: string | null;
  readonly settledAt: string | null;
  readonly payouts: readonly StaffPayoutSummaryView[];
  readonly auditTrail: readonly AuditEntryView[];
}

/** One quote as last recorded, its payouts and its audit trail. Only reads. */
export function intentQuoteDetail(
  quoteId: string,
): Effect.Effect<
  StaffIntentQuoteDetailView,
  NotFound | BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const organizationId = yield* quoteOrganization(quoteId);
    const scoped = yield* readScopedQuote(organizationId, quoteId);
    const { quote } = scoped;
    const trail = yield* searchAuditLog({
      entityType: "intent_quote",
      entityId: quoteId,
      limit: 50,
    });
    return {
      ...quoteSummary(scoped),
      originChain: originChainOf(quote),
      destinationChain: chainOfAsset(quote.destinationAsset),
      swapType: quote.swapType,
      minAmountOut: quote.minAmountOut,
      refundTo: quote.refundTo,
      depositStartedAt: iso(quote.depositStartedAt),
      depositTxHash: quote.depositTxHash,
      companyWalletSendId: quote.companyWalletSendId,
      depositPrivyTransactionId: quote.depositPrivyTransactionId,
      depositType: quote.depositType,
      recipientType: quote.recipientType,
      refundType: quote.refundType,
      intentHash: quote.intentHash,
      intentDeadline: iso(quote.intentDeadline),
      intentSubmittedAt: iso(quote.intentSubmittedAt),
      oneClickCheckedAt: iso(quote.oneClickCheckedAt),
      nearTxHashes: quote.nearTxHashes,
      originChainTxHashes: quote.originChainTxHashes,
      destinationChainTxHashes: quote.destinationChainTxHashes,
      depositedAmount: quote.depositedAmount,
      swappedAmountIn: quote.swappedAmountIn,
      swappedAmountOut: quote.swappedAmountOut,
      refundedAmount: quote.refundedAmount,
      refundReason: quote.refundReason,
      settledAt: iso(quote.settledAt),
      payouts: scoped.payouts.map(({ payout }) =>
        payoutSummary(payout, scoped.organizationName, scoped.walletChain),
      ),
      auditTrail: trail.entries,
    };
  });
}

export interface QuoteTransferView {
  readonly chain: WalletChain;
  readonly txHash: string;
  readonly from: string;
  readonly to: string;
  readonly usdcAmount: bigint;
  readonly blockNumber: bigint;
}

export interface IntentQuoteEvidenceView {
  readonly oneClickStatus: OneClickStatus | null;
  readonly depositedAmount: bigint | null;
  readonly deposits: readonly QuoteTransferView[];
  readonly deliveries: readonly QuoteTransferView[];
  readonly refunds: readonly QuoteTransferView[];
  readonly unreadDeliveries: readonly string[];
  readonly companyWalletSends: readonly CompanyWalletSendView[];
  readonly payouts: readonly {
    readonly id: string;
    readonly status: PayoutStatus;
    readonly ledger: readonly LedgerEntryView[];
  }[];
}

const transferView = (transfer: QuoteEvidence["deposits"][number]) => ({
  chain: transfer.chain,
  txHash: transfer.txHash,
  from: transfer.from,
  to: transfer.to,
  usdcAmount: transfer.amount,
  blockNumber: transfer.blockNumber,
});

export function quoteEvidenceView(
  quote: Pick<IntentQuote, "oneClickStatus" | "depositedAmount">,
  evidence: QuoteEvidence,
  quotePayoutRows: readonly QuotePayout[],
): IntentQuoteEvidenceView {
  return {
    oneClickStatus: quote.oneClickStatus,
    depositedAmount: quote.depositedAmount,
    deposits: evidence.deposits.map(transferView),
    deliveries: evidence.deliveries.map(transferView),
    refunds: evidence.refunds.map(transferView),
    unreadDeliveries: evidence.unreadDeliveries,
    companyWalletSends: (evidence.near?.sends ?? []).map(companyWalletSendView),
    payouts: quotePayoutRows.map(({ payout, debits, refunds }) => ({
      id: payout.id,
      status: payout.status,
      ledger: [...debits, ...refunds].map(ledgerView),
    })),
  };
}

/** The quote with what 1Click reported just now laid over it, unsaved. */
function withReport(
  quote: IntentQuote,
  reported: OneClickSwapStatus,
): IntentQuote {
  const merged = (saved: readonly string[], listed: readonly string[]) => [
    ...new Set([...saved, ...listed]),
  ];
  return {
    ...quote,
    oneClickStatus: reported.status,
    nearTxHashes: merged(quote.nearTxHashes, reported.nearTxHashes),
    originChainTxHashes: merged(
      quote.originChainTxHashes,
      reported.originChainTxHashes,
    ),
    destinationChainTxHashes: merged(
      quote.destinationChainTxHashes,
      reported.destinationChainTxHashes,
    ),
    depositedAmount: reported.depositedAmount ?? quote.depositedAmount,
    refundedAmount: reported.refundedAmount ?? quote.refundedAmount,
  };
}

export const oneClickUnavailable = new ServiceUnavailable({
  message: "1Click didn't answer. Nothing was changed; try again shortly.",
});

/**
 * What 1Click and the chains show of a quote right now, for any staff
 * role. It only reads: 1Click's answer is shown, not saved.
 */
export function intentQuoteEvidence(
  quoteId: string,
): Effect.Effect<
  IntentQuoteEvidenceView,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  EvidenceDeps | OneClick
> {
  return Effect.gen(function* () {
    const organizationId = yield* quoteOrganization(quoteId);
    const scoped = yield* readScopedQuote(organizationId, quoteId);
    // 1Click answers about a quote that touches a confidential account only
    // to the company's own session, which staff code can't open: such a
    // quote is shown as the job last saved it.
    const quote = touchesConfidentialAccount(scoped.quote)
      ? scoped.quote
      : withReport(
          scoped.quote,
          yield* (yield* OneClick)
            .status(scoped.quote.depositAddress)
            .pipe(Effect.mapError(() => oneClickUnavailable)),
        );
    const evidence = yield* gatherQuoteEvidence(quote);
    return quoteEvidenceView(quote, evidence, scoped.payouts);
  });
}
