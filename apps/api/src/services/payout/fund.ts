import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { PaycrestOrder } from "../paycrest/paycrest-client.js";
import type { KesPayoutQuote } from "../paycrest/quote.js";
import { payouts, wallets, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { toMicro } from "../paycrest/amounts.js";
import { buildOrderRequest } from "../paycrest/order-request.js";
import { checkOrder } from "../paycrest/order-safety.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { quoteKesPayout } from "../paycrest/quote.js";
import { toPaycrestRecipient } from "../paycrest/recipient.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { isPaused, lockPayout } from "./guards.js";
import { fundOnchainPayout } from "./onchain.js";
import { PAYOUT_MEMO } from "./prepare.js";

const ACTOR = { type: "system", id: "payout-engine" } as const;

type FundDeps = DatabaseService | AuditLog | Paycrest | PrivyWallets;

interface FundingWallet {
  readonly address: string;
  readonly privyWalletId: string;
}

/**
 * Funds one approved payout, exactly once (spec §6.7, §6.8), following the
 * consumer backend's Qadi safeguards:
 *
 * 1. quote again for the approved KES amount;
 * 2. under the payout's row lock, record that an order is being requested,
 *    so a crash mid-request can never lead to a second order;
 * 3. create the Paycrest order (reference = payout ID) and save it before
 *    looking at it;
 * 4. check it with `checkOrder`;
 * 5. under the lock again, re-check it and record that funding started;
 * 6. send exactly `amountToTransfer` to the order's deposit address.
 *
 * A definite failure before step 6 ends `failed` with nothing sent. Any
 * unclear outcome ends `needs_review`: a person resolves it against
 * Paycrest and the chain, and nothing is ever re-sent automatically.
 * Payouts are funded one by one, so one failing never affects another.
 */
function fundPaycrestPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, FundDeps> {
  const { organizationId, payoutId } = input;
  const scope = { organizationId };

  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const paycrest = yield* Paycrest;
    const privy = yield* PrivyWallets;

    const transition = (
      changes: Partial<typeof payouts.$inferInsert>,
      action: string,
      after: Record<string, unknown>,
      from: Payout["status"],
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
            actor: ACTOR,
            organizationId,
            action,
            entity: { type: "payout", id: payoutId },
            after: { status: updated.status, ...after },
          });
          return updated;
        }),
      );

    const fail = (from: Payout["status"], reason: string) =>
      transition(
        { status: "failed", failureReason: reason },
        "payout.failed",
        { reason },
        from,
      );

    const review = (from: Payout["status"], reason: string) =>
      transition(
        { status: "needs_review", failureReason: reason },
        "payout.needs_review",
        { reason },
        from,
      );

    const current = yield* withScope(scope, (tx) =>
      query(() => tx.select().from(payouts).where(eq(payouts.id, payoutId))),
    ).pipe(Effect.map(([payout]) => payout));
    if (current?.status !== "approved" || current.orderRequestedAt) {
      return yield* Effect.dieMessage(
        `payout ${payoutId} is not ready to fund (${current?.status ?? "missing"})`,
      );
    }
    const payout = current;

    const [wallet] = yield* withScope(scope, (tx) =>
      query(() =>
        tx
          .select({
            address: wallets.address,
            privyWalletId: wallets.privyWalletId,
          })
          .from(wallets)
          .where(eq(wallets.id, payout.walletId)),
      ),
    );
    if (!wallet?.address || !wallet.privyWalletId) {
      return yield* fail("approved", "The company wallet isn't active.");
    }
    const funding: FundingWallet = {
      address: wallet.address,
      privyWalletId: wallet.privyWalletId,
    };

    // 1. A fresh quote for the KES the admin approved.
    const quoted = yield* quoteKesPayout(payout.amountKes).pipe(Effect.either);
    if (quoted._tag === "Left") {
      return yield* fail(
        "approved",
        `Couldn't get a Paycrest quote: ${quoted.left.message}`,
      );
    }
    const quote: KesPayoutQuote = quoted.right;
    if (quote.usdcAmount > payout.maxDebitUsdc) {
      return yield* fail(
        "approved",
        "The rate moved past what was approved. Approve again at the new rate.",
      );
    }

    // 2. Claim the right to request an order, once.
    const claimed = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const locked = yield* lockPayout(tx, payoutId);
        if (locked?.status !== "approved" || locked.orderRequestedAt) {
          return "taken" as const;
        }
        if (yield* isPaused(tx, organizationId)) return "paused" as const;
        yield* query(() =>
          tx
            .update(payouts)
            .set({ orderRequestedAt: new Date() })
            .where(eq(payouts.id, payoutId)),
        );
        return "claimed" as const;
      }),
    );
    if (claimed === "taken") {
      return yield* Effect.dieMessage(`payout ${payoutId} is already funding`);
    }
    if (claimed === "paused") {
      return yield* fail("approved", "Payouts were paused. Nothing was sent.");
    }

    // 3. The order. Its reference is the payout ID.
    if (payout.recipient.method === "usdc") {
      return yield* Effect.dieMessage(
        `payout ${payoutId} is a USDC transfer, not a Paycrest payout`,
      );
    }
    const recipient = toPaycrestRecipient(payout.recipient, PAYOUT_MEMO);
    const created = yield* paycrest
      .createOrder(
        buildOrderRequest({
          quote,
          recipient,
          reference: payout.id,
          refundAddress: funding.address,
        }),
      )
      .pipe(Effect.either);
    if (created._tag === "Left") {
      return yield* created.left.ambiguous
        ? review(
            "approved",
            `Paycrest may have created an order (${created.left.code}). Check Paycrest for reference ${payout.id}; nothing was sent.`,
          )
        : fail(
            "approved",
            `Paycrest refused the order (${created.left.code}). Nothing was sent.`,
          );
    }
    const order: PaycrestOrder = created.right;
    const deposit = order.providerAccount;
    yield* transition(
      {
        status: "order_created",
        providerOrderId: order.id,
        rate: order.rate,
        usdcAmount: toMicro(order.amount),
        feeUsdc: toMicro(order.transactionFee),
        amountToTransferUsdc: deposit
          ? toMicro(deposit.amountToTransfer)
          : null,
        depositAddress: deposit?.receiveAddress ?? null,
        depositValidUntil:
          deposit && Number.isFinite(Date.parse(deposit.validUntil))
            ? new Date(deposit.validUntil)
            : null,
      },
      "payout.order_created",
      {
        providerOrderId: order.id,
        rate: order.rate,
        amountToTransfer: deposit?.amountToTransfer ?? null,
      },
      "approved",
    );

    // 4. Only a safe order is ever funded.
    const expected = {
      reference: payout.id,
      refundAddress: funding.address,
      recipient,
      quote,
      maxDebitUsdc: payout.maxDebitUsdc,
    };
    const problem = checkOrder(order, { ...expected, now: Date.now() });
    if (problem || !deposit) {
      return yield* fail(
        "order_created",
        `Paycrest's order failed our checks (${problem?.kind ?? "unsafe"}: ${problem?.reasons.join("; ") ?? "no deposit instructions"}). Nothing was sent.`,
      );
    }
    const amount = toMicro(deposit.amountToTransfer);

    // 5. The funding barrier: re-checked under the lock, recorded first.
    const barrier = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const locked = yield* lockPayout(tx, payoutId);
        if (locked?.status !== "order_created" || locked.fundingStartedAt) {
          return "taken" as const;
        }
        if (yield* isPaused(tx, organizationId)) return "paused" as const;
        if (checkOrder(order, { ...expected, now: Date.now() })) {
          return "expired" as const;
        }
        yield* query(() =>
          tx
            .update(payouts)
            .set({ status: "funding", fundingStartedAt: new Date() })
            .where(
              and(eq(payouts.id, payoutId), isNull(payouts.fundingStartedAt)),
            ),
        );
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "payout.funding_started",
          entity: { type: "payout", id: payoutId },
          after: {
            depositAddress: deposit.receiveAddress,
            amountToTransfer: amount,
          },
        });
        return "funding" as const;
      }),
    );
    if (barrier === "taken") {
      return yield* Effect.dieMessage(`payout ${payoutId} is already funding`);
    }
    if (barrier === "paused") {
      return yield* fail(
        "order_created",
        "Payouts were paused. Nothing was sent.",
      );
    }
    if (barrier === "expired") {
      return yield* fail(
        "order_created",
        "Paycrest's deposit window closed before funding. Nothing was sent.",
      );
    }

    // 6. Exactly one send, with a key Privy will replay rather than repeat.
    const sent = yield* privy
      .sendUsdc({
        privyWalletId: funding.privyWalletId,
        to: deposit.receiveAddress,
        amount,
        idempotencyKey: `payout-${payout.id}`,
      })
      .pipe(Effect.either);
    if (sent._tag === "Left") {
      return yield* sent.left._tag === "SendRefused"
        ? fail(
            "funding",
            `The wallet refused the transfer${sent.left.policyViolation ? " (blocked by its policy)" : ""}. Nothing was sent.`,
          )
        : review(
            "funding",
            "The transfer's outcome is unknown. Check the chain and Paycrest before doing anything; never send again.",
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
            walletId: paying.walletId,
            type: "payout",
            usdcAmount: -amount,
            txHash: sent.right.txHash,
            counterpartyAddress: deposit.receiveAddress.toLowerCase(),
            payoutId,
          }),
        );
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "payout.funded",
          entity: { type: "payout", id: payoutId },
          after: {
            status: paying.status,
            txHash: sent.right.txHash,
            privyTransactionId: sent.right.privyTransactionId,
            amountToTransfer: amount,
          },
        });
        return paying;
      }),
    );
  });
}

/**
 * Funds one approved payout through its provider: a Paycrest order for KES,
 * a direct transfer for USDC to an allowlisted address.
 */
export function fundPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, FundDeps> {
  return withScope({ organizationId: input.organizationId }, (tx) =>
    query(() =>
      tx
        .select({ provider: payouts.provider })
        .from(payouts)
        .where(eq(payouts.id, input.payoutId)),
    ),
  ).pipe(
    Effect.flatMap(([payout]) =>
      payout?.provider === "onchain"
        ? fundOnchainPayout(input)
        : fundPaycrestPayout(input),
    ),
  );
}
