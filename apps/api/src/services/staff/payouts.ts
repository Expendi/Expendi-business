import { eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { PayoutStatus } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { BadRequest, DatabaseError } from "../../errors.js";
import type { AuditEntryView } from "./audit-search.js";
import type { LedgerRow } from "./payout-evidence.js";
import type { StaffMember } from "./staff-auth.js";
import { organizations, payouts, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound, ServiceUnavailable } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { syncPayoutOrder } from "../payout/sync.js";
import { describeRecipient } from "../wallet/history.js";
import { searchAuditLog } from "./audit-search.js";
import { decodeCursor, encodeCursor, isoUtc, UUID } from "./paging.js";
import { payoutLedger } from "./payout-evidence.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The payout queue (spec §6.15): what needs review or has failed, from
 * every company. Reads go through `staff_payout_queue` and, for one payout,
 * that payout's company scope in a read-only transaction.
 */

export interface StaffPayoutSummaryView {
  readonly id: string;
  readonly organization: { readonly id: string; readonly name: string };
  readonly subjectType: Payout["subjectType"];
  readonly subjectId: string;
  readonly payrollRunId: string | null;
  readonly provider: Payout["provider"];
  readonly method: Payout["method"];
  readonly status: PayoutStatus;
  readonly amountKesCents: bigint;
  readonly amountToTransferUsdc: bigint | null;
  readonly providerOrderId: string | null;
  readonly depositAddress: string | null;
  readonly txHash: string | null;
  readonly providerReference: string | null;
  readonly providerStatus: string | null;
  readonly providerCheckedAt: string | null;
  readonly failureReason: string | null;
  readonly fundingStartedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const iso = (date: Date | null): string | null => date?.toISOString() ?? null;

/** A payout row as staff see it in lists. */
export function payoutSummary(
  payout: Payout,
  organizationName: string,
): StaffPayoutSummaryView {
  return {
    id: payout.id,
    organization: { id: payout.organizationId, name: organizationName },
    subjectType: payout.subjectType,
    subjectId: payout.subjectId,
    payrollRunId: payout.payrollRunId,
    provider: payout.provider,
    method: payout.method,
    status: payout.status,
    amountKesCents: payout.amountKes,
    amountToTransferUsdc: payout.amountToTransferUsdc,
    providerOrderId: payout.providerOrderId,
    depositAddress: payout.depositAddress,
    txHash: payout.txHash,
    providerReference: payout.providerReference,
    providerStatus: payout.providerStatus,
    providerCheckedAt: iso(payout.providerCheckedAt),
    failureReason: payout.failureReason,
    fundingStartedAt: iso(payout.fundingStartedAt),
    createdAt: payout.createdAt.toISOString(),
    updatedAt: payout.updatedAt.toISOString(),
  };
}

interface QueueRow extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
  readonly organization_name: string;
  readonly subject_type: Payout["subjectType"];
  readonly subject_id: string;
  readonly payroll_run_id: string | null;
  readonly provider: Payout["provider"];
  readonly method: Payout["method"];
  readonly status: PayoutStatus;
  readonly amount_kes: string;
  readonly amount_to_transfer_usdc: string | null;
  readonly provider_order_id: string | null;
  readonly deposit_address: string | null;
  readonly tx_hash: string | null;
  readonly provider_reference: string | null;
  readonly provider_status: string | null;
  readonly provider_checked_at: string | null;
  readonly failure_reason: string | null;
  readonly funding_started_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

function fromQueueRow(row: QueueRow): StaffPayoutSummaryView {
  return {
    id: row.payout_id,
    organization: { id: row.organization_id, name: row.organization_name },
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payrollRunId: row.payroll_run_id,
    provider: row.provider,
    method: row.method,
    status: row.status,
    amountKesCents: BigInt(row.amount_kes),
    amountToTransferUsdc:
      row.amount_to_transfer_usdc === null
        ? null
        : BigInt(row.amount_to_transfer_usdc),
    providerOrderId: row.provider_order_id,
    depositAddress: row.deposit_address,
    txHash: row.tx_hash,
    providerReference: row.provider_reference,
    providerStatus: row.provider_status,
    providerCheckedAt: row.provider_checked_at,
    failureReason: row.failure_reason,
    fundingStartedAt: row.funding_started_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface PayoutQueuePage {
  readonly payouts: StaffPayoutSummaryView[];
  readonly nextCursor: string | null;
}

/** Newest first, from every company unless one is given. */
export function payoutQueue(input: {
  readonly status?: "needs_review" | "failed" | undefined;
  readonly companyId?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit: number;
}): Effect.Effect<
  PayoutQueuePage,
  BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const cursor = input.cursor ? yield* decodeCursor(input.cursor) : null;
    const statuses = input.status ? [input.status] : ["needs_review", "failed"];
    return yield* withStaffReadScope({}, (tx) =>
      query(() =>
        tx.execute<QueueRow>(sql`
          SELECT q.payout_id, q.organization_id, q.organization_name,
                 q.subject_type, q.subject_id, q.payroll_run_id, q.provider,
                 q.method, q.status, q.amount_kes::text AS amount_kes,
                 q.amount_to_transfer_usdc::text AS amount_to_transfer_usdc,
                 q.provider_order_id, q.deposit_address, q.tx_hash,
                 q.provider_reference, q.provider_status,
                 ${isoUtc(sql`q.provider_checked_at`)} AS provider_checked_at,
                 q.failure_reason,
                 ${isoUtc(sql`q.funding_started_at`)} AS funding_started_at,
                 ${isoUtc(sql`q.created_at`)} AS created_at,
                 ${isoUtc(sql`q.updated_at`)} AS updated_at
          FROM staff_payout_queue(
            ARRAY[${sql.join(
              statuses.map((status) => sql`${status}`),
              sql`, `,
            )}]::payout_status[],
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
          payouts: page.map(fromQueueRow),
          nextCursor:
            rows.length > input.limit && last
              ? encodeCursor({ at: last.created_at, id: last.payout_id })
              : null,
        };
      }),
    );
  });
}

const noSuchPayout = new NotFound({ message: "No payout with this ID" });

/** The company a payout belongs to, so it can be read in that scope. */
export function payoutOrganization(
  payoutId: string,
): Effect.Effect<string, NotFound | DatabaseError, DatabaseService> {
  if (!UUID.test(payoutId)) return Effect.fail(noSuchPayout);
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<{ organization_id: string | null }>(
        sql`SELECT organization_of_payout(${payoutId}::uuid) AS organization_id`,
      ),
    ),
  ).pipe(
    Effect.flatMap(({ rows: [row] }) =>
      row?.organization_id
        ? Effect.succeed(row.organization_id)
        : Effect.fail(noSuchPayout),
    ),
  );
}

export interface ScopedPayout {
  readonly payout: Payout;
  readonly organizationName: string;
  readonly walletAddress: string | null;
}

/** The payout with its company's name and wallet, read in its company scope. */
export function readScopedPayout(
  organizationId: string,
  payoutId: string,
): Effect.Effect<ScopedPayout, NotFound | DatabaseError, DatabaseService> {
  return withStaffReadScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          payout: payouts,
          organizationName: organizations.name,
          walletAddress: wallets.address,
        })
        .from(payouts)
        .innerJoin(organizations, eq(organizations.id, payouts.organizationId))
        .innerJoin(wallets, eq(wallets.id, payouts.walletId))
        .where(eq(payouts.id, payoutId)),
    ),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(noSuchPayout),
    ),
  );
}

export interface StaffPayoutDetailView extends StaffPayoutSummaryView {
  readonly recipient: { readonly name: string; readonly detail: string };
  readonly quotedUsdc: bigint;
  readonly maxDebitUsdc: bigint;
  readonly rate: string | null;
  readonly depositValidUntil: string | null;
  readonly privyTransactionId: string | null;
  readonly gatewayOrderId: string | null;
  readonly approvedAt: string | null;
  readonly paidAt: string | null;
  readonly walletAddress: string | null;
  readonly ledger: readonly LedgerEntryView[];
  readonly auditTrail: readonly AuditEntryView[];
}

export interface LedgerEntryView {
  readonly id: string;
  readonly type: LedgerRow["type"];
  readonly usdcAmount: bigint;
  readonly txHash: string | null;
  readonly createdAt: string;
}

export function ledgerView(row: LedgerRow): LedgerEntryView {
  return {
    id: row.id,
    type: row.type,
    usdcAmount: row.usdcAmount,
    txHash: row.txHash,
    createdAt: row.createdAt.toISOString(),
  };
}

/** One payout, everything ops need to check it, and its audit trail. */
export function payoutDetail(
  payoutId: string,
): Effect.Effect<
  StaffPayoutDetailView,
  NotFound | BadRequest | DatabaseError,
  DatabaseService
> {
  return Effect.gen(function* () {
    const organizationId = yield* payoutOrganization(payoutId);
    const { payout, organizationName, walletAddress } = yield* readScopedPayout(
      organizationId,
      payoutId,
    );
    const ledger = yield* withStaffReadScope({ organizationId }, (tx) =>
      payoutLedger(tx, payoutId),
    );
    const trail = yield* searchAuditLog({
      entityType: "payout",
      entityId: payoutId,
      limit: 50,
    });
    return {
      ...payoutSummary(payout, organizationName),
      recipient: {
        name: payout.recipient.accountName,
        detail: describeRecipient(payout.recipient),
      },
      quotedUsdc: payout.quotedUsdc,
      maxDebitUsdc: payout.maxDebitUsdc,
      rate: payout.rate,
      depositValidUntil: iso(payout.depositValidUntil),
      privyTransactionId: payout.privyTransactionId,
      gatewayOrderId: payout.gatewayOrderId,
      approvedAt: iso(payout.approvedAt),
      paidAt: iso(payout.paidAt),
      walletAddress,
      ledger: [...ledger.debits, ...ledger.refunds].map(ledgerView),
      auditTrail: trail.entries,
    };
  });
}

export interface RefetchResult {
  readonly previousStatus: PayoutStatus;
  readonly status: PayoutStatus;
  readonly paycrestStatus: string;
}

/**
 * Fetches the payout's order from Paycrest and runs the ordinary sync on
 * it (spec §6.15): forward-only, and it never orders or sends. Audited as
 * the staff member.
 */
export function refetchPayout(
  staff: StaffMember,
  payoutId: string,
): Effect.Effect<
  RefetchResult,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | AuditLog | Paycrest
> {
  return Effect.gen(function* () {
    const organizationId = yield* payoutOrganization(payoutId);
    const { payout: before } = yield* readScopedPayout(
      organizationId,
      payoutId,
    );
    const orderId = before.providerOrderId;
    if (before.provider !== "paycrest" || !orderId) {
      return yield* Effect.fail(
        new Conflict({
          message: "This payout has no Paycrest order to re-fetch.",
        }),
      );
    }
    const paycrest = yield* Paycrest;
    const order = yield* paycrest.getOrder(orderId).pipe(
      Effect.mapError(
        (error) =>
          new ServiceUnavailable({
            message: `Paycrest didn't return the order (${error.code}). Nothing was changed; try again shortly.`,
          }),
      ),
    );
    const outcome = yield* syncPayoutOrder({
      organizationId,
      payoutId,
      order,
      source: "staff",
      touch: true,
    });
    const status = outcome.changed ? outcome.to : before.status;
    yield* withScope({ organizationId }, (tx) =>
      Effect.flatMap(AuditLog, (audit) =>
        audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: "payout.refetched",
          entity: { type: "payout", id: payoutId },
          before: {
            status: before.status,
            providerStatus: before.providerStatus,
          },
          after: {
            status,
            paycrestStatus: order.status,
            changed: outcome.changed,
          },
        }),
      ),
    );
    return {
      previousStatus: before.status,
      status,
      paycrestStatus: order.status,
    };
  });
}
