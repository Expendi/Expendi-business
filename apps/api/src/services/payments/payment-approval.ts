import { and, count, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { PaymentDestination } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError, NotFound } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { AuditActor, AuditLog } from "../audit/audit-log.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import { payouts, wallets, webauthnChallenges } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict } from "../../errors.js";
import {
  ceilDiv,
  roundUpToWholeShilling,
  toMicro,
} from "../paycrest/amounts.js";
import { discardUnapprovedPayout } from "../payout/discard.js";
import { livePayoutOf } from "../payout/prepare.js";
import { availableUsdc } from "../wallet/ledger.js";

/**
 * The steps every Approve & pay shares, whatever it pays (claims, bills,
 * payroll runs): one payout awaiting approval per subject, the cost the
 * admin confirms, whether the wallet covers it, and the payouts a passkey
 * challenge was issued for. The payout engine does the rest.
 */

/** USDC base units × a rate in micro-units, back to whole units. */
const MICRO_SQUARED = 1_000_000n * 1_000_000n;

/** The highest quoted rate in the batch, so a top-up is never understated. */
export function highestRate(batch: readonly Payout[]): string {
  return batch.reduce(
    (highest, payout) =>
      toMicro(payout.quotedRate) > toMicro(highest)
        ? payout.quotedRate
        : highest,
    batch[0]?.quotedRate ?? "0",
  );
}

/** KES to top up for `shortfallUsdc` at `rate`: rounded up to a whole shilling, in cents. */
export function topUpKesFor(shortfallUsdc: bigint, rate: string): bigint {
  return roundUpToWholeShilling(
    ceilDiv(shortfallUsdc * toMicro(rate) * 100n, MICRO_SQUARED),
  );
}

/** What one payout costs the wallet, as the admin confirms it (spec §6.7 step 2). */
export interface PaymentCost {
  readonly rate: string;
  readonly usdc: bigint;
  readonly feeAllowanceUsdc: bigint;
  readonly maxDebitUsdc: bigint;
}

export function costOf(payout: Payout): PaymentCost {
  return {
    rate: payout.quotedRate,
    usdc: payout.quotedUsdc,
    feeAllowanceUsdc: payout.maxDebitUsdc - payout.quotedUsdc,
    maxDebitUsdc: payout.maxDebitUsdc,
  };
}

/** Where a payment goes, as the admin recognises it, without repeating every digit. */
export function destinationOf(recipient: PayoutRecipient): PaymentDestination {
  switch (recipient.method) {
    case "mpesa_phone":
      return {
        method: recipient.method,
        label: `M-Pesa ending ${recipient.phone.slice(-4)}`,
      };
    case "mpesa_till":
      return {
        method: recipient.method,
        label: `Till ${recipient.tillNumber}`,
      };
    case "mpesa_paybill":
      return {
        method: recipient.method,
        label: `Paybill ${recipient.paybillNumber}, account ${recipient.accountReference}`,
      };
    case "bank":
      return {
        method: recipient.method,
        label: `Bank account ending ${recipient.accountNumber.slice(-4)}`,
      };
    case "usdc":
      return {
        method: recipient.method,
        label: `${recipient.address.slice(0, 6)}…${recipient.address.slice(-4)}`,
      };
  }
}

export interface WalletCover {
  readonly availableUsdc: bigint;
  readonly shortfallUsdc: bigint;
  /** "Top up KES X" (spec §6.7 step 4); null when the wallet covers it. */
  readonly topUpKes: bigint | null;
}

/**
 * Whether the wallet's free USDC covers the batch's most debit, for the
 * preview; approving checks again under the wallet's lock.
 */
export function walletCover(
  organizationId: string,
  batch: readonly Payout[],
): Effect.Effect<WalletCover, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [wallet] = yield* query(() =>
        tx
          .select({ id: wallets.id })
          .from(wallets)
          .where(
            and(
              eq(wallets.organizationId, organizationId),
              eq(wallets.status, "active"),
            ),
          ),
      );
      const free = wallet ? yield* availableUsdc(tx, wallet.id) : 0n;
      const available = free > 0n ? free : 0n;
      const needed = batch.reduce(
        (sum, payout) => sum + payout.maxDebitUsdc,
        0n,
      );
      const shortfall = needed > available ? needed - available : 0n;
      return {
        availableUsdc: available,
        shortfallUsdc: shortfall,
        topUpKes:
          shortfall > 0n ? topUpKesFor(shortfall, highestRate(batch)) : null,
      };
    }),
  );
}

/** "Top up KES X" (spec §6.7 step 4), at the batch's quoted rate. */
export function topUpConflict(
  error: PayoutRejected,
  batch: readonly Payout[],
): Effect.Effect<never, PayoutRejected | Conflict> {
  if (error.reason !== "insufficient_balance" || !error.shortfallUsdc) {
    return Effect.fail(error);
  }
  const topUpKes = topUpKesFor(error.shortfallUsdc, highestRate(batch));
  const shillings = (topUpKes / 100n).toLocaleString("en-KE");
  return Effect.fail(
    new Conflict({
      message: `The wallet is too short to pay this. Top up KES ${shillings}, then approve again. Nothing was sent.`,
      details: {
        shortfallUsdc: error.shortfallUsdc.toString(),
        topUpKes: topUpKes.toString(),
      },
    }),
  );
}

/**
 * The payouts this admin's payout-approval challenge was issued for, as
 * they are now. Which subjects they may pay is the caller's to check.
 */
export function challengePayouts(
  tenant: Tenant,
  challengeId: string,
  notFound: NotFound,
): Effect.Effect<Payout[], NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [challenge] = yield* query(() =>
        tx
          .select({ payoutIds: webauthnChallenges.payoutIds })
          .from(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.id, challengeId),
              eq(webauthnChallenges.userId, tenant.userId),
              eq(webauthnChallenges.organizationId, tenant.organizationId),
              eq(webauthnChallenges.purpose, "approve_payouts"),
            ),
          ),
      );
      const payoutIds = challenge?.payoutIds ?? [];
      if (payoutIds.length === 0) return yield* Effect.fail(notFound);
      const batch = yield* query(() =>
        tx
          .select()
          .from(payouts)
          .where(
            and(
              inArray(payouts.id, payoutIds),
              eq(payouts.organizationId, tenant.organizationId),
            ),
          ),
      );
      if (batch.length !== payoutIds.length) {
        return yield* Effect.fail(notFound);
      }
      return batch;
    }),
  );
}

/** How many payouts of the subject have failed: the attempt number before the next one. */
export function failedPayouts(
  organizationId: string,
  subjectType: Payout["subjectType"],
  subjectId: string,
): Effect.Effect<number, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select({ failed: count() })
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            eq(payouts.subjectType, subjectType),
            eq(payouts.subjectId, subjectId),
            eq(payouts.status, "failed"),
          ),
        ),
    ),
  ).pipe(Effect.map(([row]) => row?.failed ?? 0));
}

/**
 * The subject's payout awaiting approval: the same one again if it still
 * pays exactly what `pays` expects, otherwise a new one. A stale one is
 * discarded first (nothing was sent), so a subject never has more than one
 * payout waiting. The new one's idempotency key is `<keyPrefix>:<id>:<n>`,
 * where n is one more than the subject's failed payouts, so preparing
 * again returns the same payout and only a failure moves the key on.
 */
export function awaitingPayoutFor<E, R>(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
  readonly subjectType: Payout["subjectType"];
  readonly subjectId: string;
  readonly keyPrefix: string;
  readonly pays: (payout: Payout) => boolean;
  /** Why a stale payout was discarded, for the audit log. */
  readonly replaced: string;
  /** Shown when the subject is already being paid. */
  readonly alreadyPaying: string;
  readonly prepare: (idempotencyKey: string) => Effect.Effect<Payout, E, R>;
}): Effect.Effect<
  Payout,
  E | Conflict | DatabaseError,
  R | DatabaseService | AuditLog
> {
  const { organizationId, subjectType, subjectId } = input;
  return Effect.gen(function* () {
    const live = yield* livePayoutOf(organizationId, subjectType, subjectId);
    if (live) {
      if (live.status !== "awaiting_approval") {
        return yield* Effect.fail(
          new Conflict({ message: input.alreadyPaying }),
        );
      }
      if (input.pays(live)) return live;
      yield* withScope({ organizationId }, (tx) =>
        discardUnapprovedPayout(tx, {
          organizationId,
          payoutId: live.id,
          reason: input.replaced,
          actor: input.actor,
        }),
      );
    }
    const failed = yield* failedPayouts(organizationId, subjectType, subjectId);
    return yield* input.prepare(
      `${input.keyPrefix}:${subjectId}:${failed + 1}`,
    );
  });
}
