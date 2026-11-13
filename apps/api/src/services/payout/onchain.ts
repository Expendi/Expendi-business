import { and, desc, eq, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { CompanyWalletSend, Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { BaseRpcError } from "../chain/base-rpc.js";
import type { NearRpcError } from "../chain/near-rpc.js";
import type { PrivyWallets } from "../wallet/privy-wallets.js";
import type { DeliveryDeps } from "./delivery.js";
import { DatabaseService } from "../../db/client.js";
import {
  companyWalletSends,
  payouts,
  wallets,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { AuditLog } from "../audit/audit-log.js";
import { BaseRpc } from "../chain/base-rpc.js";
import { usdcTransfersIn } from "../chain/base.js";
import { NearRelayer } from "../chain/near-relayer.js";
import { NearRpc } from "../chain/near-rpc.js";
import { NearChain, nearUsdcTransfersIn } from "../chain/near.js";
import {
  sendUsdcFromCompanyWallet,
  settleCompanyWalletSend,
} from "../wallet/company-wallet-send.js";
import { deliverUsdcPayout } from "./delivery.js";
import { isPaused, lockPayout, payoutSendKey } from "./guards.js";
import { prepareRecipient } from "./near-recipient.js";
import { applyPayoutOutcome } from "./subjects.js";
import { FUNDING_STUCK_MS } from "./sync.js";

/**
 * USDC payouts (spec §6.19) and withdrawals (§6.9): the approved USDC, sent
 * to an address on the company's allowlist (`provider = onchain`). No
 * Paycrest, and Expendi pays the gas.
 *
 * A payee on NEAR is paid straight from the company wallet with a company
 * wallet send (docs/decisions/near-main-chain.md, "Sending from a company
 * wallet"). A company wallet runs one send at a time, so a payout whose
 * turn hasn't come waits in `funding` and the minute job sends it: a
 * payroll of NEAR payees is paid one after another. A company whose USDC is
 * kept in a confidential account pays every payee, a NEAR one included,
 * through a quote paid by a signed message (`delivery.ts`).
 */

const ENGINE = { type: "system", id: "payout-engine" } as const;
const CONFIRMER = { type: "system", id: "onchain-confirm" } as const;

export type OnchainDeps =
  | DatabaseService
  | AuditLog
  | PrivyWallets
  | NearRpc
  | NearRelayer
  | NearChain
  | DeliveryDeps;

/**
 * How many sends one payout may have signed and seen expire unrun before it
 * fails. Each is proven never to have moved anything, so trying again is
 * safe; stopping keeps a relayer that is down from being asked for ever.
 */
export const MAX_SEND_ATTEMPTS = 3;

/**
 * How long a signed send may stay unreadable before a person looks. A send
 * expires after about two minutes, so by now the chain should have said
 * whether it ran.
 */
export const SEND_UNCLEAR_AFTER_MS = FUNDING_STUCK_MS;

/** Distinguishes these advisory locks from every other in the database. */
const DRIVE_LOCK_CLASS = 72_010;

const UNKNOWN_OUTCOME =
  "The transfer's outcome is unknown. Check the chain before doing anything; never send again.";

const RAN_EMPTY =
  "The chain ran the transfer, but the USDC contract moved nothing";

/**
 * Moves a payout out of `from`, audited, with what it pays following it.
 * If something else moved it first, nothing changes and the payout comes
 * back as it now stands.
 */
function move(
  payout: Pick<Payout, "id" | "organizationId">,
  from: Payout["status"],
  changes: Partial<typeof payouts.$inferInsert>,
  action: string,
  after: Record<string, unknown>,
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [updated] = yield* query(() =>
        tx
          .update(payouts)
          .set(changes)
          .where(and(eq(payouts.id, id), eq(payouts.status, from)))
          .returning(),
      );
      if (!updated) {
        const [current] = yield* query(() =>
          tx.select().from(payouts).where(eq(payouts.id, id)),
        );
        return current ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      yield* audit.record(tx, {
        actor: ENGINE,
        organizationId,
        action,
        entity: { type: "payout", id },
        before: { status: from },
        after: { status: updated.status, ...after },
      });
      yield* applyPayoutOutcome(tx, updated);
      return updated;
    }),
  );
}

const fail = (payout: Payout, reason: string) =>
  move(
    payout,
    payout.status,
    { status: "failed", failureReason: reason },
    "payout.failed",
    { reason },
  );

const review = (payout: Payout, reason: string) =>
  move(
    payout,
    payout.status,
    { status: "needs_review", failureReason: reason },
    "payout.needs_review",
    { reason },
  );

/** Leaves the payout where it is and puts it at the back of the job's queue. */
const wait = (payout: Payout) =>
  withScope({ organizationId: payout.organizationId }, (tx) =>
    query(() =>
      tx
        .update(payouts)
        .set({ providerCheckedAt: new Date() })
        .where(eq(payouts.id, payout.id)),
    ),
  ).pipe(Effect.as(payout));

/**
 * Pays a USDC payee through a NEAR Intents quote whose recipient is the
 * payee (`delivery.ts`): any payee on Base or Solana, and every payee of a
 * company whose USDC is kept in a confidential account, a payee on NEAR
 * included. It is given the approved payout, whose `recipient` holds the
 * payee chain and address and whose `quotedUsdc` is the amount; the pauses
 * and the allowlist are checked again, under its row lock, immediately
 * before the quote is paid.
 */
export function payThroughQuote(
  payout: Payout,
  organizationId: string,
): Effect.Effect<Payout, DatabaseError, OnchainDeps> {
  if (payout.organizationId !== organizationId) {
    return Effect.dieMessage(
      `payout ${payout.id} belongs to another organisation`,
    );
  }
  return deliverUsdcPayout(payout);
}

/**
 * Runs `work` as the only driver of this payout, here or in any other API
 * instance, or returns null at once if another is already driving it. A
 * payout is driven by the request that approved it and by the minute job;
 * without this, one could fail the payout while the other was sending it.
 */
function asOnlyDriver<A, E, R>(
  payoutId: string,
  work: Effect.Effect<A, E, R>,
): Effect.Effect<A | null, E, R | DatabaseService> {
  return Effect.scoped(
    Effect.gen(function* () {
      const { pool } = yield* DatabaseService;
      const client = yield* Effect.acquireRelease(
        Effect.promise(() => pool.connect()),
        (connection) => Effect.sync(() => connection.release()),
      );
      const { rows } = yield* Effect.promise(() =>
        client.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock($1, hashtext($2)) AS locked",
          [DRIVE_LOCK_CLASS, payoutId],
        ),
      );
      if (!rows[0]?.locked) return null;
      return yield* work.pipe(
        Effect.ensuring(
          Effect.promise(() =>
            client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [
              DRIVE_LOCK_CLASS,
              payoutId,
            ]),
          ),
        ),
      );
    }),
  );
}

/** Every send saved for a payout, newest first. */
function sendsOf(
  payout: Payout,
): Effect.Effect<CompanyWalletSend[], DatabaseError, DatabaseService> {
  return withScope({ organizationId: payout.organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(companyWalletSends)
        .where(
          and(
            eq(companyWalletSends.organizationId, payout.organizationId),
            eq(companyWalletSends.sendKey, payoutSendKey(payout.id)),
          ),
        )
        .orderBy(desc(companyWalletSends.createdAt)),
    ),
  );
}

/**
 * Records a send the chain ran: the payout is `paying` and its debit is in
 * the ledger, as on Base once the wallet reported the transfer sent. The
 * hash is base58 and is stored exactly as the chain gave it.
 */
function recordSent(
  payout: Payout,
  sent: { readonly txHash: string; readonly blockHeight: bigint },
): Effect.Effect<Payout, DatabaseError, DatabaseService | AuditLog> {
  const { id, organizationId } = payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [paying] = yield* query(() =>
        tx
          .update(payouts)
          .set({ status: "paying", txHash: sent.txHash })
          .where(and(eq(payouts.id, id), eq(payouts.status, "funding")))
          .returning(),
      );
      if (!paying) {
        const [current] = yield* query(() =>
          tx.select().from(payouts).where(eq(payouts.id, id)),
        );
        return current ?? (yield* Effect.dieMessage(`payout ${id} vanished`));
      }
      const amount = paying.amountToTransferUsdc ?? paying.quotedUsdc;
      yield* query(() =>
        tx.insert(walletTransactions).values({
          organizationId,
          walletId: paying.walletId,
          type: paying.subjectType === "withdrawal" ? "withdrawal" : "payout",
          chain: "near",
          usdcAmount: -amount,
          txHash: sent.txHash,
          blockNumber: sent.blockHeight,
          counterpartyAddress: paying.depositAddress,
          payoutId: id,
        }),
      );
      yield* audit.record(tx, {
        actor: ENGINE,
        organizationId,
        action: "payout.funded",
        entity: { type: "payout", id },
        after: { status: paying.status, txHash: sent.txHash, amount },
      });
      yield* applyPayoutOutcome(tx, paying);
      return paying;
    }),
  );
}

interface Driven {
  readonly payout: Payout;
  /** The company wallet is sending something else: its other payouts wait too. */
  readonly walletBusy: boolean;
}

const settled = (payout: Payout): Driven => ({ payout, walletBusy: false });

/**
 * Builds and relays the payout's send. Called only when no send for it is
 * signed or has run, so everything that ends it here as `failed` is known
 * to have moved nothing.
 */
function attemptSend(
  payout: Payout,
): Effect.Effect<Driven, DatabaseError, OnchainDeps> {
  const { organizationId } = payout;
  return Effect.gen(function* () {
    const to = payout.depositAddress;
    const amount = payout.amountToTransferUsdc;
    if (payout.recipient.method !== "usdc" || to === null || amount === null) {
      return yield* Effect.dieMessage(
        `payout ${payout.id} has nothing to send`,
      );
    }
    const recipient = payout.recipient;

    // The payout may have waited its turn for a while: what the funding
    // barrier checked is checked again before anything is signed.
    const blocked = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        if (yield* isPaused(tx, organizationId)) {
          return "Payouts were paused. Nothing was sent.";
        }
        return (yield* isAllowlisted(tx, organizationId, recipient))
          ? null
          : "The address was removed from the allowlist. Nothing was sent.";
      }),
    );
    if (blocked !== null) return settled(yield* fail(payout, blocked));

    const prepared = yield* prepareRecipient(to).pipe(Effect.either);
    if (prepared._tag === "Left") {
      const waited =
        Date.now() - (payout.fundingStartedAt?.getTime() ?? Date.now());
      console.warn(
        `[payout] couldn't prepare ${to} to receive payout ${payout.id}`,
        prepared.left.message,
      );
      return settled(
        waited > FUNDING_STUCK_MS
          ? yield* fail(
              payout,
              `${to} couldn't be registered to receive USDC on NEAR. Nothing was sent.`,
            )
          : yield* wait(payout),
      );
    }
    if (prepared.right !== null) {
      return settled(yield* fail(payout, prepared.right));
    }

    const sent = yield* sendUsdcFromCompanyWallet({
      organizationId,
      sendKey: payoutSendKey(payout.id),
      to,
      amount,
    }).pipe(Effect.either);
    if (sent._tag === "Right") {
      return settled(yield* recordSent(payout, sent.right));
    }

    const failure = sent.left;
    switch (failure._tag) {
      case "DatabaseError":
        return yield* Effect.fail(failure);
      case "CompanyWalletBusy":
        return { payout: yield* wait(payout), walletBusy: true };
      case "SendOutcomeUnknown":
        // Signed, and the chain doesn't say yet. The job reads its outcome;
        // nothing here may send again.
        return settled(yield* wait(payout));
      case "PrivyWalletError":
      case "NearRpcError":
        // It stopped before anything was signed, so nothing can have moved.
        console.warn(
          `[payout] payout ${payout.id} wasn't sent and will be tried again`,
          failure.message,
        );
        return settled(yield* wait(payout));
      case "SendRefused": {
        const [latest] = yield* sendsOf(payout);
        // A send that expired while it was being relayed is refused too,
        // and is proven never to have run: the payout takes another turn.
        if (latest?.status === "expired") return settled(yield* wait(payout));
        // Refused for not matching a send this payout already has, which
        // may have run: that is for a person, never a failure.
        if (
          latest?.status === "reserved" ||
          latest?.status === "signed" ||
          latest?.status === "executed"
        ) {
          return settled(
            yield* review(
              payout,
              "The company wallet already has a send for this payout that doesn't match it. Check the chain before doing anything; never send again.",
            ),
          );
        }
        const reason =
          latest?.status === "failed"
            ? RAN_EMPTY
            : `The wallet refused the transfer${failure.policyViolation ? " (it is over the wallet's per-transaction maximum)" : ""}`;
        return settled(yield* fail(payout, `${reason}. Nothing was sent.`));
      }
    }
  });
}

/**
 * Takes a NEAR payout in `funding` as far as it can go now, as its only
 * driver. What the saved send says decides everything:
 *
 * - it ran: the payout is `paying` and debited;
 * - signed and not final: it waits, and is never sent again; past
 *   `SEND_UNCLEAR_AFTER_MS` without an answer it is `needs_review`;
 * - the chain ran it without moving USDC, or it was refused: `failed`;
 * - none yet, unsigned, or expired unrun: it is sent (again), which is safe
 *   because nothing was ever signed or what was signed can no longer run.
 */
function driveNearPayout(
  organizationId: string,
  payoutId: string,
): Effect.Effect<Driven | null, DatabaseError, OnchainDeps> {
  return asOnlyDriver(
    payoutId,
    Effect.gen(function* () {
      const [payout] = yield* withScope({ organizationId }, (tx) =>
        query(() => tx.select().from(payouts).where(eq(payouts.id, payoutId))),
      );
      if (!payout) {
        return yield* Effect.dieMessage(`payout ${payoutId} vanished`);
      }
      if (payout.status !== "funding") return settled(payout);

      const sends = yield* sendsOf(payout);
      const [newest] = sends;
      if (newest === undefined) return yield* attemptSend(payout);

      const unclear = (since: Date) =>
        Date.now() - since.getTime() > SEND_UNCLEAR_AFTER_MS
          ? review(payout, UNKNOWN_OUTCOME)
          : wait(payout);

      const read = yield* settleCompanyWalletSend({
        organizationId,
        sendKey: payoutSendKey(payout.id),
      }).pipe(Effect.either);
      if (read._tag === "Left") {
        if (read.left._tag === "DatabaseError") {
          return yield* Effect.fail(read.left);
        }
        return settled(yield* unclear(newest.createdAt));
      }

      const send = read.right ?? newest;
      switch (send.status) {
        case "executed":
          return send.txHash !== null && send.blockHeight !== null
            ? settled(
                yield* recordSent(payout, {
                  txHash: send.txHash,
                  blockHeight: send.blockHeight,
                }),
              )
            : yield* Effect.dieMessage("an executed send has no transaction");
        case "signed":
          return settled(yield* unclear(send.createdAt));
        case "failed":
          return settled(
            yield* fail(payout, `${RAN_EMPTY}. Nothing was sent.`),
          );
        case "refused":
          return settled(
            yield* fail(
              payout,
              "The wallet refused the transfer. Nothing was sent.",
            ),
          );
        case "expired":
          if (sends.length >= MAX_SEND_ATTEMPTS) {
            return settled(
              yield* fail(
                payout,
                `The transfer expired ${sends.length} times before the chain ran it. Nothing was sent.`,
              ),
            );
          }
          return yield* attemptSend(payout);
        case "reserved":
          return yield* attemptSend(payout);
      }
    }),
  );
}

/**
 * Funds an approved USDC payout. Under the payout's row lock it re-checks
 * the pauses and that the address is still on the allowlist, and records
 * that funding started; then the payout is sent with a company wallet send
 * whose key is the payout's, so no retry can ever build a second one.
 *
 * - The wallet refuses (over its cap included), or the payee can't hold
 *   USDC: `failed`, nothing sent.
 * - The send ran: `paying`, debited; the minute job marks it `paid` from
 *   the chain.
 * - The outcome is unclear, or the wallet is busy with another send: it
 *   stays `funding` and the minute job follows it. It is never re-sent
 *   while a signed send could still run.
 *
 * A payee on another chain, or any payee of a company whose USDC is kept in
 * a confidential account, is paid through a quote instead (`payThroughQuote`).
 * The route is chosen here, once: a payout already sent directly is
 * followed by its saved send whatever the company's balance home is now.
 */
export function fundOnchainPayout(input: {
  readonly organizationId: string;
  readonly payoutId: string;
}): Effect.Effect<Payout, DatabaseError, OnchainDeps> {
  const { organizationId, payoutId } = input;
  const scope = { organizationId };

  return Effect.gen(function* () {
    const audit = yield* AuditLog;

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
            payout,
            reason: "Payouts were paused. Nothing was sent.",
          } as const;
        }
        if (!(yield* isAllowlisted(tx, organizationId, payout.recipient))) {
          return {
            kind: "fail",
            payout,
            reason:
              "The address was removed from the allowlist. Nothing was sent.",
          } as const;
        }
        const [wallet] = yield* query(() =>
          tx
            .select({
              privyWalletId: wallets.privyWalletId,
              balanceHome: wallets.balanceHome,
            })
            .from(wallets)
            .where(eq(wallets.id, payout.walletId)),
        );
        if (
          payout.recipient.chain !== "near" ||
          wallet?.balanceHome === "confidential_account"
        ) {
          return { kind: "quote", payout } as const;
        }
        if (!wallet?.privyWalletId) {
          return {
            kind: "fail",
            payout,
            reason: "The company wallet isn't active.",
          } as const;
        }
        const address = payout.recipient.address;
        const [funding] = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: "funding",
              fundingStartedAt: new Date(),
              depositAddress: address,
              amountToTransferUsdc: payout.quotedUsdc,
            })
            .where(eq(payouts.id, payoutId))
            .returning(),
        );
        if (!funding) {
          return yield* Effect.dieMessage(`payout ${payoutId} vanished`);
        }
        yield* applyPayoutOutcome(tx, funding);
        yield* audit.record(tx, {
          actor: ENGINE,
          organizationId,
          action: "payout.funding_started",
          entity: { type: "payout", id: payoutId },
          after: { to: address, amount: payout.quotedUsdc },
        });
        return { kind: "send", payout: funding } as const;
      }),
    );
    switch (barrier.kind) {
      case "not_ready":
        return yield* Effect.dieMessage(
          `payout ${payoutId} is not ready to fund`,
        );
      case "fail":
        return yield* fail(barrier.payout, barrier.reason);
      case "quote":
        return yield* payThroughQuote(barrier.payout, organizationId);
      case "send": {
        const driven = yield* driveNearPayout(organizationId, payoutId);
        return driven?.payout ?? barrier.payout;
      }
    }
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

const NOT_AS_EXPECTED = "The transaction didn't move the expected USDC.";

const forReview = (reason: string): Confirmation => ({
  status: "needs_review",
  action: "payout.needs_review",
  reason,
});

/**
 * What Base says about a USDC payout sent from a company wallet there,
 * before NEAR became the main chain: paid when its transaction succeeded
 * and moved exactly the amount to exactly the address; anything else is
 * for a person. Null while there's nothing to decide yet.
 */
function baseConfirmationFor(
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
      ? forReview(
          `The transfer has no confirmed hash${payout.privyTransactionId ? ` (Privy transaction ${payout.privyTransactionId})` : ""}. Check the chain before doing anything.`,
        )
      : null;
  }
  if (!receipt) return null;
  const moved = usdcTransfersIn(receipt).some(
    (transfer) =>
      transfer.from === walletAddress.toLowerCase() &&
      transfer.to === payout.depositAddress?.toLowerCase() &&
      transfer.amount === payout.amountToTransferUsdc,
  );
  if (moved) return { status: "paid", action: "payout.paid" };
  return forReview(
    receipt.status === "0x1"
      ? NOT_AS_EXPECTED
      : "The transfer reverted on chain, but the ledger shows it as sent.",
  );
}

/**
 * What NEAR says about a payout recorded as sent: paid only when the saved
 * send ran in the payout's transaction and that transaction's USDC transfer
 * is from the company wallet, to the payee, for the amount. Account IDs and
 * hashes are compared exactly: NEAR's are case-sensitive.
 */
function nearConfirmationFor(
  payout: Payout,
  walletAddress: string,
): Effect.Effect<
  Confirmation | null,
  NearRpcError | DatabaseError,
  DatabaseService | NearRpc | NearRelayer | NearChain
> {
  return Effect.gen(function* () {
    const rpc = yield* NearRpc;
    const relayer = yield* NearRelayer;
    const chain = yield* NearChain;
    const txHash = payout.txHash;
    if (txHash === null) {
      return forReview(
        "The payout is recorded as sent but has no transaction.",
      );
    }
    const send = yield* settleCompanyWalletSend({
      organizationId: payout.organizationId,
      sendKey: payoutSendKey(payout.id),
    }).pipe(
      Effect.catchTag("SendOutcomeUnknown", () => Effect.succeed(undefined)),
    );
    if (send === undefined) return null;
    if (send?.status !== "executed" || send.txHash !== txHash) {
      return forReview(
        "The company wallet's saved send doesn't show this payout's transaction as run.",
      );
    }
    const outcome = yield* rpc.transactionOutcome(txHash, relayer.accountId);
    if (outcome === null) return null;
    const moved =
      outcome.succeeded &&
      nearUsdcTransfersIn(outcome, chain.usdcContractId).some(
        (transfer) =>
          transfer.from === walletAddress &&
          transfer.to === payout.depositAddress &&
          transfer.amount === payout.amountToTransferUsdc,
      );
    return moved
      ? { status: "paid", action: "payout.paid" }
      : forReview(NOT_AS_EXPECTED);
  });
}

export interface ConfirmSummary {
  readonly checked: number;
  readonly confirmed: number;
  /** Payouts that were waiting their turn and were sent in this run. */
  readonly sent: number;
  readonly errors: number;
}

function applyConfirmation(
  payout: Payout,
  confirmation: Confirmation | null,
  now: number,
): Effect.Effect<boolean, DatabaseError, DatabaseService | AuditLog> {
  const { organizationId } = payout;
  return withScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
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
            and(eq(payouts.id, payout.id), eq(payouts.status, payout.status)),
          )
          .returning(),
      );
      if (!updated) return false;
      yield* applyPayoutOutcome(tx, updated);
      yield* audit.record(tx, {
        actor: CONFIRMER,
        organizationId,
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
}

export interface Followed {
  readonly confirmed: boolean;
  /** It was waiting for its turn, or for a new send, and went out now. */
  readonly sent: boolean;
}

const NOTHING_NEW: Followed = { confirmed: false, sent: false };

/**
 * Follows one USDC payout that is `funding` or `paying`, as the minute job
 * does. `busyWallets` collects company wallets found sending something
 * else, so their other waiting payouts aren't tried in the same pass.
 */
export function followOnchainPayout(
  ref: { readonly organizationId: string; readonly payoutId: string },
  busyWallets = new Set<string>(),
): Effect.Effect<
  Followed,
  DatabaseError | NearRpcError | BaseRpcError,
  OnchainDeps | BaseRpc
> {
  const { organizationId, payoutId } = ref;
  return Effect.gen(function* () {
    const [row] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select({ payout: payouts, walletAddress: wallets.address })
          .from(payouts)
          .innerJoin(wallets, eq(wallets.id, payouts.walletId))
          .where(eq(payouts.id, payoutId)),
      ),
    );
    // A payout delivered to another chain is followed by its quote.
    if (
      !row?.walletAddress ||
      row.payout.provider !== "onchain" ||
      row.payout.deliveryQuoteId !== null
    ) {
      return NOTHING_NEW;
    }
    const { walletAddress } = row;
    let payout = row.payout;
    if (payout.status !== "funding" && payout.status !== "paying") {
      return NOTHING_NEW;
    }

    const onNear =
      payout.recipient.method === "usdc" && payout.recipient.chain === "near";
    if (!onNear) {
      const baseRpc = yield* BaseRpc;
      const receipt = payout.txHash
        ? yield* baseRpc.getTransactionReceipt(payout.txHash)
        : null;
      const now = Date.now();
      const confirmed = yield* applyConfirmation(
        payout,
        baseConfirmationFor(payout, walletAddress, receipt, now),
        now,
      );
      return { confirmed, sent: false };
    }

    let sent = false;
    if (payout.status === "funding") {
      if (busyWallets.has(payout.walletId)) return NOTHING_NEW;
      const driven = yield* driveNearPayout(organizationId, payout.id);
      if (driven === null) return NOTHING_NEW;
      if (driven.walletBusy) busyWallets.add(payout.walletId);
      payout = driven.payout;
      sent = payout.status === "paying";
    }
    if (payout.status !== "paying") return { confirmed: false, sent };
    const confirmed = yield* applyConfirmation(
      payout,
      yield* nearConfirmationFor(payout, walletAddress),
      Date.now(),
    );
    return { confirmed, sent };
  });
}

/**
 * The minute job for USDC payouts. For a payee on NEAR it sends the payouts
 * that were waiting for the company wallet, one after another, reads what
 * became of sends whose outcome was unclear, and marks a sent payout `paid`
 * once the chain shows its transfer. It never relays a signed send again,
 * and builds a new one only when the last is proven never to have run.
 *
 * A payout sent from Base before the move is still confirmed from its Base
 * receipt, which only reads.
 */
export function confirmOnchainPayouts(
  maxRows = 50,
): Effect.Effect<ConfirmSummary, DatabaseError, OnchainDeps | BaseRpc> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<PayoutRef>(
          sql`SELECT payout_id, organization_id FROM onchain_payouts_to_confirm(${maxRows})`,
        ),
      ),
    );

    let confirmed = 0;
    let sent = 0;
    let errors = 0;
    const busyWallets = new Set<string>();
    for (const ref of rows) {
      const exit = yield* Effect.exit(
        followOnchainPayout(
          { organizationId: ref.organization_id, payoutId: ref.payout_id },
          busyWallets,
        ),
      );
      if (Exit.isSuccess(exit)) {
        if (exit.value.confirmed) confirmed += 1;
        if (exit.value.sent) sent += 1;
      } else {
        errors += 1;
        console.error(
          `[confirm-onchain] payout ${ref.payout_id} failed to confirm`,
          Cause.pretty(exit.cause),
        );
      }
    }
    return { checked: rows.length, confirmed, sent, errors };
  });
}
