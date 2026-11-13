import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type {
  FundInChain,
  PublicInvoice,
  PublicPayQuote,
} from "@expendi-business/shared";
import { FUND_IN_CHAINS } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { ConfidentialAccounts } from "../intents/confidential-account.js";
import {
  intentQuotes,
  invoiceLineItems,
  invoicePayments,
  invoices,
  UNSETTLED_INTENT_QUOTE_STATUSES,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound, ServiceUnavailable } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiToday } from "../expenses/rules.js";
import {
  chainOfAsset,
  FUND_IN_DEADLINE_MS,
  FUND_IN_SLIPPAGE_BPS,
  quoteDelivery,
  refreshFundIn,
} from "../intents/fund-in.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
  OneClick,
} from "../intents/one-click.js";
import { centsToUsdc } from "./money.js";
import { findInvoiceByPublicId } from "./public-lookup.js";

/**
 * The pay link's server side (docs/decisions/crypto-invoicing.md, "The pay
 * link"). Everything here is reached with only a public ID, so each read
 * resolves it to one invoice first and never returns a company's ID.
 */

/** A quote with less than this left isn't offered again: a customer needs time to pay. */
export const REUSE_MIN_REMAINING_MS = 30 * 60_000;

/** How old 1Click's last answer may be before a status request asks again. */
export const QUOTE_STATUS_MAX_AGE_MS = 15_000;

const PAY_LINK_ACTOR: AuditActor = { type: "system", id: "invoice-pay-link" };

const invoiceNotFound = new NotFound({ message: "Invoice not found." });
const quoteNotFound = new NotFound({ message: "Quote not found." });
const notOpen = new Conflict({
  message: "This invoice isn't open for payment.",
});
const walletNotReady = new Conflict({
  message: "This company can't take payments right now.",
});
const quoteUnavailable = new ServiceUnavailable({
  message:
    "Paying this invoice isn't available right now. Try again in a minute.",
});

interface PayTarget {
  readonly invoiceId: string;
  readonly organizationId: string;
}

const resolve = (
  publicId: string,
): Effect.Effect<PayTarget, NotFound | DatabaseError, DatabaseService> =>
  findInvoiceByPublicId(publicId).pipe(
    Effect.flatMap((target) =>
      target === null ? Effect.fail(invoiceNotFound) : Effect.succeed(target),
    ),
  );

/** The company wallet when it can take money, the check fund-ins make. */
function activeWallet(organizationId: string) {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          id: wallets.id,
          chain: wallets.chain,
          status: wallets.status,
          address: wallets.address,
          balanceHome: wallets.balanceHome,
          privyWalletId: wallets.privyWalletId,
        })
        .from(wallets)
        .where(eq(wallets.organizationId, organizationId))
        .limit(1),
    ),
  ).pipe(
    Effect.map(([wallet]) =>
      wallet?.status === "active" &&
      wallet.chain === "near" &&
      wallet.address !== null
        ? {
            id: wallet.id,
            accountId: wallet.address,
            balanceHome: wallet.balanceHome,
            privyWalletId: wallet.privyWalletId,
          }
        : null,
    ),
  );
}

function readInvoice(target: PayTarget) {
  return withScope({ organizationId: target.organizationId }, (tx) =>
    Effect.gen(function* () {
      const [invoice] = yield* query(() =>
        tx
          .select()
          .from(invoices)
          .where(
            and(
              eq(invoices.id, target.invoiceId),
              eq(invoices.organizationId, target.organizationId),
            ),
          ),
      );
      if (!invoice || invoice.status === "draft") {
        return yield* Effect.fail(invoiceNotFound);
      }
      const lines = yield* query(() =>
        tx
          .select()
          .from(invoiceLineItems)
          .where(eq(invoiceLineItems.invoiceId, invoice.id))
          .orderBy(asc(invoiceLineItems.position)),
      );
      return { invoice, lines };
    }),
  );
}

/** The invoice as its customer sees it. Null `billTo`/`fromParty` only occur on drafts. */
export function getPublicInvoice(
  publicId: string,
): Effect.Effect<PublicInvoice, NotFound | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const target = yield* resolve(publicId);
    const { invoice, lines } = yield* readInvoice(target);
    const { billTo, fromParty } = invoice;
    if (billTo === null || fromParty === null || invoice.status === "draft") {
      return yield* Effect.fail(invoiceNotFound);
    }
    const wallet = yield* activeWallet(target.organizationId);
    return {
      number: invoice.number,
      status: invoice.status,
      overdue: invoice.status === "open" && invoice.dueOn < nairobiToday(),
      from: fromParty,
      billTo,
      issueOn: invoice.issueOn,
      dueOn: invoice.dueOn,
      lines: lines.map((line) => ({
        id: line.id,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: line.unitPriceCents.toString(),
        amountCents: line.amountCents.toString(),
      })),
      subtotalCents: invoice.subtotalCents.toString(),
      taxRateBps: invoice.taxRateBps,
      taxLabel: invoice.taxLabel,
      taxCents: invoice.taxCents.toString(),
      totalCents: invoice.totalCents.toString(),
      note: invoice.note,
      chains: [...FUND_IN_CHAINS],
      canPay: invoice.status === "open" && wallet !== null,
    };
  });
}

/**
 * What the customer's page shows for a quote. `succeeded` without a
 * payment is 1Click having delivered and the watcher not yet crediting it.
 */
export function payQuoteStatus(
  quote: Pick<IntentQuote, "status" | "oneClickStatus">,
  paid: boolean,
): PublicPayQuote["status"] {
  if (paid) return "paid";
  switch (quote.status) {
    case "quoted":
    case "depositing":
      return quote.oneClickStatus === null ||
        quote.oneClickStatus === "PENDING_DEPOSIT"
        ? "awaiting_deposit"
        : "processing";
    case "needs_review":
    case "succeeded":
      return "processing";
    case "refunded":
    case "failed":
      return "needs_attention";
    case "expired":
      return "expired";
  }
}

function toPublicQuote(
  quote: IntentQuote,
  paid: boolean,
): Effect.Effect<PublicPayQuote> {
  const chain = chainOfAsset(quote.originAsset);
  return chain === null
    ? Effect.dieMessage(
        `invoice payment ${quote.id} starts from an asset no fund-in chain uses`,
      )
    : Effect.succeed({
        id: quote.id,
        chain,
        amountIn: quote.amountIn.toString(),
        depositAddress: quote.depositAddress,
        deadline: quote.deadline.toISOString(),
        status: payQuoteStatus(quote, paid),
      });
}

function linkPaymentExists(
  organizationId: string,
  intentQuoteId: string,
): Effect.Effect<boolean, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ id: invoicePayments.id })
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.intentQuoteId, intentQuoteId),
            eq(invoicePayments.kind, "link"),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

/**
 * The customer's way to pay: an open quote for the chain with time left, or
 * a new firm 1Click quote for exactly the invoice total, taken the way a
 * fund-in takes its quote. Refused unless the invoice is open and the
 * company wallet can receive.
 */
export function quoteForPayment(
  publicId: string,
  chain: FundInChain,
): Effect.Effect<
  PublicPayQuote,
  Conflict | NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | OneClick | AuditLog | ConfidentialAccounts
> {
  return Effect.gen(function* () {
    const oneClick = yield* OneClick;
    const audit = yield* AuditLog;
    const target = yield* resolve(publicId);
    const { organizationId, invoiceId } = target;
    const { invoice } = yield* readInvoice(target);
    if (invoice.status !== "open") return yield* Effect.fail(notOpen);
    const wallet = yield* activeWallet(organizationId);
    if (wallet === null) return yield* Effect.fail(walletNotReady);

    const originAsset = ONE_CLICK_FUND_IN_USDC_ASSET_IDS[chain];
    const [open] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.organizationId, organizationId),
              eq(intentQuotes.invoiceId, invoiceId),
              eq(intentQuotes.purpose, "invoice_payment"),
              eq(intentQuotes.originAsset, originAsset),
              inArray(intentQuotes.status, ["quoted", "depositing"]),
              gt(
                intentQuotes.deadline,
                new Date(Date.now() + REUSE_MIN_REMAINING_MS),
              ),
            ),
          )
          .orderBy(desc(intentQuotes.createdAt))
          .limit(1),
      ),
    );
    if (open) return yield* toPublicQuote(open, false);

    const delivery = yield* quoteDelivery({
      balanceHome: wallet.balanceHome,
      privyWalletId: wallet.privyWalletId,
      address: wallet.accountId,
    }).pipe(
      Effect.catchAll((error) => {
        console.error(`[pay-link] no session to quote with: ${error.message}`);
        return Effect.fail(quoteUnavailable);
      }),
    );
    const quote = yield* oneClick
      .quote(
        {
          dry: false,
          swapType: "EXACT_INPUT",
          originAsset,
          destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
          amount: centsToUsdc(invoice.totalCents),
          recipient: wallet.accountId,
          ...delivery.deliverTo,
          refundTo: wallet.accountId,
          refundType: "INTENTS",
          deadline: new Date(Date.now() + FUND_IN_DEADLINE_MS),
          slippageBps: FUND_IN_SLIPPAGE_BPS,
        },
        delivery.session,
      )
      .pipe(
        Effect.catchTags({
          OneClickRefused: (error) => {
            console.warn(`[pay-link] quote refused: ${error.message}`);
            return Effect.fail(quoteUnavailable);
          },
          OneClickOutcomeUnknown: (error) => {
            console.error(`[pay-link] quote unavailable: ${error.message}`);
            return Effect.fail(quoteUnavailable);
          },
          OneClickQuoteUntrusted: (error) => {
            console.error(`[pay-link] quote not trusted: ${error.message}`);
            return Effect.fail(quoteUnavailable);
          },
        }),
      );
    // The page shows an address and an amount, nothing more: a deposit that
    // also needs a memo would be lost to the quote.
    if (quote.dry || quote.depositMemo !== null) {
      console.error("[pay-link] quote came dry or needing a memo; not used");
      return yield* Effect.fail(quoteUnavailable);
    }

    const saved = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const [row] = yield* query(() =>
          tx
            .insert(intentQuotes)
            .values({
              organizationId,
              walletId: wallet.id,
              quoteKey: `invoice-payment:${invoiceId}:${chain}:${randomUUID()}`,
              purpose: "invoice_payment",
              invoiceId,
              swapType: "EXACT_INPUT",
              originAsset,
              destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
              amountIn: quote.amountIn,
              minAmountIn: quote.minAmountIn,
              amountOut: quote.amountOut,
              minAmountOut: quote.minAmountOut,
              depositAddress: quote.depositAddress,
              recipient: wallet.accountId,
              ...delivery.deliverTo,
              refundTo: wallet.accountId,
              refundType: "INTENTS",
              deadline: quote.deadline,
              quoteResponse: quote.signedResponse,
            })
            .returning(),
        );
        if (!row) {
          return yield* Effect.dieMessage(
            "invoice payment quote insert returned no row",
          );
        }
        yield* audit.record(tx, {
          actor: PAY_LINK_ACTOR,
          organizationId,
          action: "invoice.payment_quote_created",
          entity: { type: "invoice", id: invoiceId },
          after: {
            quoteId: row.id,
            chain,
            amountIn: row.amountIn,
            amountOut: row.amountOut,
            depositAddress: row.depositAddress,
            refundTo: row.refundTo,
            deadline: row.deadline.toISOString(),
          },
        });
        return row;
      }),
    );
    return yield* toPublicQuote(saved, false);
  });
}

function unrefreshed(
  quote: IntentQuote,
  reason: string,
): Effect.Effect<IntentQuote> {
  return Effect.sync(() => {
    console.warn(`[pay-link] quote ${quote.id} not refreshed: ${reason}`);
    return quote;
  });
}

/**
 * A quote of this invoice as the page polls it. When 1Click was last asked
 * more than `QUOTE_STATUS_MAX_AGE_MS` ago and the quote is unsettled, it is
 * asked again first; if that fails the stored state is answered, since the
 * fund-in job keeps trying.
 */
export function getPayQuote(
  publicId: string,
  quoteId: string,
): Effect.Effect<
  PublicPayQuote,
  NotFound | DatabaseError,
  DatabaseService | OneClick | ConfidentialAccounts
> {
  return Effect.gen(function* () {
    const { organizationId, invoiceId } = yield* resolve(publicId);
    const [stored] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(
            and(
              eq(intentQuotes.id, quoteId),
              eq(intentQuotes.organizationId, organizationId),
              eq(intentQuotes.invoiceId, invoiceId),
              eq(intentQuotes.purpose, "invoice_payment"),
            ),
          ),
      ),
    );
    if (!stored) return yield* Effect.fail(quoteNotFound);

    const stale =
      stored.oneClickCheckedAt === null ||
      Date.now() - stored.oneClickCheckedAt.getTime() > QUOTE_STATUS_MAX_AGE_MS;
    const unsettled = new Set<string>(UNSETTLED_INTENT_QUOTE_STATUSES).has(
      stored.status,
    );
    const current =
      stale && unsettled
        ? yield* refreshFundIn(stored).pipe(
            Effect.catchTags({
              OneClickRefused: (error) => unrefreshed(stored, error.message),
              OneClickOutcomeUnknown: (error) =>
                unrefreshed(stored, error.message),
              SendRefused: (error) => unrefreshed(stored, error.message),
              PrivyWalletError: (error) => unrefreshed(stored, error.message),
              NearRpcError: (error) => unrefreshed(stored, error.message),
            }),
          )
        : stored;
    return yield* toPublicQuote(
      current,
      yield* linkPaymentExists(organizationId, current.id),
    );
  });
}
