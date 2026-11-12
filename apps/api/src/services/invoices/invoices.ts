import type { SQL } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, lt, notExists } from "drizzle-orm";
import { Effect } from "effect";

import type {
  FundInChain,
  Invoice,
  InvoiceDraftInput,
  InvoiceMarkPaidInput,
  InvoicePayment,
  InvoiceStatus,
  InvoiceSummary,
  MatchableDeposit,
} from "@expendi-business/shared";
import { dueOnFor, suggestNextInvoiceNumber } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CustomerRow, InvoiceRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor } from "../audit/audit-log.js";
import { ConfigService } from "../../config.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  customers,
  intentQuotes,
  invoiceLineItems,
  invoicePayments,
  invoices,
  organizations,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { nairobiDate } from "../bills/status.js";
import { EmailSender } from "../email/email-sender.js";
import { invoiceEmail } from "../email/invoice-email.js";
import { ONE_CLICK_FUND_IN_USDC_ASSET_IDS } from "../intents/one-click.js";
import { invoiceTotals } from "./money.js";
import {
  recordInvoicePayment,
  removeInvoicePayment,
} from "./payment-record.js";

/**
 * The admin side of invoicing (docs/decisions/crypto-invoicing.md): drafts,
 * sending, reminding, voiding and the hand-recorded payments. Every change
 * is audited in the transaction that makes it.
 */

/**
 * Most one invoice may come to. USDC base units are cents × 10,000 and must
 * fit a signed 64-bit column, which 9 × 10^14 cents does.
 */
const MAX_INVOICE_TOTAL_CENTS = 900_000_000_000_000n;
const REMINDER_INTERVAL_MS = 10 * 60_000;
const MAX_MATCHABLE_DEPOSITS = 50;

const invoiceNotFound = new NotFound({ message: "Invoice not found." });
const numberTaken = new Conflict({
  message: "That invoice number is already used.",
});
const tooMuch = new BadRequest({
  message: "That invoice comes to too much. Check the quantities and prices.",
});

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

const blankToUndefined = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value;

const CHAIN_BY_ORIGIN_ASSET: ReadonlyMap<string, FundInChain> = new Map(
  (
    Object.entries(ONE_CLICK_FUND_IN_USDC_ASSET_IDS) as [FundInChain, string][]
  ).map(([chain, asset]) => [asset, chain]),
);

// ── Reading ──────────────────────────────────────────────────────────────

const isOverdue = (
  status: InvoiceStatus,
  dueOn: string,
  today: string,
): boolean => status === "open" && dueOn < today;

function summaryOf(
  invoice: InvoiceRow,
  customerName: string,
  today: string,
): InvoiceSummary {
  return {
    id: invoice.id,
    number: invoice.number,
    customerName,
    status: invoice.status,
    overdue: isOverdue(invoice.status, invoice.dueOn, today),
    totalCents: invoice.totalCents.toString(),
    issueOn: invoice.issueOn,
    dueOn: invoice.dueOn,
    sentAt: invoice.sentAt?.toISOString() ?? null,
    paidAt: invoice.paidAt?.toISOString() ?? null,
  };
}

export type InvoiceListFilter = InvoiceStatus | "overdue";

export function listInvoices(
  tenant: Tenant,
  filter: InvoiceListFilter | undefined,
): Effect.Effect<
  { readonly invoices: InvoiceSummary[] },
  DatabaseError,
  DatabaseService
> {
  return Effect.suspend(() => {
    const today = nairobiDate(new Date());
    const byFilter: SQL | undefined =
      filter === undefined
        ? undefined
        : filter === "overdue"
          ? and(eq(invoices.status, "open"), lt(invoices.dueOn, today))
          : eq(invoices.status, filter);
    return withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ invoice: invoices, customerName: customers.name })
          .from(invoices)
          .innerJoin(
            customers,
            and(
              eq(customers.id, invoices.customerId),
              eq(customers.organizationId, invoices.organizationId),
            ),
          )
          .where(
            and(eq(invoices.organizationId, tenant.organizationId), byFilter),
          )
          .orderBy(desc(invoices.createdAt), desc(invoices.id)),
      ),
    ).pipe(
      Effect.map((rows) => ({
        invoices: rows.map(({ invoice, customerName }) =>
          summaryOf(invoice, customerName, today),
        ),
      })),
    );
  });
}

export function nextInvoiceNumber(
  tenant: Tenant,
): Effect.Effect<{ readonly number: string }, DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({ number: invoices.number })
        .from(invoices)
        .where(eq(invoices.organizationId, tenant.organizationId)),
    ),
  ).pipe(
    Effect.map((rows) => ({
      number: suggestNextInvoiceNumber(rows.map((row) => row.number)),
    })),
  );
}

interface InvoiceContext {
  readonly invoice: InvoiceRow;
  readonly customer: CustomerRow;
  readonly company: { readonly name: string; readonly kraPin: string | null };
}

function readContext(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
): Effect.Effect<InvoiceContext, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select({
        invoice: invoices,
        customer: customers,
        company: { name: organizations.name, kraPin: organizations.kraPin },
      })
      .from(invoices)
      .innerJoin(
        customers,
        and(
          eq(customers.id, invoices.customerId),
          eq(customers.organizationId, invoices.organizationId),
        ),
      )
      .innerJoin(organizations, eq(organizations.id, invoices.organizationId))
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.organizationId, organizationId),
        ),
      ),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(invoiceNotFound),
    ),
  );
}

/** The invoice as the admin sees it: a draft from live records, a sent one from its snapshots. */
export function readInvoice(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
): Effect.Effect<Invoice, NotFound | DatabaseError> {
  return Effect.gen(function* () {
    const { invoice, customer, company } = yield* readContext(
      tx,
      organizationId,
      invoiceId,
    );
    const lines = yield* query(() =>
      tx
        .select()
        .from(invoiceLineItems)
        .where(eq(invoiceLineItems.invoiceId, invoiceId))
        .orderBy(asc(invoiceLineItems.position)),
    );
    const paymentRows = yield* query(() =>
      tx
        .select({
          payment: invoicePayments,
          originAsset: intentQuotes.originAsset,
          txHash: walletTransactions.txHash,
        })
        .from(invoicePayments)
        .leftJoin(
          intentQuotes,
          eq(intentQuotes.id, invoicePayments.intentQuoteId),
        )
        .leftJoin(
          walletTransactions,
          eq(walletTransactions.id, invoicePayments.walletTransactionId),
        )
        .where(eq(invoicePayments.invoiceId, invoiceId))
        .orderBy(asc(invoicePayments.createdAt), asc(invoicePayments.id)),
    );

    const payments: InvoicePayment[] = paymentRows.map(
      ({ payment, originAsset, txHash }) => ({
        id: payment.id,
        kind: payment.kind,
        amountUsdc: payment.amountUsdc?.toString() ?? null,
        paidOn: payment.paidOn,
        reference: payment.reference,
        note: payment.note,
        txHash,
        chain:
          originAsset === null
            ? null
            : (CHAIN_BY_ORIGIN_ASSET.get(originAsset) ?? null),
        walletTransactionId: payment.walletTransactionId,
        recordedAt: payment.createdAt.toISOString(),
      }),
    );

    return {
      ...summaryOf(invoice, customer.name, nairobiDate(new Date())),
      customerId: customer.id,
      billTo: invoice.billTo ?? {
        name: customer.name,
        email: customer.email,
        address: customer.address,
        taxId: customer.taxId,
      },
      from: invoice.fromParty ?? { name: company.name, kraPin: company.kraPin },
      terms: invoice.terms,
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
      note: invoice.note,
      publicId: invoice.publicId,
      voidedReason: invoice.voidedReason,
      payments,
    };
  });
}

export function getInvoice(
  tenant: Tenant,
  invoiceId: string,
): Effect.Effect<Invoice, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    readInvoice(tx, tenant.organizationId, invoiceId),
  );
}

// ── Drafts ───────────────────────────────────────────────────────────────

function lockInvoice(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
): Effect.Effect<InvoiceRow, NotFound | DatabaseError> {
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
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(invoiceNotFound),
    ),
  );
}

function pickableCustomer(
  tx: Transaction,
  organizationId: string,
  customerId: string,
): Effect.Effect<CustomerRow, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.id, customerId),
          eq(customers.organizationId, organizationId),
        ),
      ),
  ).pipe(
    Effect.flatMap(([customer]) => {
      if (!customer)
        return Effect.fail(new BadRequest({ message: "Choose a customer." }));
      return customer.archivedAt === null
        ? Effect.succeed(customer)
        : Effect.fail(
            new BadRequest({
              message:
                "That customer is archived. Choose another customer or restore them.",
            }),
          );
    }),
  );
}

function draftValues(draft: InvoiceDraftInput) {
  const taxRateBps = draft.taxRateBps ?? null;
  const totals = invoiceTotals(
    draft.lines.map((line) => ({
      quantity: line.quantity,
      unitPriceCents: BigInt(line.unitPriceCents),
    })),
    taxRateBps,
  );
  return {
    totals,
    columns: {
      customerId: draft.customerId,
      number: draft.number,
      terms: draft.terms,
      issueOn: draft.issueOn,
      dueOn: dueOnFor(draft.issueOn, draft.terms, draft.dueOn),
      taxRateBps,
      taxLabel: draft.taxLabel,
      subtotalCents: totals.subtotalCents,
      taxCents: totals.taxCents,
      totalCents: totals.totalCents,
      note: blankToUndefined(draft.note) ?? null,
    },
  };
}

const numberConflict = <A, R>(
  effect: Effect.Effect<A, DatabaseError, R>,
): Effect.Effect<A, Conflict | DatabaseError, R> =>
  effect.pipe(
    Effect.catchAll((error) =>
      Effect.fail<Conflict | DatabaseError>(
        violatedUniqueConstraint(error.cause) ===
          "invoices_organization_number_unique"
          ? numberTaken
          : error,
      ),
    ),
  );

function writeLines(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
  draft: InvoiceDraftInput,
  lineAmounts: readonly bigint[],
) {
  return query(() =>
    tx.insert(invoiceLineItems).values(
      draft.lines.map((line, position) => ({
        organizationId,
        invoiceId,
        position,
        description: line.description,
        quantity: line.quantity,
        unitPriceCents: BigInt(line.unitPriceCents),
        amountCents: lineAmounts[position] ?? 0n,
      })),
    ),
  );
}

const auditedDraft = (
  columns: ReturnType<typeof draftValues>["columns"],
  lineCount: number,
) => ({ ...columns, lineCount });

export function createInvoiceDraft(
  tenant: Tenant,
  draft: InvoiceDraftInput,
): Effect.Effect<
  Invoice,
  BadRequest | Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const { totals, columns } = draftValues(draft);
    if (totals.totalCents > MAX_INVOICE_TOTAL_CENTS) {
      return yield* Effect.fail(tooMuch);
    }
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        yield* pickableCustomer(tx, tenant.organizationId, draft.customerId);
        const [row] = yield* numberConflict(
          query(() =>
            tx
              .insert(invoices)
              .values({
                ...columns,
                organizationId: tenant.organizationId,
                createdBy: tenant.userId,
              })
              .returning({ id: invoices.id }),
          ),
        );
        if (!row) return yield* Effect.dieMessage("invoice insert no row");
        yield* writeLines(
          tx,
          tenant.organizationId,
          row.id,
          draft,
          totals.lineAmounts,
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.created",
          entity: { type: "invoice", id: row.id },
          after: auditedDraft(columns, draft.lines.length),
        });
        return yield* readInvoice(tx, tenant.organizationId, row.id);
      }),
    );
  });
}

const onlyDraft = (what: string) =>
  new Conflict({ message: `Only a draft invoice can be ${what}.` });

export function updateInvoiceDraft(
  tenant: Tenant,
  invoiceId: string,
  draft: InvoiceDraftInput,
): Effect.Effect<
  Invoice,
  BadRequest | Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const { totals, columns } = draftValues(draft);
    if (totals.totalCents > MAX_INVOICE_TOTAL_CENTS) {
      return yield* Effect.fail(tooMuch);
    }
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const before = yield* lockInvoice(tx, tenant.organizationId, invoiceId);
        if (before.status !== "draft") {
          return yield* Effect.fail(onlyDraft("changed"));
        }
        if (draft.customerId !== before.customerId) {
          yield* pickableCustomer(tx, tenant.organizationId, draft.customerId);
        }
        yield* numberConflict(
          query(() =>
            tx.update(invoices).set(columns).where(eq(invoices.id, invoiceId)),
          ),
        );
        yield* query(() =>
          tx
            .delete(invoiceLineItems)
            .where(eq(invoiceLineItems.invoiceId, invoiceId)),
        );
        yield* writeLines(
          tx,
          tenant.organizationId,
          invoiceId,
          draft,
          totals.lineAmounts,
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.updated",
          entity: { type: "invoice", id: invoiceId },
          before: { number: before.number, totalCents: before.totalCents },
          after: auditedDraft(columns, draft.lines.length),
        });
        return yield* readInvoice(tx, tenant.organizationId, invoiceId);
      }),
    );
  });
}

export function deleteInvoiceDraft(
  tenant: Tenant,
  invoiceId: string,
): Effect.Effect<
  void,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const invoice = yield* lockInvoice(
          tx,
          tenant.organizationId,
          invoiceId,
        );
        if (invoice.status !== "draft") {
          return yield* Effect.fail(onlyDraft("deleted"));
        }
        yield* query(() =>
          tx.delete(invoices).where(eq(invoices.id, invoiceId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.deleted",
          entity: { type: "invoice", id: invoiceId },
          before: {
            number: invoice.number,
            customerId: invoice.customerId,
            totalCents: invoice.totalCents,
          },
        });
      }),
    );
  });
}

// ── Sending ──────────────────────────────────────────────────────────────

const walletNotReady = new Conflict({
  message: "Set up your company wallet before sending invoices.",
});

/** The pay link is on the first dashboard origin. */
function payUrlFor(
  publicId: string,
): Effect.Effect<string, ServiceUnavailable, ConfigService> {
  return Effect.flatMap(ConfigService, ({ dashboardOrigins }) => {
    const [origin] = dashboardOrigins;
    return origin === undefined
      ? Effect.fail(
          new ServiceUnavailable({
            message: "Invoices can't be emailed yet. Try again later.",
          }),
        )
      : Effect.succeed(`${origin.replace(/\/+$/, "")}/pay/${publicId}`);
  });
}

/** Fails with 503 before anything changes when there is nowhere to point the pay link. */
const assertPayLinkConfigured = payUrlFor("x").pipe(Effect.asVoid);

function companyWalletIsActive(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({
        status: wallets.status,
        chain: wallets.chain,
        address: wallets.address,
      })
      .from(wallets)
      .where(eq(wallets.organizationId, organizationId))
      .limit(1),
  ).pipe(
    Effect.map(
      ([wallet]) =>
        wallet?.status === "active" &&
        wallet.chain === "near" &&
        wallet.address !== null,
    ),
  );
}

function emailInvoice(input: {
  readonly invoice: InvoiceRow;
  readonly idempotencyKey: string;
  readonly reminder: boolean;
}): Effect.Effect<void, ServiceUnavailable, ConfigService | EmailSender> {
  return Effect.gen(function* () {
    const { invoice } = input;
    if (
      invoice.publicId === null ||
      invoice.billTo === null ||
      invoice.fromParty === null
    ) {
      return yield* Effect.dieMessage("emailing an invoice that was not sent");
    }
    const payUrl = yield* payUrlFor(invoice.publicId);
    const sender = yield* EmailSender;
    yield* sender
      .send(
        invoiceEmail({
          to: invoice.billTo.email,
          customerName: invoice.billTo.name,
          companyName: invoice.fromParty.name,
          number: invoice.number,
          totalCents: invoice.totalCents,
          dueOn: invoice.dueOn,
          note: invoice.note,
          payUrl,
          idempotencyKey: input.idempotencyKey,
          reminder: input.reminder,
        }),
      )
      .pipe(
        Effect.mapError(
          () =>
            new ServiceUnavailable({
              message: "Couldn't send the email. Try again in a minute.",
            }),
        ),
      );
  });
}

export function sendInvoice(
  tenant: Tenant,
  invoiceId: string,
): Effect.Effect<
  Invoice,
  BadRequest | Conflict | NotFound | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | ConfigService | EmailSender
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* assertPayLinkConfigured;

    const sent = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const { invoice, customer, company } = yield* readContext(
          tx,
          tenant.organizationId,
          invoiceId,
        );
        yield* lockInvoice(tx, tenant.organizationId, invoiceId);
        if (invoice.status !== "draft") {
          return yield* Effect.fail(onlyDraft("sent"));
        }
        if (invoice.totalCents <= 0n) {
          return yield* Effect.fail(
            new BadRequest({
              message:
                "An invoice needs a total above $0.00 before it is sent.",
            }),
          );
        }
        if (customer.archivedAt !== null) {
          return yield* Effect.fail(
            new BadRequest({
              message:
                "That customer is archived. Restore them or choose another customer first.",
            }),
          );
        }
        if (!(yield* companyWalletIsActive(tx, tenant.organizationId))) {
          return yield* Effect.fail(walletNotReady);
        }

        const now = new Date();
        const [updated] = yield* query(() =>
          tx
            .update(invoices)
            .set({
              status: "open",
              sentAt: now,
              lastEmailedAt: now,
              publicId: randomBytes(32).toString("base64url"),
              billTo: {
                name: customer.name,
                email: customer.email,
                address: customer.address,
                taxId: customer.taxId,
              },
              fromParty: { name: company.name, kraPin: company.kraPin },
            })
            .where(eq(invoices.id, invoiceId))
            .returning(),
        );
        if (!updated) return yield* Effect.dieMessage("invoice send no row");
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.sent",
          entity: { type: "invoice", id: invoiceId },
          before: { status: "draft" },
          after: {
            status: "open",
            number: updated.number,
            totalCents: updated.totalCents,
            customerId: customer.id,
          },
        });
        return updated;
      }),
    );

    // The invoice stands once it's sent; a failed email is retried with remind.
    yield* emailInvoice({
      invoice: sent,
      idempotencyKey: `invoice-${invoiceId}-sent`,
      reminder: false,
    }).pipe(
      Effect.catchAll((error) =>
        Effect.all([
          Effect.sync(() =>
            console.error(
              `[invoices] invoice ${invoiceId} was sent but its email failed: ${error.message}`,
            ),
          ),
          withScope(tenant, (tx) =>
            query(() =>
              tx
                .update(invoices)
                .set({ lastEmailedAt: null })
                .where(eq(invoices.id, invoiceId)),
            ),
          ),
        ]),
      ),
    );

    return yield* getInvoice(tenant, invoiceId);
  });
}

export function remindInvoice(
  tenant: Tenant,
  invoiceId: string,
): Effect.Effect<
  { readonly remindedAt: string },
  Conflict | NotFound | ServiceUnavailable | TooManyRequests | DatabaseError,
  DatabaseService | AuditLog | ConfigService | EmailSender
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    yield* assertPayLinkConfigured;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const invoice = yield* lockInvoice(
          tx,
          tenant.organizationId,
          invoiceId,
        );
        if (invoice.status !== "open") {
          return yield* Effect.fail(
            new Conflict({ message: "Only an open invoice can be reminded." }),
          );
        }
        const now = new Date();
        const last = invoice.lastEmailedAt;
        const waitMs =
          last === null
            ? 0
            : last.getTime() + REMINDER_INTERVAL_MS - now.getTime();
        if (waitMs > 0) {
          return yield* Effect.fail(
            new TooManyRequests({
              message: `The customer was emailed a moment ago. Try again in ${Math.ceil(waitMs / 60_000)} minutes.`,
            }),
          );
        }
        // The email goes inside the transaction so one that fails leaves no
        // reminder behind.
        yield* emailInvoice({
          invoice,
          idempotencyKey: `invoice-${invoiceId}-remind-${now.getTime()}`,
          reminder: true,
        });
        yield* query(() =>
          tx
            .update(invoices)
            .set({ lastEmailedAt: now })
            .where(eq(invoices.id, invoiceId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.reminded",
          entity: { type: "invoice", id: invoiceId },
          after: { to: invoice.billTo?.email ?? null },
        });
        return { remindedAt: now.toISOString() };
      }),
    );
  });
}

export function voidInvoice(
  tenant: Tenant,
  invoiceId: string,
  reason: string,
): Effect.Effect<
  Invoice,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const invoice = yield* lockInvoice(
          tx,
          tenant.organizationId,
          invoiceId,
        );
        if (invoice.status !== "open") {
          return yield* Effect.fail(
            new Conflict({
              message:
                invoice.status === "paid"
                  ? "A paid invoice can't be voided."
                  : invoice.status === "void"
                    ? "This invoice is already void."
                    : "A draft invoice can't be voided. Delete it instead.",
            }),
          );
        }
        yield* query(() =>
          tx
            .update(invoices)
            .set({
              status: "void",
              voidedAt: new Date(),
              voidedReason: reason,
              voidedBy: tenant.userId,
            })
            .where(eq(invoices.id, invoiceId)),
        );
        yield* audit.record(tx, {
          actor: userActor(tenant),
          organizationId: tenant.organizationId,
          action: "invoice.voided",
          entity: { type: "invoice", id: invoiceId },
          before: { status: "open" },
          after: { status: "void", reason },
        });
        return yield* readInvoice(tx, tenant.organizationId, invoiceId);
      }),
    );
  });
}

// ── Payments by hand ─────────────────────────────────────────────────────

export function markInvoicePaid(
  tenant: Tenant,
  invoiceId: string,
  input: InvoiceMarkPaidInput,
): Effect.Effect<
  Invoice,
  BadRequest | Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return Effect.gen(function* () {
    if (input.paidOn > nairobiDate(new Date())) {
      return yield* Effect.fail(
        new BadRequest({ message: "Choose today or an earlier date." }),
      );
    }
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const reference = blankToUndefined(input.reference);
        const note = blankToUndefined(input.note);
        yield* recordInvoicePayment(tx, {
          organizationId: tenant.organizationId,
          invoiceId,
          kind: "outside",
          paidOn: input.paidOn,
          ...(reference !== undefined && { reference }),
          ...(note !== undefined && { note }),
          actor: userActor(tenant),
        });
        return yield* readInvoice(tx, tenant.organizationId, invoiceId);
      }),
    );
  });
}

export function matchableDeposits(
  tenant: Tenant,
  invoiceId: string,
): Effect.Effect<
  { readonly deposits: MatchableDeposit[] },
  NotFound | DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      yield* lockFreeRead(tx, tenant.organizationId, invoiceId);
      return yield* query(() =>
        tx
          .select()
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.organizationId, tenant.organizationId),
              eq(walletTransactions.type, "deposit"),
              notExists(
                tx
                  .select({ id: invoicePayments.id })
                  .from(invoicePayments)
                  .where(
                    eq(
                      invoicePayments.walletTransactionId,
                      walletTransactions.id,
                    ),
                  ),
              ),
            ),
          )
          .orderBy(
            desc(walletTransactions.createdAt),
            desc(walletTransactions.id),
          )
          .limit(MAX_MATCHABLE_DEPOSITS),
      );
    }),
  ).pipe(
    Effect.map((rows) => ({
      deposits: rows.map((row) => ({
        walletTransactionId: row.id,
        amountUsdc: row.usdcAmount.toString(),
        receivedAt: row.createdAt.toISOString(),
        from: row.counterpartyAddress,
        txHash: row.txHash,
      })),
    })),
  );
}

function lockFreeRead(
  tx: Transaction,
  organizationId: string,
  invoiceId: string,
): Effect.Effect<void, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.id, invoiceId),
          eq(invoices.organizationId, organizationId),
        ),
      ),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.void : Effect.fail(invoiceNotFound),
    ),
  );
}

export function matchInvoiceDeposit(
  tenant: Tenant,
  invoiceId: string,
  walletTransactionId: string,
): Effect.Effect<
  Invoice,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      yield* lockFreeRead(tx, tenant.organizationId, invoiceId);
      const [deposit] = yield* query(() =>
        tx
          .select()
          .from(walletTransactions)
          .where(
            and(
              eq(walletTransactions.id, walletTransactionId),
              eq(walletTransactions.organizationId, tenant.organizationId),
              eq(walletTransactions.type, "deposit"),
            ),
          ),
      );
      if (!deposit) {
        return yield* Effect.fail(
          new NotFound({ message: "Deposit not found." }),
        );
      }
      yield* recordInvoicePayment(tx, {
        organizationId: tenant.organizationId,
        invoiceId,
        kind: "matched",
        walletTransactionId: deposit.id,
        amountUsdc: deposit.usdcAmount,
        paidOn: nairobiDate(deposit.createdAt),
        actor: userActor(tenant),
      });
      return yield* readInvoice(tx, tenant.organizationId, invoiceId);
    }),
  );
}

export function undoInvoicePayment(
  tenant: Tenant,
  invoiceId: string,
  paymentId: string,
): Effect.Effect<
  Invoice,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      yield* removeInvoicePayment(tx, {
        organizationId: tenant.organizationId,
        invoiceId,
        paymentId,
        actor: userActor(tenant),
      });
      return yield* readInvoice(tx, tenant.organizationId, invoiceId);
    }),
  );
}
