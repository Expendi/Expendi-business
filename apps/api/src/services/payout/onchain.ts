import { and, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import { payouts, wallets, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { AuditLog } from "../audit/audit-log.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { isPaused, lockPayout } from "./guards.js";
import { FUNDING_STUCK_MS } from "./sync.js";

/**
 * USDC payees (spec §6.19) and withdrawals (§6.9): a direct transfer from
 * the company wallet to an address on its allowlist (`provider = onchain`).
 * No Paycrest: the payout is exactly the approved USDC, and Expendi pays
 * the gas.
 */

const ENGINE = { type: "system", id: "payout-engine" } as const;
const CONFIRMER = { type: "system", id: "onchain-confirm" } as const;

type OnchainDeps = DatabaseService | AuditLog | PrivyWallets;

/**
 * Funds an approved USDC payout exactly once. Under the payout's row lock it
 * re-checks the pauses and that the address is still on the allowlist, then
 * records that funding started, then sends once with a stable idempotency
 * key. A refusal ends `failed` with nothing sent; an unknown outcome ends
 * `needs_review`, never re-sent.
 */
export function fundOnchainPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, OnchainDeps> {
  const { organizationId, payoutId } = input;
  const scope = { organizationId };

  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const privy = yield* PrivyWallets;

    const settle = (
      from: Payout["status"],
      changes: Partial<typeof payouts.$inferInsert>,
      action: string,
      after: Record<string, unknown>,
    ) =>
      withScope(scope, (tx) =>
        Effect.gen(function* () {
          const [updated] = yield* query(() =>
            tx
              .update(payouts)
              .set(changes)
              .where(and(eq(payouts.id, payoutId), eq(payouts.status, from)))
              .returning(),
          );
          if (!updated) {
            return yield* Effect.dieMessage(
              `payout ${payoutId} left ${from} unexpectedly`,
            );
          }
          yield* audit.record(tx, {
            actor: ENGINE,
            organizationId,
            action,
            entity: { type: "payout", id: payoutId },
            after: { status: updated.status, ...after },
          });
          return updated;
        }),
      );

    const barrier = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const payout = yield* lockPayout(tx, payoutId);
        if (
          payout?.status !== "approved" ||
          payout.fundingStartedAt ||
          payout.recipient.method !== "usdc"
        ) {
          return { kind: "not_ready" } as const;
        }
        if (yield* isPaused(tx, organizationId)) {
          return {
            kind: "fail",
            reason: "Payouts were paused. Nothing was sent.",
          } as const;
        }
        const address = payout.recipient.address;
        if (!(yield* isAllowlisted(tx, organizationId, address))) {
          return {
            kind: "fail",
            reason:
              "The address was removed from the allowlist. Nothing was sent.",
          } as const;
        }
        const [wallet] = yield* query(() =>
          tx
            .select({ privyWalletId: wallets.privyWalletId })
            .from(wallets)
            .where(eq(wallets.id, payout.walletId)),
        );
        if (!wallet?.privyWalletId) {
          return {
            kind: "fail",
            reason: "The company wallet isn't active.",
          } as const;
        }
        yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: "funding",
              fundingStartedAt: new Date(),
              depositAddress: address,
              amountToTransferUsdc: payout.quotedUsdc,
            })
            .where(eq(payouts.id, payoutId)),
        );
        yield* audit.record(tx, {
          actor: ENGINE,
          organizationId,
          action: "payout.funding_started",
          entity: { type: "payout", id: payoutId },
          after: { to: address, amount: payout.quotedUsdc },
        });
        return {
          kind: "send",
          privyWalletId: wallet.privyWalletId,
          address,
          amount: payout.quotedUsdc,
          walletId: payout.walletId,
          ledgerType:
            payout.subjectType === "withdrawal" ? "withdrawal" : "payout",
        } as const;
      }),
    );
    if (barrier.kind === "not_ready") {
      return yield* Effect.dieMessage(
        `payout ${payoutId} is not ready to fund`,
      );
    }
    if (barrier.kind === "fail") {
      return yield* settle(
        "approved",
        { status: "failed", failureReason: barrier.reason },
        "payout.failed",
        { reason: barrier.reason },
      );
    }

    const sent = yield* privy
      .sendUsdc({
        privyWalletId: barrier.privyWalletId,
        to: barrier.address,
        amount: barrier.amount,
        idempotencyKey: `payout-${payoutId}`,
      })
      .pipe(Effect.either);
    if (sent._tag === "Left") {
      const failure = sent.left;
      const refused = failure._tag === "SendRefused";
      const reason =
        failure._tag === "SendRefused"
          ? `The wallet refused the transfer${failure.policyViolation ? " (blocked by its policy)" : ""}. Nothing was sent.`
          : "The transfer's outcome is unknown. Check the chain before doing anything; never send again.";
      return yield* settle(
        "funding",
        { status: refused ? "failed" : "needs_review", failureReason: reason },
        refused ? "payout.failed" : "payout.needs_review",
        { reason },
      );
    }

    return yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const [paying] = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: "paying",
              txHash: sent.right.txHash,
              privyTransactionId: sent.right.privyTransactionId,
            })
            .where(and(eq(payouts.id, payoutId), eq(payouts.status, "funding")))
            .returning(),
        );
        if (!paying) {
          return yield* Effect.dieMessage(
            `payout ${payoutId} left funding unexpectedly`,
          );
        }
        yield* query(() =>
          tx.insert(walletTransactions).values({
            organizationId,
            walletId: barrier.walletId,
            type: barrier.ledgerType,
            usdcAmount: -barrier.amount,
            txHash: sent.right.txHash,
            counterpartyAddress: barrier.address,
            payoutId,
          }),
        );
        yield* audit.record(tx, {
          actor: ENGINE,
          organizationId,
          action: "payout.funded",
          entity: { type: "payout", id: payoutId },
          after: {
            status: paying.status,
            txHash: sent.right.txHash,
            privyTransactionId: sent.right.privyTransactionId,
            amount: barrier.amount,
          },
        });
        return paying;
      }),
    );
  });
}

interface PayoutRef extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
}

interface Confirmation {
  readonly status: "paid" | "needs_review";
  readonly action: string;
  readonly reason?: string;
}

/**
 * What the chain says about a sent USDC payout: paid when its transaction
 * succeeded and moved exactly the amount to exactly the address; anything
 * else is for a person. Null while there's nothing to decide yet.
 */
function confirmationFor(
  payout: Payout,
  walletAddress: string,
  receipt: Parameters<typeof usdcTransfersIn>[0] | null,
  now: number,
): Confirmation | null {
  const stuck =
    payout.fundingStartedAt !== null &&
    now - payout.fundingStartedAt.getTime() > FUNDING_STUCK_MS;
  if (payout.status === "funding" || !payout.txHash) {
    return stuck
      ? {
          status: "needs_review",
          action: "payout.needs_review",
          reason: `The transfer has no confirmed hash${payout.privyTransactionId ? ` (Privy transaction ${payout.privyTransactionId})` : ""}. Check the chain before doing anything.`,
        }
      : null;
  }
  if (!receipt) return null;
  const moved = usdcTransfersIn(receipt).some(
    (transfer) =>
      transfer.from === walletAddress.toLowerCase() &&
      transfer.to === payout.depositAddress?.toLowerCase() &&
      transfer.amount === payout.amountToTransferUsdc,
  );
  return moved
    ? { status: "paid", action: "payout.paid" }
    : {
        status: "needs_review",
        action: "payout.needs_review",
        reason:
          receipt.status === "0x1"
            ? "The transaction didn't move the expected USDC."
            : "The transfer reverted on chain, but the ledger shows it as sent.",
      };
}

export interface ConfirmSummary {
  readonly checked: number;
  readonly confirmed: number;
  readonly errors: number;
}

/**
 * The minute job for USDC payouts: reads receipts and updates records. It
 * never sends.
 */
export function confirmOnchainPayouts(
  maxRows = 50,
): Effect.Effect<
  ConfirmSummary,
  DatabaseError,
  DatabaseService | AuditLog | BaseRpc
> {
  return Effect.gen(function* () {
    const rpc = yield* BaseRpc;
    const audit = yield* AuditLog;
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM onchain_payouts_to_confirm(${maxRows})`,
        ),
      ),
    );

    let confirmed = 0;
    let errors = 0;
    for (const ref of rows) {
      const scope = { organizationId: ref.organization_id };
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const [row] = yield* withScope(scope, (tx) =>
            query(() =>
              tx
                .select({ payout: payouts, walletAddress: wallets.address })
                .from(payouts)
                .innerJoin(wallets, eq(wallets.id, payouts.walletId))
                .where(eq(payouts.id, ref.payout_id)),
            ),
          );
          if (!row?.walletAddress) return false;
          const { payout, walletAddress } = row;
          const receipt = payout.txHash
            ? yield* rpc.getTransactionReceipt(payout.txHash)
            : null;
          const now = Date.now();
          const confirmation = confirmationFor(
            payout,
            walletAddress,
            receipt,
            now,
          );

          return yield* withScope(scope, (tx) =>
            Effect.gen(function* () {
              if (!confirmation) {
                yield* query(() =>
                  tx
                    .update(payouts)
                    .set({ providerCheckedAt: new Date(now) })
                    .where(eq(payouts.id, payout.id)),
                );
                return false;
              }
              const [updated] = yield* query(() =>
                tx
                  .update(payouts)
                  .set({
                    status: confirmation.status,
                    providerCheckedAt: new Date(now),
                    ...(confirmation.reason && {
                      failureReason: confirmation.reason,
                    }),
                    ...(confirmation.status === "paid" && {
                      paidAt: new Date(now),
                      providerReference: payout.txHash,
                    }),
                  })
                  .where(
                    and(
                      eq(payouts.id, payout.id),
                      eq(payouts.status, payout.status),
                    ),
                  )
                  .returning({ id: payouts.id }),
              );
              if (!updated) return false;
              yield* audit.record(tx, {
                actor: CONFIRMER,
                organizationId: ref.organization_id,
                action: confirmation.action,
                entity: { type: "payout", id: payout.id },
                before: { status: payout.status },
                after: {
                  status: confirmation.status,
                  txHash: payout.txHash,
                  ...(confirmation.reason && { reason: confirmation.reason }),
                },
              });
              return true;
            }),
          );
        }),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value) confirmed += 1;
      } else {
        errors += 1;
        console.error(
          `[confirm-onchain] payout ${ref.payout_id} failed to confirm`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { checked: rows.length, confirmed, errors };
  });
}
