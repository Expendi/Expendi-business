import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { QuoteDepositDeps } from "../intents/quote-deposit.js";
import type {
  PaycrestError,
  PaycrestOrder,
} from "../paycrest/paycrest-client.js";
import type { AmountTooSmall, KesPayoutQuote } from "../paycrest/quote.js";
import type { OnchainDeps } from "./onchain.js";
import type { PretiumFundDeps } from "./pretium-fund.js";
import { payouts, wallets, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { baseUsdcBalance } from "../chain/base-rpc.js";
import { toMicro } from "../paycrest/amounts.js";
import { buildOrderRequest } from "../paycrest/order-request.js";
import { checkOrder } from "../paycrest/order-safety.js";
import { Paycrest } from "../paycrest/paycrest-client.js";
import { quoteKesPayout } from "../paycrest/quote.js";
import { toPaycrestRecipient } from "../paycrest/recipient.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import {
  advanceBaseHop,
  baseHopOf,
  planBaseHops,
  settleHopPayouts,
} from "./base-hop.js";
import { isPaused, lockPayout } from "./guards.js";
import { fundOnchainPayout } from "./onchain.js";
import { PAYOUT_MEMO } from "./prepare.js";
import { fundPretiumPayout } from "./pretium-fund.js";
import { applyPayoutOutcome } from "./subjects.js";

const ACTOR = { type: "system", id: "payout-engine" } as const;

type CashOutDeps =
  DatabaseService | AuditLog | Paycrest | PrivyWallets | BaseRpc;

export type FundDeps =
  CashOutDeps | PretiumFundDeps | OnchainDeps | QuoteDepositDeps;

/** Says why there's no quote without naming the provider. */
function quoteFailure(error: PaycrestError | AmountTooSmall): string {
  return error._tag === "AmountTooSmall"
    ? "the amount is below the smallest cash-out"
    : "the rate service didn't answer";
}

/**
 * The wallet a cash-out's order is funded from and refunded to. Paycrest
 * takes and returns USDC on Base only, so for a company whose money is on
 * NEAR it is the transit wallet, with its Privy policy cap; for a wallet
 * made before the move it is the company wallet itself.
 */
interface FundingWallet {
  readonly address: string;
  readonly privyWalletId: string;
  /** The USDC must be seen in it on chain before an order is funded. */
  readonly transit: boolean;
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
 * For a company whose money is on NEAR, all of this runs from the transit
 * wallet, and only once the payout's Base hop has delivered: the order's
 * refund address is the transit wallet, and before step 5 the transit
 * wallet must hold the order's amount on chain. The ledger is debited here,
 * when the payout is funded, never at the hop.
 *
 * A definite failure before step 6 ends `failed` with nothing sent. Any
 * unclear outcome ends `needs_review`: a person resolves it against
 * Paycrest and the chain, and nothing is ever re-sent automatically.
 * Payouts are funded one by one, so one failing never affects another.
 */
function fundPaycrestPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, CashOutDeps> {
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
          yield* applyPayoutOutcome(tx, updated);
          return updated;
        }),
      );

    // `failureReason` is shown to the company, so a failure says nothing
    // of the provider; what staff need goes in the audit entry.
    const fail = (
      from: Payout["status"],
      reason: string,
      details: Record<string, unknown> = {},
    ) =>
      transition(
        { status: "failed", failureReason: reason },
        "payout.failed",
        { reason, ...details },
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
            chain: wallets.chain,
            address: wallets.address,
            privyWalletId: wallets.privyWalletId,
            transitAddress: wallets.transitAddress,
            transitPrivyWalletId: wallets.transitPrivyWalletId,
          })
          .from(wallets)
          .where(eq(wallets.id, payout.walletId)),
      ),
    );
    const transit = wallet?.chain === "near";
    const fundingAddress = transit ? wallet.transitAddress : wallet?.address;
    const fundingPrivyWalletId = transit
      ? wallet.transitPrivyWalletId
      : wallet?.privyWalletId;
    if (!fundingAddress || !fundingPrivyWalletId) {
      return yield* fail("approved", "The company wallet isn't active.");
    }
    const funding: FundingWallet = {
      address: fundingAddress,
      privyWalletId: fundingPrivyWalletId,
      transit,
    };
    if (transit) {
      const hop = yield* baseHopOf(payout);
      if (hop?.status !== "succeeded") {
        return yield* Effect.dieMessage(
          `payout ${payoutId} can't be funded before its Base hop delivers (${hop?.status ?? "no hop"})`,
        );
      }
    }

    // 1. A fresh quote for the KES the admin approved.
    const quoted = yield* quoteKesPayout(payout.amountKes).pipe(Effect.either);
    if (quoted._tag === "Left") {
      return yield* fail(
        "approved",
        `Couldn't get a rate for this cash-out: ${quoteFailure(quoted.left)}. Nothing was sent.`,
        { problem: quoted.left.message },
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
            `The cash-out was refused (${created.left.code}). Nothing was sent.`,
            { problem: created.left.message },
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
        `The cash-out failed our safety checks (${problem?.kind ?? "unsafe"}). Nothing was sent.`,
        { problems: problem?.reasons ?? ["no deposit instructions"] },
      );
    }
    const amount = toMicro(deposit.amountToTransfer);

    // The hop delivered at least this much, but only the chain says the
    // transit wallet still holds it.
    if (funding.transit) {
      const held = yield* baseUsdcBalance(funding.address).pipe(Effect.either);
      if (held._tag === "Left" || held.right < amount) {
        return yield* fail(
          "order_created",
          held._tag === "Left"
            ? "The transit wallet's balance couldn't be read before funding. Nothing was sent."
            : "The transit wallet doesn't hold the USDC for this order. Nothing was sent.",
        );
      }
    }

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
        const [funding] = yield* query(() =>
          tx
            .update(payouts)
            .set({ status: "funding", fundingStartedAt: new Date() })
            .where(
              and(eq(payouts.id, payoutId), isNull(payouts.fundingStartedAt)),
            )
            .returning(),
        );
        if (funding) yield* applyPayoutOutcome(tx, funding);
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
        "The cash-out's payment window closed before funding. Nothing was sent.",
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
        yield* applyPayoutOutcome(tx, paying);
        return paying;
      }),
    );
  });
}

/**
 * Moves a Base hop as far as it can go now and applies where it stands to
 * the cash-outs waiting for it: once it has delivered, each is ordered and
 * funded from the transit wallet. Called by the request that approved the
 * payouts and by the job, any number of times.
 */
export function continueBaseHop(
  quote: IntentQuote,
): Effect.Effect<IntentQuote, DatabaseError, FundDeps> {
  return Effect.gen(function* () {
    const advanced = yield* advanceBaseHop(quote);
    yield* settleHopPayouts({
      quote: advanced,
      fund: (payout) => {
        const target = {
          organizationId: payout.organizationId,
          payoutId: payout.id,
        };
        return payout.provider === "pretium"
          ? fundPretiumPayout(target)
          : fundPaycrestPayout(target);
      },
    });
    return advanced;
  });
}

/**
 * A cash-out for a company whose money is on NEAR: Base hop first, then
 * its provider is paid from the transit wallet. The payout comes
 * back as far as it got; while its hop is under way it is still `approved`
 * and the job finishes it.
 */
function fundCashOutThroughHop(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, FundDeps> {
  const read = withScope({ organizationId: input.organizationId }, (tx) =>
    query(() =>
      tx.select().from(payouts).where(eq(payouts.id, input.payoutId)),
    ),
  ).pipe(
    Effect.flatMap(([payout]) =>
      payout
        ? Effect.succeed(payout)
        : Effect.dieMessage(`payout ${input.payoutId} vanished`),
    ),
  );
  return Effect.gen(function* () {
    yield* planBaseHops({
      organizationId: input.organizationId,
      payoutIds: [input.payoutId],
    });
    const hop = yield* baseHopOf(yield* read);
    if (hop !== null) yield* continueBaseHop(hop);
    return yield* read;
  });
}

/**
 * Funds one approved payout through its provider: for KES, a Paycrest
 * order or a transfer to Pretium (after a Base hop when the company's
 * money is on NEAR); for USDC, a transfer to an allowlisted address.
 */
export function fundPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, FundDeps> {
  return withScope({ organizationId: input.organizationId }, (tx) =>
    query(() =>
      tx
        .select({ provider: payouts.provider, chain: wallets.chain })
        .from(payouts)
        .innerJoin(wallets, eq(wallets.id, payouts.walletId))
        .where(eq(payouts.id, input.payoutId)),
    ),
  ).pipe(
    Effect.flatMap(
      ([payout]): Effect.Effect<Payout, DatabaseError, FundDeps> => {
        if (payout?.provider === "onchain") return fundOnchainPayout(input);
        if (payout?.chain === "near") return fundCashOutThroughHop(input);
        return payout?.provider === "pretium"
          ? fundPretiumPayout(input)
          : fundPaycrestPayout(input);
      },
    ),
  );
}
