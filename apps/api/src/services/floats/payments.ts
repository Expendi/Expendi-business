import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { randomUUID } from "node:crypto";
import { and, count, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { FloatMovementType } from "@expendi-business/shared";
import { formatKesAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { Forbidden } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { ApprovalChallenge } from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import type { PayoutEngineDeps } from "../payout/payout-service.js";
import type { PrepareError } from "../payout/prepare.js";
import type { FloatMovementView, FloatSummaryView } from "./views.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import {
  floatMovements,
  floats,
  memberships,
  payouts,
  users,
  wallets,
  webauthnChallenges,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, DatabaseError, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { topUpKesFor } from "../expenses/claim-approval.js";
import { discardUnapprovedPayout } from "../payout/discard.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
  retryPayout,
} from "../payout/payout-service.js";
import { requireConfirmedPayoutPhone } from "../phone-verification/payout-phone.js";
import { ledgerBalance, reservedForPayouts } from "../wallet/ledger.js";
import {
  floatNotFound,
  readFloatSummary,
  readMovement,
  visibleFloats,
} from "./views.js";

/**
 * Issuing and topping up a float (spec §6.22, §7): each is a payout to the
 * holder's confirmed M-Pesa through the payout engine, confirmed with the
 * admin's passkey, under the daily cap like any claim. The movement exists
 * from the moment its payout is prepared, `pending` and linked to it, and
 * counts toward the balance only once the payout is `paid`
 * (`float-payout-hooks.ts`).
 *
 * The payout's subject is the movement, so each issue and top-up is paid
 * at most once. Its idempotency key is `float:<movementId>:<n>`, n being one
 * more than the movement's failed payouts: preparing again returns the same
 * payout, and only a failure (or a stale payout discarded before approval)
 * moves the key on. A float has at most one pending movement, so a second
 * payment can't start while one is still waiting or on its way.
 */

const REPLACED =
  "Replaced before approval: the float payment or the holder's payout number changed. Nothing was sent.";

const approvalNotFound = new NotFound({
  message: "That approval wasn't found. Start again.",
});
const movementNotFound = new NotFound({
  message: "That float payment wasn't found.",
});
const floatClosed = new Conflict({ message: "This float is closed." });

/** Who a float pays, as their confirmed M-Pesa number and the name Paycrest pays. */
interface Holder {
  readonly membershipId: string;
  readonly userId: string;
  readonly who: string;
  readonly recipient: {
    readonly method: "mpesa_phone";
    readonly phone: string;
    readonly accountName: string;
  };
}

/**
 * The person who can hold a float: an active employee or admin with a
 * login, a confirmed M-Pesa number (spec §6.18) and a full name.
 */
function readHolder(
  tx: Transaction,
  organizationId: string,
  membershipId: string,
): Effect.Effect<Holder, NotFound | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [member] = yield* query(() =>
      tx
        .select({
          role: memberships.role,
          status: memberships.status,
          userId: memberships.userId,
          fullName: users.fullName,
          email: users.email,
        })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(memberships.organizationId, organizationId),
            eq(memberships.id, membershipId),
          ),
        ),
    );
    if (!member) {
      return yield* Effect.fail(
        new NotFound({ message: "That person isn't in the company." }),
      );
    }
    const who = member.fullName ?? member.email;
    if (member.status !== "active") {
      return yield* Effect.fail(
        new Conflict({
          message: `${who} isn't an active member of the company, so they can't hold a float.`,
        }),
      );
    }
    if (member.role === "accountant") {
      return yield* Effect.fail(
        new Conflict({ message: "Accountants can't hold a float." }),
      );
    }
    const phone = yield* requireConfirmedPayoutPhone(tx, member.userId).pipe(
      Effect.catchTag("PayoutPhoneNotConfirmed", () =>
        Effect.fail(
          new Conflict({
            message: `${who} hasn't confirmed an M-Pesa number yet, so a float can't be paid to them until they do.`,
          }),
        ),
      ),
    );
    const accountName = member.fullName?.trim();
    if (!accountName) {
      return yield* Effect.fail(
        new Conflict({
          message: `Add ${who}'s full name before paying them: Paycrest pays M-Pesa in the recipient's name.`,
        }),
      );
    }
    return {
      membershipId,
      userId: member.userId,
      who,
      recipient: { method: "mpesa_phone", phone, accountName },
    };
  });
}

const pays = (payout: Payout, amountKes: bigint, holder: Holder): boolean =>
  payout.status === "awaiting_approval" &&
  payout.requestedKesCents === amountKes &&
  payout.recipient.method === "mpesa_phone" &&
  payout.recipient.phone === holder.recipient.phone &&
  payout.recipient.accountName === holder.recipient.accountName;

const userActor = (tenant: Tenant): AuditActor => ({
  type: "user",
  id: tenant.userId,
});

/** The float, locked, if the caller can see it. */
function lockFloat(tx: Transaction, tenant: Tenant, floatId: string) {
  return query(() =>
    tx
      .select({
        id: floats.id,
        status: floats.status,
        membershipId: floats.membershipId,
      })
      .from(floats)
      .where(and(visibleFloats(tenant), eq(floats.id, floatId)))
      .for("update"),
  ).pipe(
    Effect.flatMap(([float]) =>
      float ? Effect.succeed(float) : Effect.fail(floatNotFound),
    ),
  );
}

function lockOpenFloat(tx: Transaction, tenant: Tenant, floatId: string) {
  return lockFloat(tx, tenant, floatId).pipe(
    Effect.flatMap((float) =>
      float.status === "open"
        ? Effect.succeed(float)
        : Effect.fail(floatClosed),
    ),
  );
}

/** The float's pending issue or top-up, with its payout, if it has one. */
function pendingMovementOf(tx: Transaction, floatId: string) {
  return query(() =>
    tx
      .select({
        id: floatMovements.id,
        type: floatMovements.type,
        amountKes: floatMovements.amountKes,
        payout: payouts,
      })
      .from(floatMovements)
      .innerJoin(payouts, eq(payouts.id, floatMovements.payoutId))
      .where(
        and(
          eq(floatMovements.floatId, floatId),
          eq(floatMovements.status, "pending"),
        ),
      ),
  ).pipe(Effect.map(([pending]) => pending ?? null));
}

function onItsWay(amountKes: bigint, holder: { readonly who: string }) {
  return new Conflict({
    message: `${formatKesAmount(amountKes)} is still on its way to ${holder.who}. Try again once it has arrived or failed.`,
  });
}

/** Withdraws a payout nobody approved; its movement fails with it. */
function discard(tenant: Tenant, payoutId: string) {
  return withScope(tenant, (tx) =>
    discardUnapprovedPayout(tx, {
      organizationId: tenant.organizationId,
      payoutId,
      reason: REPLACED,
      actor: userActor(tenant),
    }),
  );
}

function prepareFor(
  tenant: Tenant,
  movementId: string,
  amountKes: bigint,
  holder: Holder,
): Effect.Effect<Payout, PrepareError, PayoutEngineDeps> {
  return preparePayouts({
    organizationId: tenant.organizationId,
    actor: userActor(tenant),
    requests: [
      {
        subjectType: "float",
        subjectId: movementId,
        idempotencyKey: `float:${movementId}:1`,
        recipient: holder.recipient,
        amountKesCents: amountKes,
      },
    ],
  }).pipe(
    Effect.flatMap(([payout]) =>
      payout ? Effect.succeed(payout) : Effect.dieMessage("prepared nothing"),
    ),
  );
}

/**
 * Writes the movement for a payout just prepared. If that fails, the payout
 * is withdrawn so nothing waits for approval with no movement to follow; a
 * unique clash (a second open float or pending payment, raced in) becomes
 * `clash`.
 */
function recordOrWithdraw<A, E, R>(
  tenant: Tenant,
  payout: Payout,
  record: Effect.Effect<A, E | DatabaseError, R>,
  clash: Conflict,
): Effect.Effect<
  A,
  E | Conflict | DatabaseError,
  R | DatabaseService | AuditLog
> {
  return record.pipe(
    Effect.catchAll((error) =>
      discard(tenant, payout.id).pipe(
        Effect.zipRight(
          Effect.fail(
            error instanceof DatabaseError &&
              violatedUniqueConstraint(error.cause) !== null
              ? clash
              : error,
          ),
        ),
      ),
    ),
  );
}

/** `FloatApproval` before serialisation turns bigints and dates into strings. */
export interface FloatApprovalView {
  readonly challengeId: string;
  readonly options: ApprovalChallenge["options"];
  readonly float: FloatSummaryView;
  readonly movement: FloatMovementView;
  readonly payment: {
    readonly movementId: string;
    readonly payoutId: string;
    readonly holderName: string;
    readonly phoneLast4: string;
    readonly requestedKes: bigint;
    readonly receivesKes: bigint;
    readonly rate: string;
    readonly usdc: bigint;
    readonly feeAllowanceUsdc: bigint;
    readonly maxDebitUsdc: bigint;
  };
  readonly wallet: {
    readonly availableUsdc: bigint;
    readonly shortfallUsdc: bigint;
    readonly topUpKes: bigint | null;
  };
}

/** What the wallet has free now, for the preview; approving checks again under lock. */
function freeUsdc(tx: Transaction, organizationId: string) {
  return Effect.gen(function* () {
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
    if (!wallet) return 0n;
    const free =
      (yield* ledgerBalance(tx, wallet.id)) -
      (yield* reservedForPayouts(tx, wallet.id));
    return free > 0n ? free : 0n;
  });
}

/** One passkey challenge for the movement's payout, with what it costs. */
function approvalFor(
  tenant: Tenant,
  floatId: string,
  movementId: string,
  payout: Payout,
): Effect.Effect<
  FloatApprovalView,
  NotFound | PayoutRejected | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const challenge = yield* requestPayoutApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      payoutIds: [payout.id],
    });
    const { float, movement, available } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* readFloatSummary(tx, tenant, floatId);
        const movement = yield* readMovement(tx, tenant, floatId, movementId);
        if (!float || !movement) return yield* Effect.fail(movementNotFound);
        return {
          float,
          movement,
          available: yield* freeUsdc(tx, tenant.organizationId),
        };
      }),
    );
    const shortfall =
      payout.maxDebitUsdc > available ? payout.maxDebitUsdc - available : 0n;
    const { recipient } = payout;
    return {
      challengeId: challenge.challengeId,
      options: challenge.options,
      float,
      movement,
      payment: {
        movementId,
        payoutId: payout.id,
        holderName: recipient.accountName,
        phoneLast4:
          recipient.method === "mpesa_phone" ? recipient.phone.slice(-4) : "",
        requestedKes: payout.requestedKesCents,
        receivesKes: payout.amountKes,
        rate: payout.quotedRate,
        usdc: payout.quotedUsdc,
        feeAllowanceUsdc: payout.maxDebitUsdc - payout.quotedUsdc,
        maxDebitUsdc: payout.maxDebitUsdc,
      },
      wallet: {
        availableUsdc: available,
        shortfallUsdc: shortfall,
        topUpKes:
          shortfall > 0n ? topUpKesFor(shortfall, payout.quotedRate) : null,
      },
    };
  });
}

type PaymentError =
  PrepareError | Conflict | NotFound | Forbidden | PayoutRejected;

/**
 * Opens a float for someone and prepares its first payment (spec §6.22):
 * the float and its `issue` movement are written, pending, once the payout
 * exists. Nothing is sent until the admin confirms with their passkey.
 */
export function issueFloat(
  tenant: Tenant,
  input: { readonly membershipId: string; readonly amountKes: bigint },
): Effect.Effect<FloatApprovalView, PaymentError, PayoutEngineDeps> {
  const floatId = randomUUID();
  const movementId = randomUUID();
  return Effect.gen(function* () {
    const holder = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const holder = yield* readHolder(
          tx,
          tenant.organizationId,
          input.membershipId,
        );
        yield* refuseSecondOpenFloat(tx, tenant, holder);
        return holder;
      }),
    );
    const payout = yield* prepareFor(
      tenant,
      movementId,
      input.amountKes,
      holder,
    );
    yield* recordOrWithdraw(
      tenant,
      payout,
      withScope(tenant, (tx) =>
        Effect.gen(function* () {
          const audit = yield* AuditLog;
          yield* query(() =>
            tx.insert(floats).values({
              id: floatId,
              organizationId: tenant.organizationId,
              membershipId: holder.membershipId,
            }),
          );
          yield* query(() =>
            tx.insert(floatMovements).values({
              id: movementId,
              organizationId: tenant.organizationId,
              floatId,
              type: "issue",
              status: "pending",
              amountKes: input.amountKes,
              payoutId: payout.id,
              recordedBy: tenant.userId,
            }),
          );
          yield* audit.record(tx, {
            actor: userActor(tenant),
            organizationId: tenant.organizationId,
            action: "float.opened",
            entity: { type: "float", id: floatId },
            after: {
              membershipId: holder.membershipId,
              status: "open",
              issue: {
                movementId,
                amountKes: input.amountKes,
                payoutId: payout.id,
              },
            },
          });
        }),
      ),
      new Conflict({
        message: `${holder.who} already has an open float. Top it up instead.`,
      }),
    );
    return yield* approvalFor(tenant, floatId, movementId, payout);
  });
}

function refuseSecondOpenFloat(
  tx: Transaction,
  tenant: Tenant,
  holder: Holder,
): Effect.Effect<void, Conflict | DatabaseError> {
  return query(() =>
    tx
      .select({ id: floats.id })
      .from(floats)
      .where(
        and(
          eq(floats.organizationId, tenant.organizationId),
          eq(floats.membershipId, holder.membershipId),
          eq(floats.status, "open"),
        ),
      ),
  ).pipe(
    Effect.flatMap(([open]) =>
      open
        ? Effect.fail(
            new Conflict({
              message: `${holder.who} already has an open float. Top it up instead.`,
              details: { floatId: open.id },
            }),
          )
        : Effect.void,
    ),
  );
}

/**
 * Prepares a top-up (spec §6.22). Asking again for the same amount while
 * it waits for approval returns the same payment; a different amount
 * replaces it. One already on its way has to arrive or fail first.
 */
export function topUpFloat(
  tenant: Tenant,
  floatId: string,
  amountKes: bigint,
): Effect.Effect<FloatApprovalView, PaymentError, PayoutEngineDeps> {
  return Effect.gen(function* () {
    const { holder, pending } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* lockOpenFloat(tx, tenant, floatId);
        const holder = yield* readHolder(
          tx,
          tenant.organizationId,
          float.membershipId,
        );
        const pending = yield* pendingMovementOf(tx, floatId);
        if (pending && pending.payout.status !== "awaiting_approval") {
          return yield* Effect.fail(onItsWay(pending.amountKes, holder));
        }
        return { holder, pending };
      }),
    );
    if (pending) {
      if (
        pending.type === "top_up" &&
        pays(pending.payout, amountKes, holder)
      ) {
        return yield* approvalFor(tenant, floatId, pending.id, pending.payout);
      }
      yield* discard(tenant, pending.payout.id);
    }

    const movementId = randomUUID();
    const payout = yield* prepareFor(tenant, movementId, amountKes, holder);
    yield* recordOrWithdraw(
      tenant,
      payout,
      withScope(tenant, (tx) =>
        Effect.gen(function* () {
          const audit = yield* AuditLog;
          yield* lockOpenFloat(tx, tenant, floatId);
          yield* query(() =>
            tx.insert(floatMovements).values({
              id: movementId,
              organizationId: tenant.organizationId,
              floatId,
              type: "top_up",
              status: "pending",
              amountKes,
              payoutId: payout.id,
              recordedBy: tenant.userId,
            }),
          );
          yield* audit.record(tx, {
            actor: userActor(tenant),
            organizationId: tenant.organizationId,
            action: "float.top_up_prepared",
            entity: { type: "float_movement", id: movementId },
            after: { floatId, amountKes, payoutId: payout.id },
          });
        }),
      ),
      new Conflict({
        message:
          "Another payment to this float started at the same time. Check the float and try again.",
      }),
    );
    return yield* approvalFor(tenant, floatId, movementId, payout);
  });
}

interface PayableMovement {
  readonly id: string;
  readonly type: FloatMovementType;
  readonly amountKes: bigint;
  readonly payout: Payout;
}

function lockPayableMovement(
  tx: Transaction,
  tenant: Tenant,
  floatId: string,
  movementId: string,
): Effect.Effect<PayableMovement, NotFound | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [movement] = yield* query(() =>
      tx
        .select({
          id: floatMovements.id,
          type: floatMovements.type,
          status: floatMovements.status,
          amountKes: floatMovements.amountKes,
          payout: payouts,
        })
        .from(floatMovements)
        .innerJoin(payouts, eq(payouts.id, floatMovements.payoutId))
        .where(
          and(
            eq(floatMovements.organizationId, tenant.organizationId),
            eq(floatMovements.floatId, floatId),
            eq(floatMovements.id, movementId),
          ),
        )
        .for("update", { of: floatMovements }),
    );
    if (!movement) return yield* Effect.fail(movementNotFound);
    if (movement.status === "paid") {
      return yield* Effect.fail(
        new Conflict({ message: "This float payment was already paid." }),
      );
    }
    return movement;
  });
}

/**
 * Approve & pay for an issue or top-up that's waiting for approval, or its
 * retry after a failure (spec §6.8): a new payout with a new key, to the
 * holder's current confirmed number, waiting for a fresh passkey approval.
 * Nothing is sent until the admin confirms.
 */
export function requestMovementApproval(
  tenant: Tenant,
  floatId: string,
  movementId: string,
): Effect.Effect<FloatApprovalView, PaymentError, PayoutEngineDeps> {
  return Effect.gen(function* () {
    const { holder, movement } = yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* lockOpenFloat(tx, tenant, floatId);
        const movement = yield* lockPayableMovement(
          tx,
          tenant,
          floatId,
          movementId,
        );
        const holder = yield* readHolder(
          tx,
          tenant.organizationId,
          float.membershipId,
        );
        if (
          movement.payout.status !== "awaiting_approval" &&
          movement.payout.status !== "failed"
        ) {
          return yield* Effect.fail(onItsWay(movement.amountKes, holder));
        }
        return { holder, movement };
      }),
    );
    if (movement.payout.status === "awaiting_approval") {
      if (pays(movement.payout, movement.amountKes, holder)) {
        return yield* approvalFor(tenant, floatId, movementId, movement.payout);
      }
      yield* discard(tenant, movement.payout.id);
    }

    const failed = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ failed: count() })
          .from(payouts)
          .where(
            and(
              eq(payouts.organizationId, tenant.organizationId),
              eq(payouts.subjectType, "float"),
              eq(payouts.subjectId, movementId),
              eq(payouts.status, "failed"),
            ),
          ),
      ),
    );
    const retry = yield* retryPayout({
      organizationId: tenant.organizationId,
      failedPayoutId: movement.payout.id,
      idempotencyKey: `float:${movementId}:${(failed[0]?.failed ?? 0) + 1}`,
      actor: userActor(tenant),
      recipient: holder.recipient,
    });
    yield* recordOrWithdraw(
      tenant,
      retry,
      withScope(tenant, (tx) =>
        Effect.gen(function* () {
          const audit = yield* AuditLog;
          yield* lockOpenFloat(tx, tenant, floatId);
          const [linked] = yield* query(() =>
            tx
              .update(floatMovements)
              .set({ status: "pending", payoutId: retry.id })
              .where(
                and(
                  eq(floatMovements.id, movementId),
                  eq(floatMovements.status, "failed"),
                ),
              )
              .returning({ id: floatMovements.id }),
          );
          if (!linked) return;
          yield* audit.record(tx, {
            actor: userActor(tenant),
            organizationId: tenant.organizationId,
            action: "float.payment_retried",
            entity: { type: "float_movement", id: movementId },
            before: { status: "failed", payoutId: movement.payout.id },
            after: { status: "pending", payoutId: retry.id },
          });
        }),
      ),
      new Conflict({
        message:
          "Another payment to this float is waiting or on its way. Try again once it's done.",
      }),
    );
    return yield* approvalFor(tenant, floatId, movementId, retry);
  });
}

/** The float payout a payout-approval challenge was issued for, and its movement. */
function floatPayoutOfChallenge(
  tenant: Tenant,
  challengeId: string,
): Effect.Effect<
  {
    readonly payout: Payout;
    readonly floatId: string;
    readonly movementId: string;
  },
  NotFound | DatabaseError,
  DatabaseService
> {
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
      if (payoutIds.length !== 1) return yield* Effect.fail(approvalNotFound);
      const [row] = yield* query(() =>
        tx
          .select({
            payout: payouts,
            floatId: floatMovements.floatId,
            movementId: floatMovements.id,
          })
          .from(payouts)
          .innerJoin(floatMovements, eq(floatMovements.id, payouts.subjectId))
          .where(
            and(
              inArray(payouts.id, payoutIds),
              eq(payouts.organizationId, tenant.organizationId),
              eq(payouts.subjectType, "float"),
            ),
          ),
      );
      if (!row) return yield* Effect.fail(approvalNotFound);
      return row;
    }),
  );
}

/** "Top up KES X" (spec §6.7 step 4), at the payout's quoted rate. */
function walletTooShort(
  error: PayoutRejected,
  payout: Payout,
): Effect.Effect<never, PayoutRejected | Conflict> {
  if (error.reason !== "insufficient_balance" || !error.shortfallUsdc) {
    return Effect.fail(error);
  }
  const topUpKes = topUpKesFor(error.shortfallUsdc, payout.quotedRate);
  return Effect.fail(
    new Conflict({
      message: `The wallet is too short to pay this. Top up ${formatKesAmount(topUpKes)}, then approve again. Nothing was sent.`,
      details: {
        shortfallUsdc: error.shortfallUsdc.toString(),
        topUpKes: topUpKes.toString(),
      },
    }),
  );
}

export interface FloatPaymentResultView {
  readonly float: FloatSummaryView;
  readonly movement: FloatMovementView;
}

/**
 * The admin's passkey approves the float payment and it's funded, once.
 * The challenge is single-use, so a second confirmation, concurrent or
 * replayed, is refused before anything moves.
 */
export function confirmFloatApproval(
  tenant: Tenant,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Effect.Effect<
  FloatPaymentResultView,
  PayoutRejected | Conflict | NotFound | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const { payout, floatId, movementId } = yield* floatPayoutOfChallenge(
      tenant,
      challengeId,
    );
    yield* approveAndPay({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      challengeId,
      response,
    }).pipe(
      Effect.catchTag("PayoutRejected", (error) =>
        walletTooShort(error, payout),
      ),
    );
    return yield* withScope(tenant, (tx) =>
      Effect.gen(function* () {
        const float = yield* readFloatSummary(tx, tenant, floatId);
        const movement = yield* readMovement(tx, tenant, floatId, movementId);
        if (!float || !movement) return yield* Effect.fail(movementNotFound);
        return { float, movement };
      }),
    );
  });
}
