import { and, eq } from "drizzle-orm";
import { Cause, Effect } from "effect";

import {
  FUND_IN_CHAIN_NAMES,
  nearTransactionUrl,
} from "@expendi-business/shared";

import type { ConfigService } from "../../config.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor, AuditLog } from "../audit/audit-log.js";
import type { InvoiceReceiptEmailInput } from "../email/invoice-receipt-email.js";
import { intentQuotes, invoices } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { EmailSender } from "../email/email-sender.js";
import { invoiceReceiptEmail } from "../email/invoice-receipt-email.js";
import { nairobiToday } from "../expenses/rules.js";
import { chainOfAsset } from "../intents/fund-in.js";
import { notify } from "../notification/notify.js";
import { payUrlFor } from "./invoices.js";
import { recordInvoicePayment } from "./payment-record.js";

/** What the receipt needs, gathered inside the transaction that records the payment. */
export type InvoiceReceipt = Omit<InvoiceReceiptEmailInput, "pdfUrl"> & {
  /** The invoice's pay link ID, which the receipt's PDF link is built from. */
  readonly publicId: string | null;
};

export interface LinkPayment {
  readonly paymentId: string;
  readonly invoiceId: string;
  /** Null when the invoice has no customer email to send to. */
  readonly receipt: InvoiceReceipt | null;
}

/**
 * Records the payment an `invoice_payment` quote's delivery makes, inside
 * the transaction that credits the deposit, and queues the admins' notice
 * in it too. The rules for a void or already paid invoice are
 * `recordInvoicePayment`'s. Its refusals can't happen for a quote that
 * delivered a fresh deposit, so one is a defect: the credit rolls back
 * rather than leave a deposit with no payment.
 */
export function recordLinkPayment(
  tx: Transaction,
  input: {
    readonly organizationId: string;
    readonly intentQuoteId: string;
    readonly walletTransactionId: string;
    /** The NEAR transaction that delivered it. */
    readonly txHash: string;
    /** USDC base units the company wallet received. */
    readonly receivedUsdc: bigint;
    readonly actor: AuditActor;
  },
): Effect.Effect<LinkPayment, DatabaseError, AuditLog> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const [quote] = yield* query(() =>
      tx
        .select({
          invoiceId: intentQuotes.invoiceId,
          originAsset: intentQuotes.originAsset,
          amountIn: intentQuotes.amountIn,
        })
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.id, input.intentQuoteId),
            eq(intentQuotes.organizationId, organizationId),
          ),
        ),
    );
    if (!quote?.invoiceId) {
      return yield* Effect.dieMessage(
        `invoice payment quote ${input.intentQuoteId} has no invoice`,
      );
    }
    const { invoiceId } = quote;
    const [before] = yield* query(() =>
      tx
        .select({
          number: invoices.number,
          publicId: invoices.publicId,
          status: invoices.status,
          billTo: invoices.billTo,
          fromParty: invoices.fromParty,
        })
        .from(invoices)
        .where(
          and(
            eq(invoices.id, invoiceId),
            eq(invoices.organizationId, organizationId),
          ),
        ),
    );
    if (!before) {
      return yield* Effect.dieMessage(`invoice ${invoiceId} not found`);
    }

    const paidOn = nairobiToday();
    const recorded = yield* recordInvoicePayment(tx, {
      organizationId,
      invoiceId,
      kind: "link",
      intentQuoteId: input.intentQuoteId,
      walletTransactionId: input.walletTransactionId,
      amountUsdc: input.receivedUsdc,
      paidOn,
      actor: input.actor,
    }).pipe(
      Effect.catchTags({
        Conflict: (error) => Effect.die(error),
        NotFound: (error) => Effect.die(error),
      }),
    );

    yield* notify(tx, {
      kind: "invoice_paid",
      organizationId,
      invoiceId,
      paymentId: recorded.paymentId,
      amountUsdc: quote.amountIn,
      extra: before.status === "paid",
    });

    const chain = chainOfAsset(quote.originAsset);
    const to = before.billTo?.email;
    return {
      paymentId: recorded.paymentId,
      invoiceId,
      receipt:
        to === undefined || chain === null
          ? null
          : {
              to,
              invoiceNumber: before.number,
              companyName: before.fromParty?.name ?? "Your supplier",
              amountUsdc: quote.amountIn,
              chainName: FUND_IN_CHAIN_NAMES[chain],
              paidOn,
              paymentId: recorded.paymentId,
              publicId: before.publicId,
              transactionUrl: nearTransactionUrl(input.txHash),
            },
    };
  });
}

/**
 * Emails the customer their receipt once the payment has committed. A
 * failure is logged and goes no further: the money is already credited
 * and the invoice paid, and the deposit won't be seen again to retry from.
 */
export function sendInvoiceReceipt(
  receipt: InvoiceReceipt,
): Effect.Effect<void, never, EmailSender | ConfigService> {
  return Effect.gen(function* () {
    const email = yield* EmailSender;
    const { publicId, ...rest } = receipt;
    const pdfUrl =
      publicId === null
        ? null
        : yield* payUrlFor(publicId).pipe(
            Effect.map((payUrl) => `${payUrl}/pdf`),
            Effect.orElseSucceed(() => null),
          );
    yield* email.send(invoiceReceiptEmail({ ...rest, pdfUrl }));
  }).pipe(
    Effect.catchAllCause((cause) =>
      Effect.sync(() =>
        console.error(
          `[invoice-receipt] receipt for payment ${receipt.paymentId} not sent`,
          Cause.pretty(cause),
        ),
      ),
    ),
  );
}
