import { and, count, eq } from "drizzle-orm";
import { Effect } from "effect";

import type {
  InvoicePaymentKind,
  InvoiceStatus,
} from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import { invoicePayments, invoices } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * Recording and removing invoice payments inside the caller's transaction,
 * so a deposit and the payment it settles commit together
 * (docs/decisions/crypto-invoicing.md, "Matching").
 */

export interface RecordInvoicePaymentInput {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly kind: InvoicePaymentKind;
  /** `link` only: the invoice payment quote the customer paid. */
  readonly intentQuoteId?: string;
  /** `link` and `matched`: the deposit in the company wallet. */
  readonly walletTransactionId?: string;
  /** `link` and `matched`: USDC base units received. */
  readonly amountUsdc?: bigint;
  /** The Nairobi calendar day the money arrived, `YYYY-MM-DD`. */
  readonly paidOn: string;
  readonly reference?: string;
  readonly note?: string;
  /** A user for a hand-recorded payment; the watcher for a link payment. */
  readonly actor: AuditActor;
}

export interface RecordedInvoicePayment {
  readonly paymentId: string;
  readonly status: InvoiceStatus;
}

const draftHasNoPayments = new Conflict({
  message: "A draft invoice can't be paid. Send it first.",
});
const voidedHasNoPayments = new Conflict({
  message: "This invoice was voided. Restore the money by hand, not here.",
});
const alreadyPaid = new Conflict({ message: "This invoice is already paid." });
const depositInUse = new Conflict({
  message: "That deposit already pays an invoice.",
});
const invoiceNotFound = new NotFound({ message: "Invoice not found." });

const recordedBy = (actor: AuditActor): string | null =>
  actor.type === "user" ? actor.id : null;

function lockInvoice(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
) {
  return query(() =>
    tx
      .select()
      .from(invoices)
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.organizationId, organizationId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([invoice]) =>
      invoice ? Effect.succeed(invoice) : Effect.fail(invoiceNotFound),
    ),
  );
}

/**
 * Locks the invoice, records the payment and settles the invoice:
 *
 * - open becomes paid.
 * - void becomes paid, for a `link` payment only: the customer paid before
 *   or while it was voided, and that money is the company's. The void
 *   fields are cleared and the audit entry keeps what they were.
 * - paid stays paid for a `link` payment, which is recorded so the company
 *   can settle the extra with the customer. A hand-recorded payment on a
 *   paid invoice is refused.
 * - a draft takes no payment.
 */
export function recordInvoicePayment(
  tx: Transaction,
  input: RecordInvoicePaymentInput,
): Effect.Effect<
  RecordedInvoicePayment,
  Conflict | NotFound | DatabaseError,
  AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const invoice = yield* lockInvoice(
      tx,
      input.organizationId,
      input.invoiceId,
    );
    const viaLink = input.kind === "link";

    if (invoice.status === "draft")
      return yield* Effect.fail(draftHasNoPayments);
    if (invoice.status === "void" && !viaLink) {
      return yield* Effect.fail(voidedHasNoPayments);
    }
    if (invoice.status === "paid" && !viaLink) {
      return yield* Effect.fail(alreadyPaid);
    }

    const { walletTransactionId } = input;
    if (walletTransactionId !== undefined) {
      const [taken] = yield* query(() =>
        tx
          .select({ id: invoicePayments.id })
          .from(invoicePayments)
          .where(eq(invoicePayments.walletTransactionId, walletTransactionId)),
      );
      if (taken) return yield* Effect.fail(depositInUse);
    }

    const [payment] = yield* query(() =>
      tx
        .insert(invoicePayments)
        .values({
          organizationId: input.organizationId,
          invoiceId: input.invoiceId,
          kind: input.kind,
          intentQuoteId: input.intentQuoteId ?? null,
          walletTransactionId: input.walletTransactionId ?? null,
          amountUsdc: input.amountUsdc ?? null,
          paidOn: input.paidOn,
          reference: input.reference ?? null,
          note: input.note ?? null,
          recordedBy: recordedBy(input.actor),
        })
        .returning({ id: invoicePayments.id }),
    );
    if (!payment) {
      return yield* Effect.dieMessage("invoice payment insert wrote no row");
    }

    const settles = invoice.status !== "paid";
    if (settles) {
      yield* query(() =>
        tx
          .update(invoices)
          .set({
            status: "paid",
            paidAt: new Date(),
            voidedAt: null,
            voidedReason: null,
            voidedBy: null,
          })
          .where(eq(invoices.id, invoice.id)),
      );
    }

    yield* audit.record(tx, {
      actor: input.actor,
      organizationId: input.organizationId,
      action: settles ? "invoice.paid" : "invoice.payment_recorded",
      entity: { type: "invoice", id: invoice.id },
      before: {
        status: invoice.status,
        ...(invoice.status === "void"
          ? {
              voidedAt: invoice.voidedAt,
              voidedReason: invoice.voidedReason,
              voidedBy: invoice.voidedBy,
            }
          : {}),
      },
      after: {
        status: "paid",
        paymentId: payment.id,
        kind: input.kind,
        amountUsdc: input.amountUsdc ?? null,
        paidOn: input.paidOn,
        ...(invoice.status === "void" ? { note: "paid after void" } : {}),
      },
    });

    return { paymentId: payment.id, status: "paid" as const };
  });
}

export interface RemoveInvoicePaymentInput {
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly paymentId: string;
  readonly actor: AuditActor;
}

/**
 * Removes a payment marked or matched by hand. When it was the last one, a
 * paid invoice reopens. A payment through the pay link stays: that money
 * arrived for this invoice.
 */
export function removeInvoicePayment(
  tx: Transaction,
  input: RemoveInvoicePaymentInput,
): Effect.Effect<
  { readonly status: InvoiceStatus },
  Conflict | NotFound | DatabaseError,
  AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const invoice = yield* lockInvoice(
      tx,
      input.organizationId,
      input.invoiceId,
    );
    const [payment] = yield* query(() =>
      tx
        .select()
        .from(invoicePayments)
        .where(
          and(
            eq(invoicePayments.id, input.paymentId),
            eq(invoicePayments.invoiceId, input.invoiceId),
            eq(invoicePayments.organizationId, input.organizationId),
          ),
        ),
    );
    if (!payment) {
      return yield* Effect.fail(
        new NotFound({ message: "Payment not found." }),
      );
    }
    if (payment.kind === "link") {
      return yield* Effect.fail(
        new Conflict({
          message:
            "A payment made through the pay link can't be undone: that money arrived for this invoice.",
        }),
      );
    }

    yield* query(() =>
      tx.delete(invoicePayments).where(eq(invoicePayments.id, payment.id)),
    );
    const [remaining] = yield* query(() =>
      tx
        .select({ count: count() })
        .from(invoicePayments)
        .where(eq(invoicePayments.invoiceId, invoice.id)),
    );
    const reopens = invoice.status === "paid" && (remaining?.count ?? 0) === 0;
    if (reopens) {
      yield* query(() =>
        tx
          .update(invoices)
          .set({ status: "open", paidAt: null })
          .where(eq(invoices.id, invoice.id)),
      );
    }

    yield* audit.record(tx, {
      actor: input.actor,
      organizationId: input.organizationId,
      action: "invoice.payment_removed",
      entity: { type: "invoice", id: invoice.id },
      before: {
        status: invoice.status,
        paymentId: payment.id,
        kind: payment.kind,
        amountUsdc: payment.amountUsdc,
        paidOn: payment.paidOn,
      },
      after: { status: reopens ? "open" : invoice.status },
    });

    return { status: reopens ? ("open" as const) : invoice.status };
  });
}
