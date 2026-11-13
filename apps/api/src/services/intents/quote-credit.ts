import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { ConfigService } from "../../config.js";
import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { EmailSender } from "../email/email-sender.js";
import { intentQuotes, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  recordLinkPayment,
  sendInvoiceReceipt,
} from "../invoices/link-payment.js";

/**
 * Crediting the ledger for a delivery into a confidential account
 * (docs/decisions/confidential-accounts.md, decision 2). Such a delivery
 * never appears on a public chain, so the deposit watcher can't see it: the
 * ledger is credited when 1Click reports the quote `SUCCESS`, for the amount
 * 1Click says it delivered.
 *
 * Only a quote's own columns decide whether it is credited here. A quote
 * opened while the company's USDC sat in the company wallet delivers there
 * and is credited by the watcher, whatever the company's `balance_home` is
 * now.
 */

const ACTOR: AuditActor = { type: "system", id: "quote-credit" };

export type QuoteCreditOutcome =
  "credited" | "already_credited" | "not_creditable" | "amount_unusable";

export interface QuoteCreditSummary {
  readonly credited: number;
  /** Settled quotes whose reported amount couldn't be credited; they stay due. */
  readonly unusable: number;
  readonly errors: number;
}

interface QuoteRef extends Record<string, unknown> {
  readonly quote_id: string;
  readonly organization_id: string;
}

type CreditDeps = DatabaseService | AuditLog | EmailSender | ConfigService;

/**
 * Credits one settled delivery to a confidential account, once.
 *
 * In one transaction, holding the quote's row lock:
 *
 * 1. the quote must have `succeeded` with 1Click reporting `SUCCESS`, deliver
 *    to a confidential account, and be a fund-in, an invoice payment, a
 *    fund-in return or a Move to wallet's return from Treasury; otherwise `not_creditable`. One already credited is
 *    `already_credited`;
 * 2. the amount is what 1Click reports delivered (`swappedAmountOut`). It is
 *    refused, and logged on every run, when it is missing, not positive or
 *    above what was deposited: every route credited here is USDC to USDC, so
 *    more out than in means 1Click's answer is wrong;
 * 3. the ledger row is a deposit (`from_treasury`, linked to its move, for a
 *    return from Treasury) with no chain transaction, linked to the quote. The unique index on a quote's settlement credit makes a second
 *    insert a no-op even without the lock;
 * 4. an invoice payment marks its invoice paid in the same transaction;
 * 5. the audit entry is written and `ledger_credited_at` set.
 *
 * The customer's receipt is sent after the commit.
 */
export function creditSettledQuote(ref: {
  readonly quoteId: string;
  readonly organizationId: string;
}): Effect.Effect<QuoteCreditOutcome, DatabaseError, CreditDeps> {
  const { quoteId, organizationId } = ref;
  return Effect.gen(function* () {
    const credited = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const [quote] = yield* query(() =>
          tx
            .select()
            .from(intentQuotes)
            .where(
              and(
                eq(intentQuotes.id, quoteId),
                eq(intentQuotes.organizationId, organizationId),
              ),
            )
            .for("update"),
        );
        if (
          quote?.status !== "succeeded" ||
          quote.oneClickStatus !== "SUCCESS" ||
          quote.recipientType !== "CONFIDENTIAL_INTENTS" ||
          (quote.purpose !== "fund_in" &&
            quote.purpose !== "invoice_payment" &&
            quote.purpose !== "fund_in_return" &&
            quote.purpose !== "from_treasury")
        ) {
          return { outcome: "not_creditable" as const };
        }
        if (quote.ledgerCreditedAt !== null) {
          return { outcome: "already_credited" as const };
        }

        const delivered = quote.swappedAmountOut;
        const deposited = quote.depositedAmount ?? quote.amountIn;
        if (delivered === null || delivered <= 0n || delivered > deposited) {
          console.error(
            `[quote-credit] quote ${quote.id} succeeded but 1Click reports ${delivered === null ? "no amount" : `${delivered} delivered`} for ${deposited} deposited; not credited`,
          );
          return { outcome: "amount_unusable" as const };
        }

        const fromTreasury = quote.purpose === "from_treasury";
        const [credit] = yield* query(() =>
          tx
            .insert(walletTransactions)
            .values({
              organizationId,
              walletId: quote.walletId,
              type: fromTreasury ? "from_treasury" : "deposit",
              treasuryMoveId: fromTreasury ? quote.treasuryMoveId : null,
              chain: "near",
              usdcAmount: delivered,
              intentQuoteId: quote.id,
              txHash: null,
              receiptId: null,
              logIndex: null,
              transferIndex: null,
              blockNumber: null,
              counterpartyAddress: null,
            })
            .onConflictDoNothing()
            .returning({ id: walletTransactions.id }),
        );
        const markCredited = query(() =>
          tx
            .update(intentQuotes)
            .set({ ledgerCreditedAt: sql`now()` })
            .where(eq(intentQuotes.id, quote.id)),
        );
        if (!credit) {
          yield* markCredited;
          return { outcome: "already_credited" as const };
        }

        const payment =
          quote.purpose === "invoice_payment"
            ? yield* recordLinkPayment(tx, {
                organizationId,
                intentQuoteId: quote.id,
                walletTransactionId: credit.id,
                txHash: null,
                receivedUsdc: delivered,
                actor: ACTOR,
              })
            : null;
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: fromTreasury
            ? "wallet.treasury_returned"
            : "wallet.deposit_received",
          entity: { type: "wallet_transaction", id: credit.id },
          after: {
            intentQuoteId: quote.id,
            purpose: quote.purpose,
            ...(fromTreasury && {
              treasuryMoveId: quote.treasuryMoveId,
              treasuryQuoteId: quote.id,
              treasuryQuotePurpose: quote.purpose,
            }),
            ...(quote.purpose === "fund_in" && { fundInId: quote.id }),
            ...(quote.purpose === "fund_in_return" && {
              fundInReturnId: quote.id,
            }),
            ...(payment !== null && {
              invoiceId: payment.invoiceId,
              invoicePaymentId: payment.paymentId,
            }),
            walletId: quote.walletId,
            chain: "near",
            usdcAmount: delivered,
            source: "one_click_success",
            oneClickCheckedAt: quote.oneClickCheckedAt?.toISOString() ?? null,
          },
        });
        yield* markCredited;
        return {
          outcome: "credited" as const,
          receipt: payment?.receipt ?? null,
        };
      }),
    );
    if (credited.outcome === "credited" && credited.receipt !== null) {
      yield* sendInvoiceReceipt(credited.receipt);
    }
    return credited.outcome;
  });
}

/**
 * Credits every settled delivery to a confidential account that isn't
 * credited yet, whichever code path settled it: the fund-in refresh, the
 * fund-in return job, or staff resolving a quote. Each quote is handled on
 * its own, so one failure never stops the rest.
 */
export function creditSettledQuotes(
  maxRows = 50,
): Effect.Effect<QuoteCreditSummary, DatabaseError, CreditDeps> {
  return Effect.gen(function* () {
    const { rows: due } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<QuoteRef>(
          sql`SELECT quote_id, organization_id FROM confidential_quotes_to_credit(${maxRows})`,
        ),
      ),
    );
    let credited = 0;
    let unusable = 0;
    let errors = 0;
    for (const ref of due) {
      const exit = yield* Effect.exit(
        creditSettledQuote({
          quoteId: ref.quote_id,
          organizationId: ref.organization_id,
        }),
      );
      if (Exit.isFailure(exit)) {
        errors += 1;
        console.error(
          `[quote-credit] quote ${ref.quote_id} not credited`,
          Cause.pretty(exit.cause),
        );
      } else if (exit.value === "credited") {
        credited += 1;
      } else if (exit.value === "amount_unusable") {
        unusable += 1;
      }
    }
    return { credited, unusable, errors };
  });
}
