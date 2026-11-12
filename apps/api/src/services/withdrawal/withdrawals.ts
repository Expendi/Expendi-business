import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { PayeeChain } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type { ApprovalChallenge } from "../approval/passkeys.js";
import type { PayoutEngineDeps } from "../payout/payout-service.js";
import type { PrepareError } from "../payout/prepare.js";
import {
  payouts,
  wallets,
  webauthnChallenges,
  withdrawalAddresses,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { fromMicro } from "../paycrest/amounts.js";
import { isPaused } from "../payout/guards.js";
import { PayoutRejected } from "../payout/payout-errors.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../payout/payout-service.js";
import { availableUsdc } from "../wallet/ledger.js";

/**
 * Withdrawals (spec §6.9): the admin moves the company's USDC to an address
 * on its allowlist, confirmed with their passkey. A withdrawal is a payout
 * with subject `withdrawal` (provider `onchain`), so it gets every guard a
 * USDC payee has: the allowlist checked at preparation, at approval (under
 * the wallet lock) and at the funding barrier; a passkey challenge bound by
 * hash to the address and amount; the balance net of reservations; both
 * pauses; the per-transaction cap; one send; and on-chain confirmation.
 * To a NEAR account it leaves the company wallet directly, like a payout to
 * a USDC payee there (services/payout/onchain.ts).
 */

export interface WithdrawalView {
  readonly id: string;
  readonly chain: PayeeChain;
  readonly address: string;
  readonly label: string;
  readonly amountUsdc: bigint;
  readonly status: Payout["status"];
  readonly txHash: string | null;
  readonly failureReason: string | null;
}

export interface WithdrawalChallenge extends ApprovalChallenge {
  readonly withdrawal: WithdrawalView;
}

const reject = (reason: PayoutRejected["reason"], message: string) =>
  Effect.fail(new PayoutRejected({ reason, message }));

const notFound = new NotFound({ message: "That withdrawal wasn't found." });

function toView(payout: Payout): Effect.Effect<WithdrawalView> {
  const { recipient } = payout;
  if (payout.subjectType !== "withdrawal" || recipient.method !== "usdc") {
    return Effect.dieMessage(`payout ${payout.id} isn't a withdrawal`);
  }
  return Effect.succeed({
    id: payout.id,
    chain: recipient.chain,
    address: recipient.address,
    label: recipient.accountName,
    amountUsdc: payout.quotedUsdc,
    status: payout.status,
    txHash: payout.txHash,
    failureReason: payout.failureReason,
  });
}

/**
 * Prepares a withdrawal and returns the passkey challenge for exactly it.
 * `requestId` is the app's ID for this withdrawal: sending it again returns
 * the same withdrawal, never a second one.
 */
export function requestWithdrawal(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly addressId: string;
  readonly amountUsdc: bigint;
}): Effect.Effect<
  WithdrawalChallenge,
  PrepareError | Forbidden,
  PayoutEngineDeps
> {
  const { organizationId, userId, amountUsdc } = input;
  return Effect.gen(function* () {
    if (amountUsdc <= 0n) {
      return yield* reject("invalid_amount", "Enter an amount to withdraw.");
    }

    // Early answers so the admin isn't asked for their passkey in vain;
    // approval checks all of this again under the wallet lock.
    const destination = yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        if (yield* isPaused(tx, organizationId)) {
          return yield* reject(
            "paused",
            "Payouts and withdrawals are paused for this company.",
          );
        }
        const [listed] = yield* query(() =>
          tx
            .select({
              chain: withdrawalAddresses.chain,
              address: withdrawalAddresses.address,
              label: withdrawalAddresses.label,
            })
            .from(withdrawalAddresses)
            .where(
              and(
                eq(withdrawalAddresses.id, input.addressId),
                eq(withdrawalAddresses.organizationId, organizationId),
                isNull(withdrawalAddresses.removedAt),
              ),
            ),
        );
        if (!listed) {
          return yield* reject(
            "not_allowlisted",
            "That address isn't on the company's allowlist.",
          );
        }
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
        if (!wallet) {
          return yield* reject("no_wallet", "This company has no wallet yet.");
        }
        const available = yield* availableUsdc(tx, wallet.id);
        if (amountUsdc > available) {
          return yield* reject(
            "insufficient_balance",
            `The wallet has ${fromMicro(available > 0n ? available : 0n)} USDC available to withdraw.`,
          );
        }
        return listed;
      }),
    );

    const [payout] = yield* preparePayouts({
      organizationId,
      actor: { type: "user", id: userId },
      requests: [
        {
          subjectType: "withdrawal",
          subjectId: input.requestId,
          idempotencyKey: `withdrawal:${input.requestId}`,
          recipient: {
            method: "usdc",
            chain: destination.chain,
            address: destination.address,
            accountName: destination.label,
          },
          amountUsdc,
        },
      ],
    });
    if (!payout) return yield* Effect.dieMessage("withdrawal prepared nothing");

    const challenge = yield* requestPayoutApproval({
      organizationId,
      userId,
      payoutIds: [payout.id],
    });
    return {
      challengeId: challenge.challengeId,
      options: challenge.options,
      withdrawal: yield* toView(payout),
    };
  });
}

/** The withdrawal a payout-approval challenge was issued for, if it's one. */
function withdrawalOfChallenge(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly challengeId: string;
}): Effect.Effect<Payout, NotFound | DatabaseError, DatabaseService> {
  const { organizationId, userId } = input;
  return withScope({ organizationId, userId }, (tx) =>
    Effect.gen(function* () {
      const [challenge] = yield* query(() =>
        tx
          .select({ payoutIds: webauthnChallenges.payoutIds })
          .from(webauthnChallenges)
          .where(
            and(
              eq(webauthnChallenges.id, input.challengeId),
              eq(webauthnChallenges.userId, userId),
              eq(webauthnChallenges.organizationId, organizationId),
              eq(webauthnChallenges.purpose, "approve_payouts"),
            ),
          ),
      );
      const payoutIds = challenge?.payoutIds ?? [];
      if (payoutIds.length !== 1) return yield* Effect.fail(notFound);
      const [payout] = yield* query(() =>
        tx
          .select()
          .from(payouts)
          .where(
            and(
              inArray(payouts.id, payoutIds),
              eq(payouts.organizationId, organizationId),
            ),
          ),
      );
      if (payout?.subjectType !== "withdrawal") {
        return yield* Effect.fail(notFound);
      }
      return payout;
    }),
  );
}

/**
 * Approves the withdrawal with the admin's passkey assertion and sends it,
 * once. Returns where it stands: `paying` once sent (the confirm job marks
 * it `paid` from the chain), `failed` with nothing sent, or `funding` while
 * it waits for the company wallet to finish another send or for the chain
 * to say what became of its own, which the confirm job follows.
 */
export function confirmWithdrawal(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}): Effect.Effect<
  WithdrawalView,
  PayoutRejected | Forbidden | NotFound | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const withdrawal = yield* withdrawalOfChallenge(input);
    yield* approveAndPay(input);
    const [current] = yield* withScope(
      { organizationId: input.organizationId },
      (tx) =>
        query(() =>
          tx.select().from(payouts).where(eq(payouts.id, withdrawal.id)),
        ),
    );
    if (!current) return yield* Effect.dieMessage("withdrawal vanished");
    return yield* toView(current);
  });
}
