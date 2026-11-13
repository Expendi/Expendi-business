import { and, eq, isNull, sql } from "drizzle-orm";
import { Cause, Context, Duration, Effect, Either, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AmountTooLarge } from "../cash-out/quote.js";
import type { Paycrest, PaycrestError } from "../paycrest/paycrest-client.js";
import type { AmountTooSmall } from "../paycrest/quote.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import type {
  PretiumError,
  PretiumRecipient,
} from "../pretium/pretium-client.js";
import type { ReconcileSummary } from "./sync.js";
import { payouts, wallets, walletTransactions } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { quoteKesCashOut } from "../cash-out/quote.js";
import { BaseRpc, baseUsdcBalance } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";
import { InvalidRecipient } from "../paycrest/recipient.js";
import { Pretium } from "../pretium/pretium-client.js";
import {
  NotAPretiumCashOut,
  toPretiumRecipient,
} from "../pretium/recipient.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../pretium/settlement.js";
import { PrivyWallets } from "../wallet/privy-wallets.js";
import { baseHopOf } from "./base-hop.js";
import { isPaused, lockPayout } from "./guards.js";
import {
  isPretiumPaid,
  PRETIUM_UNPAID,
  syncPretiumPayout,
} from "./pretium-sync.js";
import { applyPayoutOutcome } from "./subjects.js";
import {
  FUNDING_STUCK_MS,
  PAYING_STUCK_MS,
  settleUnfundedApproval,
} from "./sync.js";
import { movePayout } from "./transitions.js";

/**
 * Pays a cash-out through Pretium (docs/decisions/pretium-cash-out-provider.md).
 * Pretium has no order: the USDC goes first, to one settlement address
 * pinned in code, and Pretium is told afterwards by the transfer's hash.
 * So everything that moves money or commits Pretium to act happens here,
 * each at most once per payout, each claimed under the payout's row lock
 * before it is attempted:
 *
 * - the send (`fundingStartedAt`), with Privy's idempotency key;
 * - telling Pretium to pay (`orderRequestedAt`);
 * - asking Pretium for the refund (`refundRequestedAt`).
 *
 * A claim whose outcome is lost is never retried: it is resolved by
 * reading (Pretium's transactions by hash, the refund arriving) or handed
 * to a person. The read-only side is `pretium-sync.ts`.
 */

const ACTOR = { type: "system", id: "payout-engine" } as const;

/** Telling Pretium got no clear answer, and no transaction turned up. */
export const PRETIUM_TELL_STUCK_MS = 10 * 60_000;

const PINNED_SETTLEMENT_ADDRESS = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();

const BYTES32 = /^0x[0-9a-f]{64}$/;

/**
 * How long the request that sent a cash-out's USDC waits for Base to mine
 * it, so Pretium is usually told within that request: a few reads, about
 * eight seconds in all. The job reads once a minute after that.
 */
export class PretiumReceiptPolling extends Context.Reference<PretiumReceiptPolling>()(
  "PretiumReceiptPolling",
  {
    defaultValue: (): {
      readonly retries: number;
      readonly interval: Duration.DurationInput;
    } => ({ retries: 4, interval: Duration.seconds(2) }),
  },
) {}

export type PretiumFundDeps =
  DatabaseService | AuditLog | Pretium | Paycrest | PrivyWallets | BaseRpc;

type Changes = Partial<typeof payouts.$inferInsert>;

const readPayout = (organizationId: string, payoutId: string) =>
  withScope({ organizationId }, (tx) =>
    query(() => tx.select().from(payouts).where(eq(payouts.id, payoutId))),
  ).pipe(
    Effect.flatMap(([payout]) =>
      payout
        ? Effect.succeed(payout)
        : Effect.dieMessage(`payout ${payoutId} vanished`),
    ),
  );

/**
 * Moves the payout out of `from`, audited, with what it pays following it.
 * Something else moving it first is a bug in the claims above, so it dies.
 */
const transition = (
  payout: Pick<Payout, "id" | "organizationId">,
  from: Payout["status"],
  changes: Changes,
  action: string,
  after: Record<string, unknown>,
) =>
  withScope({ organizationId: payout.organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set(changes)
          .where(and(eq(payouts.id, payout.id), eq(payouts.status, from)))
          .returning(),
      );
      if (!updated) {
        return yield* Effect.dieMessage(
          `payout ${payout.id} left ${from} unexpectedly`,
        );
      }
      yield* audit.record(tx, {
        actor: ACTOR,
        organizationId: payout.organizationId,
        action,
        entity: { type: "payout", id: payout.id },
        before: { status: from },
        after: { status: updated.status, ...after },
      });
      yield* applyPayoutOutcome(tx, updated);
      return updated;
    }),
  );

/** Shown to the company: says nothing of which provider was used. */
const fail = (
  payout: Pick<Payout, "id" | "organizationId">,
  from: Payout["status"],
  reason: string,
  details: Record<string, unknown> = {},
) =>
  transition(
    payout,
    from,
    { status: "failed", failureReason: reason },
    "payout.failed",
    { reason, ...details },
  );

/** For staff: may name Pretium. */
const review = (
  payout: Pick<Payout, "id" | "organizationId">,
  from: Payout["status"],
  reason: string,
  details: Record<string, unknown> = {},
) =>
  transition(
    payout,
    from,
    { status: "needs_review", failureReason: reason },
    "payout.needs_review",
    { reason, ...details },
  );

/**
 * Hands a `paying` cash-out to a person. Sync may have moved it meanwhile
 * (a callback can land during the job), and then this changes nothing.
 */
const reviewWhilePaying = (
  payout: Pick<Payout, "id" | "organizationId">,
  reason: string,
  details: Record<string, unknown> = {},
) =>
  movePayout({
    payout,
    from: "paying",
    changes: { status: "needs_review", failureReason: reason },
    action: "payout.needs_review",
    after: { reason, ...details },
    actor: ACTOR,
  });

/** The payee as Pretium pays them, or why Pretium can't. */
function pretiumRecipientOf(
  recipient: PayoutRecipient,
): Either.Either<PretiumRecipient, InvalidRecipient | NotAPretiumCashOut> {
  try {
    return Either.right(toPretiumRecipient(recipient));
  } catch (error) {
    if (
      error instanceof InvalidRecipient ||
      error instanceof NotAPretiumCashOut
    ) {
      return Either.left(error);
    }
    throw error;
  }
}

function quoteFailure(
  error: PretiumError | PaycrestError | AmountTooSmall | AmountTooLarge,
): string {
  switch (error._tag) {
    case "AmountTooSmall":
      return "the amount is below the smallest cash-out";
    case "AmountTooLarge":
      return "the amount is above the largest single cash-out";
    case "PaycrestError":
    case "PretiumError":
      return "the rate service didn't answer";
  }
}

/**
 * Funds one approved Pretium cash-out, exactly once, step for step as a
 * Paycrest one is funded, except that there is no order to check:
 *
 * 1. the payee must be one Pretium can pay;
 * 2. a fresh quote for the approved shillings, within the approved debit;
 * 3. for a transit wallet, the USDC must be there on chain;
 * 4. Pretium must still report the pinned settlement address;
 * 5. under the row lock, re-check and record that funding started;
 * 6. send exactly the quoted USDC to the pinned address, never to an
 *    address an API returned;
 * 7. save the send and debit the ledger together; then, once Base shows
 *    the transfer, tell Pretium.
 *
 * A definite failure before the send ends `failed` with nothing sent. Any
 * unclear outcome of the send ends `needs_review`, never sent again.
 */
export function fundPretiumPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, PretiumFundDeps> {
  const { organizationId, payoutId } = input;
  const scope = { organizationId };

  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const pretium = yield* Pretium;
    const privy = yield* PrivyWallets;

    const payout = yield* readPayout(organizationId, payoutId);
    if (
      payout.provider !== "pretium" ||
      payout.status !== "approved" ||
      payout.orderRequestedAt ||
      payout.fundingStartedAt
    ) {
      return yield* Effect.dieMessage(
        `payout ${payoutId} is not a Pretium cash-out ready to fund (${payout.status})`,
      );
    }

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
      return yield* fail(
        payout,
        "approved",
        "The company wallet isn't active.",
      );
    }
    if (transit) {
      const hop = yield* baseHopOf(payout);
      if (hop?.status !== "succeeded") {
        return yield* Effect.dieMessage(
          `payout ${payoutId} can't be funded before its Base hop delivers (${hop?.status ?? "no hop"})`,
        );
      }
    }

    // 1. A payee Pretium can pay.
    const payee = pretiumRecipientOf(payout.recipient);
    if (Either.isLeft(payee)) {
      return yield* fail(
        payout,
        "approved",
        payee.left instanceof InvalidRecipient
          ? `The payee's details aren't valid: ${payee.left.message}. Nothing was sent.`
          : "This payee can't be paid by this cash-out yet. Nothing was sent.",
        { problem: payee.left.message },
      );
    }

    // 2. A fresh quote for the shillings the admin approved.
    const quoted = yield* quoteKesCashOut("pretium", payout.amountKes).pipe(
      Effect.either,
    );
    if (quoted._tag === "Left") {
      return yield* fail(
        payout,
        "approved",
        `Couldn't get a rate for this cash-out: ${quoteFailure(quoted.left)}. Nothing was sent.`,
        {
          problem: "code" in quoted.left ? quoted.left.code : quoted.left._tag,
        },
      );
    }
    const quote = quoted.right;
    if (quote.usdcAmount > payout.maxDebitUsdc) {
      return yield* fail(
        payout,
        "approved",
        "The rate moved past what was approved. Approve again at the new rate.",
      );
    }
    const amount = quote.usdcAmount;

    // 3. The hop delivered at least this much, but only the chain says the
    // transit wallet still holds it.
    if (transit) {
      const held = yield* baseUsdcBalance(fundingAddress).pipe(Effect.either);
      if (held._tag === "Left" || held.right < amount) {
        return yield* fail(
          payout,
          "approved",
          held._tag === "Left"
            ? "The transit wallet's balance couldn't be read before funding. Nothing was sent."
            : "The transit wallet doesn't hold the USDC for this cash-out. Nothing was sent.",
        );
      }
    }

    // 4. The address is pinned in code; Pretium must still say it is theirs.
    const reported = yield* pretium.baseSettlementAddress().pipe(Effect.either);
    if (
      reported._tag === "Left" ||
      reported.right.toLowerCase() !== PINNED_SETTLEMENT_ADDRESS
    ) {
      return yield* fail(
        payout,
        "approved",
        "The cash-out's destination couldn't be confirmed. Nothing was sent.",
        reported._tag === "Left"
          ? { problem: reported.left.code }
          : {
              problem: "settlement_address_mismatch",
              reported: reported.right,
            },
      );
    }

    // 5. The funding barrier: re-checked under the lock, recorded first.
    const barrier = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const locked = yield* lockPayout(tx, payoutId);
        if (
          locked?.status !== "approved" ||
          locked.orderRequestedAt ||
          locked.fundingStartedAt
        ) {
          return "taken" as const;
        }
        if (yield* isPaused(tx, organizationId)) return "paused" as const;
        const [funding] = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: "funding",
              fundingStartedAt: new Date(),
              rate: quote.rate,
              usdcAmount: amount,
              feeUsdc: 0n,
              amountToTransferUsdc: amount,
              depositAddress: PINNED_SETTLEMENT_ADDRESS,
            })
            .where(
              and(
                eq(payouts.id, payoutId),
                eq(payouts.status, "approved"),
                isNull(payouts.fundingStartedAt),
              ),
            )
            .returning(),
        );
        if (!funding) return "taken" as const;
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId,
          action: "payout.funding_started",
          entity: { type: "payout", id: payoutId },
          after: {
            depositAddress: PINNED_SETTLEMENT_ADDRESS,
            amountToTransfer: amount,
            rate: quote.rate,
          },
        });
        yield* applyPayoutOutcome(tx, funding);
        return "funding" as const;
      }),
    );
    if (barrier === "taken") {
      return yield* Effect.dieMessage(`payout ${payoutId} is already funding`);
    }
    if (barrier === "paused") {
      return yield* fail(
        payout,
        "approved",
        "Payouts were paused. Nothing was sent.",
      );
    }

    // 6. Exactly one send, with a key Privy will replay rather than repeat.
    const sent = yield* privy
      .sendUsdc({
        privyWalletId: fundingPrivyWalletId,
        to: PRETIUM_BASE_SETTLEMENT_ADDRESS,
        amount,
        idempotencyKey: `payout-${payout.id}`,
      })
      .pipe(Effect.either);
    if (sent._tag === "Left") {
      return yield* sent.left._tag === "SendRefused"
        ? fail(
            payout,
            "funding",
            `The wallet refused the transfer${sent.left.policyViolation ? " (blocked by its policy)" : ""}. Nothing was sent.`,
          )
        : review(
            payout,
            "funding",
            "The transfer to Pretium's settlement address has an unknown outcome. Check the chain before doing anything; never send again, and don't tell Pretium a hash until it is found.",
          );
    }

    // 7. The send and its debit, together.
    yield* withScope(scope, (tx) =>
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
            counterpartyAddress: PINNED_SETTLEMENT_ADDRESS,
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
      }),
    );

    // The USDC is with Pretium now; telling it is the job's to finish if
    // this attempt breaks.
    const told = yield* Effect.exit(
      continuePretiumPayout({ organizationId, payoutId, awaitReceipt: true }),
    );
    if (Exit.isFailure(told)) {
      console.error(
        `[pretium-fund] telling Pretium about payout ${payoutId} broke; the job retries`,
        Cause.pretty(told.cause),
      );
    }
    return yield* readPayout(organizationId, payoutId);
  });
}

/**
 * Takes a claim on `payout` under its row lock: `claim` says whether the
 * locked row still allows it, and `changes` records it. False when another
 * run got there first.
 */
const claim = (
  payout: Pick<Payout, "id" | "organizationId">,
  allowed: (locked: Payout) => boolean,
  changes: Changes,
) =>
  withScope({ organizationId: payout.organizationId }, (tx) =>
    Effect.gen(function* () {
      const locked = yield* lockPayout(tx, payout.id);
      if (!locked || !allowed(locked)) return false;
      yield* query(() =>
        tx.update(payouts).set(changes).where(eq(payouts.id, payout.id)),
      );
      return true;
    }),
  );

/** Saves fields on a payout that is still `paying`, audited when `action` is given. */
const saveWhilePaying = (
  payout: Pick<Payout, "id" | "organizationId">,
  changes: Changes,
  action?: { readonly name: string; readonly after: Record<string, unknown> },
) =>
  withScope({ organizationId: payout.organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set(changes)
          .where(and(eq(payouts.id, payout.id), eq(payouts.status, "paying")))
          .returning(),
      );
      if (updated && action) {
        yield* audit.record(tx, {
          actor: ACTOR,
          organizationId: payout.organizationId,
          action: action.name,
          entity: { type: "payout", id: payout.id },
          after: action.after,
        });
      }
      return updated ?? null;
    }),
  );

/** Saves the transaction code Pretium gave for this payout's transfer. */
const saveTransaction = (
  payout: Payout,
  transaction: { readonly transactionCode: string; readonly status: string },
  how: "accepted" | "found",
) =>
  saveWhilePaying(
    payout,
    {
      providerOrderId: transaction.transactionCode,
      providerStatus: transaction.status,
      providerCheckedAt: new Date(),
    },
    {
      name: "payout.pretium_transaction",
      after: {
        transactionCode: transaction.transactionCode,
        pretiumStatus: transaction.status,
        how,
      },
    },
  ).pipe(
    Effect.tap((saved) =>
      saved
        ? Effect.void
        : Effect.sync(() =>
            console.error(
              `[pretium-fund] payout ${payout.id} left paying before Pretium's transaction ${transaction.transactionCode} was saved`,
            ),
          ),
    ),
  );

/**
 * Asks Pretium, once, to send back the USDC of a cash-out it won't pay.
 * Never for one Pretium reports paid or that is `paid`. Success keeps it
 * `paying` until the refund is credited (see `syncPretiumPayout`); any
 * error is for a person, since the USDC is with Pretium.
 */
function requestRefund(
  payout: Payout,
  txHash: string,
  why: string,
): Effect.Effect<void, DatabaseError, PretiumFundDeps> {
  return Effect.gen(function* () {
    const pretium = yield* Pretium;
    const claimed = yield* claim(
      payout,
      (locked) =>
        locked.status === "paying" &&
        locked.refundRequestedAt === null &&
        !isPretiumPaid(locked.providerStatus),
      { refundRequestedAt: new Date() },
    );
    if (!claimed) return;

    const refunded = yield* pretium.refund(txHash).pipe(Effect.either);
    if (refunded._tag === "Left") {
      yield* reviewWhilePaying(
        payout,
        `Pretium didn't accept the refund request (${refunded.left.code}${refunded.left.ambiguous ? ", outcome unknown" : ""}). The USDC is with Pretium (transfer ${txHash}); resolve it with Pretium.`,
        { why, pretiumError: refunded.left.code },
      );
      return;
    }
    const named = refunded.right.refundTxHash;
    const refundTxHash = named !== null && BYTES32.test(named) ? named : null;
    if (named !== null && refundTxHash === null) {
      console.error(
        `[pretium-fund] Pretium named refund ${named} for payout ${payout.id}, not a Base hash; not saved`,
      );
    }
    yield* saveWhilePaying(
      payout,
      { refundTxHash },
      {
        name: "payout.refund_requested",
        after: {
          why,
          refundTxHash,
          amount: refunded.right.amount,
          address: refunded.right.address,
        },
      },
    );
  });
}

/** The Base address a payout's USDC was sent from, lowercased. */
function fundingAddressOf(
  payout: Payout,
): Effect.Effect<string | null, DatabaseError, DatabaseService> {
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    query(() =>
      tx
        .select({
          chain: wallets.chain,
          address: wallets.address,
          transitAddress: wallets.transitAddress,
        })
        .from(wallets)
        .where(eq(wallets.id, payout.walletId)),
    ),
  ).pipe(
    Effect.map(([wallet]) => {
      const address =
        wallet?.chain === "near" ? wallet.transitAddress : wallet?.address;
      return address?.toLowerCase() ?? null;
    }),
  );
}

type TransferOnBase =
  | { readonly kind: "confirmed" }
  | { readonly kind: "not_yet" }
  | { readonly kind: "for_review"; readonly reason: string };

/**
 * Whether Base shows `txHash` as exactly this payout's transfer: mined,
 * successful, and with one USDC transfer to the settlement address, from
 * the wallet that funded the payout, for exactly the amount sent. Pretium
 * may refuse a hash it can't see yet, and a definite refusal would ask for
 * the refund of a cash-out that was fine, so nothing is told before this.
 * `wait` polls briefly for a receipt that isn't mined yet.
 */
function transferOnBase(
  payout: Payout,
  txHash: string,
  wait: boolean,
  now: number,
): Effect.Effect<TransferOnBase, DatabaseError, DatabaseService | BaseRpc> {
  return Effect.gen(function* () {
    const rpc = yield* BaseRpc;
    const polling = yield* PretiumReceiptPolling;
    const readReceipt = Effect.suspend(() =>
      rpc.getTransactionReceipt(txHash),
    ).pipe(Effect.either);
    let read = yield* readReceipt;
    for (
      let retry = 0;
      wait && retry < polling.retries && Either.isRight(read) && !read.right;
      retry += 1
    ) {
      yield* Effect.sleep(polling.interval);
      read = yield* readReceipt;
    }

    const sentFor = now - (payout.fundingStartedAt?.getTime() ?? now);
    if (Either.isLeft(read)) {
      console.warn(
        `[pretium-fund] Base receipt of payout ${payout.id}'s transfer ${txHash} unavailable: ${read.left.message}`,
      );
      return sentFor > PAYING_STUCK_MS
        ? {
            kind: "for_review",
            reason: `Base couldn't be read to confirm transfer ${txHash} to Pretium for over two hours (${read.left.message}), so Pretium wasn't told. Confirm the transfer on Base before doing anything; never send again.`,
          }
        : { kind: "not_yet" };
    }
    const receipt = read.right;
    if (!receipt) {
      return sentFor > FUNDING_STUCK_MS
        ? {
            kind: "for_review",
            reason: `Transfer ${txHash} to Pretium isn't on Base ${Math.floor(sentFor / 60_000)} minutes after it was sent, so Pretium wasn't told. Find the transfer before doing anything; never send again.`,
          }
        : { kind: "not_yet" };
    }
    if (receipt.status !== "0x1") {
      return {
        kind: "for_review",
        reason: `Transfer ${txHash} to Pretium reverted on Base: nothing reached Pretium, though the ledger shows the debit. Pretium wasn't told. Check the wallet on chain before doing anything; never send again.`,
      };
    }
    const from = yield* fundingAddressOf(payout);
    const toPretium = usdcTransfersIn(receipt).filter(
      (transfer) => transfer.to === PINNED_SETTLEMENT_ADDRESS,
    );
    const [transfer] = toPretium;
    if (
      receipt.transactionHash.toLowerCase() !== txHash.toLowerCase() ||
      toPretium.length !== 1 ||
      transfer === undefined ||
      from === null ||
      transfer.from !== from ||
      transfer.amount !== payout.amountToTransferUsdc
    ) {
      return {
        kind: "for_review",
        reason: `Transfer ${txHash} on Base isn't exactly one transfer of ${payout.amountToTransferUsdc ?? "?"} USDC base units from the company's wallet to Pretium's settlement address (found ${toPretium.map((found) => `${found.amount} from ${found.from}`).join(", ") || "none"}), so Pretium wasn't told. Check the chain before doing anything.`,
      };
    }
    return { kind: "confirmed" };
  });
}

/**
 * Takes a `paying` Pretium cash-out one step on: resolves the send's hash,
 * confirms the transfer on Base, tells Pretium once, follows up an unclear
 * telling by hash, and asks for the refund once when Pretium won't pay.
 * Idempotent: run inline after funding (`awaitReceipt`) and by the minute
 * job, any number of times.
 */
export function continuePretiumPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
  readonly awaitReceipt?: boolean;
}): Effect.Effect<Payout, DatabaseError, PretiumFundDeps> {
  const { organizationId, payoutId } = input;
  return Effect.gen(function* () {
    const pretium = yield* Pretium;
    const now = Date.now();

    /** Pretium's transaction for `hash`, saved on the payout if found. */
    const findByHash = (current: Payout, hash: string) =>
      Effect.gen(function* () {
        const since = current.fundingStartedAt ?? new Date(now);
        const found = yield* pretium
          .findByHash({ txHash: hash, since })
          .pipe(Effect.either);
        if (found._tag === "Left") {
          console.warn(
            `[pretium-fund] searching Pretium for payout ${current.id}'s transfer failed: ${found.left.code}`,
          );
          return false;
        }
        if (found.right === null) return false;
        yield* saveTransaction(current, found.right, "found");
        return true;
      });

    let payout = yield* readPayout(organizationId, payoutId);
    if (payout.provider !== "pretium" || payout.status !== "paying") {
      return payout;
    }

    // a. Privy may accept a sponsored send before it has a hash.
    if (payout.txHash === null) {
      const found = yield* lookUpHash(payout);
      if (found === null) {
        const fundingStartedAt = payout.fundingStartedAt?.getTime() ?? now;
        if (now - fundingStartedAt > FUNDING_STUCK_MS) {
          yield* reviewWhilePaying(
            payout,
            `Privy accepted the transfer to Pretium (transaction ${payout.privyTransactionId ?? "unknown"}) but no hash is known, so Pretium was never told. Find the transfer before doing anything.`,
          );
        }
        return yield* readPayout(organizationId, payoutId);
      }
      const saved = yield* saveWhilePaying(
        payout,
        { txHash: found },
        { name: "payout.tx_hash_found", after: { txHash: found } },
      );
      if (!saved) return yield* readPayout(organizationId, payoutId);
      payout = saved;
    }
    const txHash = payout.txHash;
    if (txHash === null) return payout;

    // b. Telling Pretium, at most once, and only about a transfer Base shows.
    if (payout.providerOrderId === null && payout.refundRequestedAt === null) {
      if (payout.orderRequestedAt === null) {
        const onBase = yield* transferOnBase(
          payout,
          txHash,
          input.awaitReceipt === true,
          now,
        );
        if (onBase.kind === "not_yet") {
          return yield* readPayout(organizationId, payoutId);
        }
        if (onBase.kind === "for_review") {
          yield* reviewWhilePaying(payout, onBase.reason);
          return yield* readPayout(organizationId, payoutId);
        }
        const payee = pretiumRecipientOf(payout.recipient);
        if (Either.isLeft(payee)) {
          yield* reviewWhilePaying(
            payout,
            `The USDC was sent to Pretium but the payee can no longer be paid by Pretium (${payee.left.message}). Pretium wasn't told; ask Pretium for the refund of transfer ${txHash}.`,
          );
          return yield* readPayout(organizationId, payoutId);
        }
        const recipient = payee.right;
        const claimed = yield* claim(
          payout,
          (locked) =>
            locked.status === "paying" &&
            locked.txHash === txHash &&
            locked.providerOrderId === null &&
            locked.orderRequestedAt === null &&
            locked.refundRequestedAt === null,
          { orderRequestedAt: new Date() },
        );
        if (!claimed) return yield* readPayout(organizationId, payoutId);

        const told = yield* pretium
          .pay({
            recipient,
            amountShillings: payout.amountKes / 100n,
            transactionHash: txHash,
            reference: payout.id,
          })
          .pipe(Effect.either);
        if (told._tag === "Right") {
          yield* saveTransaction(payout, told.right, "accepted");
        } else if (told.left.code === "HASH_ALREADY_PROCESSED") {
          yield* findByHash(payout, txHash);
        } else if (!told.left.ambiguous) {
          yield* requestRefund(
            payout,
            txHash,
            `Pretium refused to pay (${told.left.code})`,
          );
        } else {
          console.warn(
            `[pretium-fund] telling Pretium about payout ${payoutId} had no clear answer (${told.left.code}); the job looks it up by hash`,
          );
        }
        return yield* readPayout(organizationId, payoutId);
      }

      // An earlier telling's outcome is unknown: never ask again.
      const found = yield* findByHash(payout, txHash);
      if (
        !found &&
        now - payout.orderRequestedAt.getTime() > PRETIUM_TELL_STUCK_MS
      ) {
        yield* reviewWhilePaying(
          payout,
          `Pretium was told about transfer ${txHash} but no transaction for it has turned up. Check with Pretium before doing anything; never tell it again.`,
        );
      }
      return yield* readPayout(organizationId, payoutId);
    }

    // c. Pretium won't pay a transaction it made: ask for the refund.
    if (
      payout.providerOrderId !== null &&
      payout.refundRequestedAt === null &&
      payout.providerStatus !== null &&
      PRETIUM_UNPAID.has(payout.providerStatus.toUpperCase())
    ) {
      yield* requestRefund(
        payout,
        txHash,
        `Pretium reported transaction ${payout.providerOrderId} ${payout.providerStatus}`,
      );
    }
    return yield* readPayout(organizationId, payoutId);
  });
}

/**
 * The send's hash from Privy's own record of it. Nothing else is trusted:
 * a hash guessed from Base logs could name another transfer, and Pretium
 * would pay against it.
 */
function lookUpHash(
  payout: Payout,
): Effect.Effect<string | null, DatabaseError, DatabaseService | PrivyWallets> {
  return Effect.gen(function* () {
    const privy = yield* PrivyWallets;
    if (payout.privyTransactionId === null) return null;
    const [wallet] = yield* withScope(
      { organizationId: payout.organizationId },
      (tx) =>
        query(() =>
          tx
            .select({
              chain: wallets.chain,
              privyWalletId: wallets.privyWalletId,
              transitPrivyWalletId: wallets.transitPrivyWalletId,
            })
            .from(wallets)
            .where(eq(wallets.id, payout.walletId)),
        ),
    );
    const privyWalletId =
      wallet?.chain === "near"
        ? wallet.transitPrivyWalletId
        : wallet?.privyWalletId;
    if (!privyWalletId) return null;
    const found = yield* privy
      .transactionHash({
        privyWalletId,
        privyTransactionId: payout.privyTransactionId,
      })
      .pipe(Effect.either);
    if (found._tag === "Left") {
      console.warn(
        `[pretium-fund] Privy didn't return transaction ${payout.privyTransactionId} of payout ${payout.id}: ${found.left.message}`,
      );
      return null;
    }
    return found.right;
  });
}

interface PayoutRef extends Record<string, unknown> {
  readonly payout_id: string;
  readonly organization_id: string;
}

/**
 * The minute job: for each Pretium cash-out with USDC in flight, the
 * continuation, then the sync. Callbacks are not guaranteed, so this is
 * the source of truth. An approved one that was never funded lapses as a
 * Paycrest one does; the outbound quotes job funds it once its hop has
 * delivered. Each payout is isolated: one breaking doesn't stop the rest.
 */
export function reconcilePretiumPayouts(
  maxRows = 50,
): Effect.Effect<ReconcileSummary, DatabaseError, PretiumFundDeps> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM pretium_payouts_to_reconcile(${maxRows})`,
        ),
      ),
    );
    let changed = 0;
    let errors = 0;

    const { rows: approved } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM pretium_cash_outs_awaiting_funding(${maxRows})`,
        ),
      ),
    );
    for (const ref of approved) {
      const exit = yield* Effect.exit(
        readPayout(ref.organization_id, ref.payout_id).pipe(
          Effect.flatMap((payout) =>
            payout.status === "approved"
              ? settleUnfundedApproval(payout, Date.now())
              : Effect.succeed(false),
          ),
        ),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value) changed += 1;
      } else {
        errors += 1;
        console.error(
          `[reconcile-pretium] approved payout ${ref.payout_id} failed to settle`,
          Cause.pretty(exit.cause),
        );
      }
    }

    for (const ref of rows) {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const target = {
            organizationId: ref.organization_id,
            payoutId: ref.payout_id,
          };
          const before = yield* readPayout(
            target.organizationId,
            target.payoutId,
          );
          yield* continuePretiumPayout(target);
          const synced = yield* syncPretiumPayout({
            ...target,
            source: "reconcile",
          });
          const after = yield* readPayout(
            target.organizationId,
            target.payoutId,
          );
          return synced.outcome.changed || after.status !== before.status;
        }),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value) changed += 1;
      } else {
        errors += 1;
        console.error(
          `[reconcile-pretium] payout ${ref.payout_id} failed to reconcile`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { checked: rows.length + approved.length, changed, errors };
  });
}
