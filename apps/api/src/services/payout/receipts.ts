import { and, asc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CashOutReceipt,
  CashOutReceiptKind,
} from "@expendi-business/shared";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { payouts } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * The receipts customers see for what a cash-out paid (`paymentReceipts`).
 * `providerReference` holds whatever the payout's provider reported: the
 * M-Pesa or bank receipt for a cash-out, either provider, but a transaction
 * hash for a USDC payout, which is no receipt and never shown as one.
 */

export type PayoutReceiptFacts = Pick<
  Payout,
  "provider" | "method" | "status" | "providerReference"
>;

const RECEIPT_KINDS: Readonly<
  Record<Payout["method"], CashOutReceiptKind | null>
> = {
  mpesa_phone: "mpesa",
  mpesa_till: "mpesa",
  mpesa_paybill: "mpesa",
  bank: "bank",
  usdc: null,
};

/** A paid cash-out's receipt; null for anything else. */
export function cashOutReceiptOf(
  payout: PayoutReceiptFacts,
): CashOutReceipt | null {
  const kind = RECEIPT_KINDS[payout.method];
  const code = payout.providerReference;
  if (
    payout.provider === "onchain" ||
    kind === null ||
    payout.status !== "paid" ||
    code === null ||
    code === ""
  ) {
    return null;
  }
  return { kind, code };
}

/** The receipts among `payouts`, in the order given. */
export function cashOutReceiptsOf(
  payouts: readonly PayoutReceiptFacts[],
): CashOutReceipt[] {
  return payouts.flatMap((payout) => {
    const receipt = cashOutReceiptOf(payout);
    return receipt === null ? [] : [receipt];
  });
}

/**
 * Each subject's receipts, in one query for them all: its parts in order,
 * then oldest first. A subject with none is missing from the map. Runs in
 * the caller's transaction, so it sees only the payouts they may.
 */
export function paymentReceiptsBySubject(
  tx: Transaction,
  organizationId: string,
  subjectType: Payout["subjectType"],
  subjectIds: readonly string[],
): Effect.Effect<ReadonlyMap<string, CashOutReceipt[]>, DatabaseError> {
  if (subjectIds.length === 0) return Effect.succeed(new Map());
  return query(() =>
    tx
      .select({
        subjectId: payouts.subjectId,
        provider: payouts.provider,
        method: payouts.method,
        status: payouts.status,
        providerReference: payouts.providerReference,
      })
      .from(payouts)
      .where(
        and(
          eq(payouts.organizationId, organizationId),
          eq(payouts.subjectType, subjectType),
          inArray(payouts.subjectId, [...new Set(subjectIds)]),
        ),
      )
      .orderBy(
        asc(payouts.subjectPart),
        asc(payouts.createdAt),
        asc(payouts.id),
      ),
  ).pipe(
    Effect.map((rows) => {
      const bySubject = new Map<string, CashOutReceipt[]>();
      for (const row of rows) {
        const receipt = cashOutReceiptOf(row);
        if (receipt === null) continue;
        const receipts = bySubject.get(row.subjectId) ?? [];
        receipts.push(receipt);
        bySubject.set(row.subjectId, receipts);
      }
      return bySubject;
    }),
  );
}
