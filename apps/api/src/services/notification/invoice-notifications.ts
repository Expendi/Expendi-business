import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { formatUsdAmount } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import { invoices } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * Invoicing (docs/decisions/crypto-invoicing.md). Admins hear when a
 * customer pays through the pay link; the invoices are theirs alone to
 * read, so nobody else is told.
 */
export interface InvoiceNotificationEvent {
  readonly kind: "invoice_paid";
  readonly organizationId: string;
  readonly invoiceId: string;
  readonly paymentId: string;
  /** USDC base units the customer paid. */
  readonly amountUsdc: bigint;
  /** The invoice was already paid: this payment is extra to settle. */
  readonly extra: boolean;
}

export function invoiceNotifications(
  tx: Transaction,
  event: InvoiceNotificationEvent,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return query(() =>
    tx
      .select({ number: invoices.number })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, event.invoiceId),
          eq(invoices.organizationId, event.organizationId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([invoice]) =>
      invoice
        ? [
            {
              audience: { to: "admins", exceptMembershipId: null } as const,
              title: event.extra
                ? `Invoice ${invoice.number} was paid again`
                : `Invoice ${invoice.number} was paid`,
              body: event.extra
                ? `${formatUsdAmount(event.amountUsdc)} arrived for an invoice that was already paid. Settle the extra with your customer.`
                : `${formatUsdAmount(event.amountUsdc)} arrived through the pay link.`,
              data: {
                type: event.kind,
                organizationId: event.organizationId,
                invoiceId: event.invoiceId,
              },
              dedupeKey: `invoice_paid:${event.paymentId}`,
            },
          ]
        : [],
    ),
  );
}
