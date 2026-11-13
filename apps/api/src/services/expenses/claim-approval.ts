import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { ExpenseStatus } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { ApprovalChallenge } from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { WalletCover } from "../payments/payment-approval.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import type { PayoutEngineDeps } from "../payout/payout-service.js";
import type { PrepareError } from "../payout/prepare.js";
import {
  expenses,
  memberships,
  payouts,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import {
  awaitingPayoutFor,
  challengePayouts,
  costOf,
  topUpConflict,
  walletCover,
} from "../payments/payment-approval.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
  retryPayout,
} from "../payout/payout-service.js";
import { requireConfirmedPayoutPhone } from "../phone-verification/payout-phone.js";

export { topUpKesFor } from "../payments/payment-approval.js";

/**
 * Approve & pay and its retry (spec §6.7, §6.8): the admin's passkey
 * approves the claims' payouts through the payout engine, which moves each
 * claim to `paying` in the approval's own transaction (see
 * `claim-payout-hooks.ts`). Every guard the engine has applies.
 *
 * A claim has at most one payout that hasn't failed. Its idempotency key is
 * `claim:<claimId>:<n>`, where n is one more than the claim's failed
 * payouts, so preparing again returns the same payout and only a failure
 * (or a discarded, never-approved payout) moves the key on.
 */

const claimNotFound = new NotFound({ message: "Claim not found" });
const approvalNotFound = new NotFound({
  message: "That approval wasn't found. Start Approve & pay again.",
});

const NOT_EXPECTED: Readonly<Record<"submitted" | "payout_failed", string>> = {
  submitted: "This claim isn't waiting for approval.",
  payout_failed: "Only a claim whose payment failed can be retried.",
};

const REPLACED =
  "Replaced before approval: the claim or its payout number changed. Nothing was sent.";

/** A claim ready to be paid, with the confirmed number it's paid to. */
interface PayableClaim {
  readonly claimId: string;
  readonly status: ExpenseStatus;
  readonly amountKes: bigint;
  readonly latestPayoutId: string | null;
  readonly recipient: {
    readonly method: "mpesa_phone";
    readonly phone: string;
    readonly accountName: string;
  };
}

function readPayableClaim(
  tx: Transaction,
  organizationId: string,
  claimId: string,
  expected: "submitted" | "payout_failed",
): Effect.Effect<PayableClaim, NotFound | Conflict | DatabaseError> {
  return Effect.gen(function* () {
    const [claim] = yield* query(() =>
      tx
        .select({
          status: expenses.status,
          amountKes: expenses.amountKes,
          payoutId: expenses.payoutId,
          userId: memberships.userId,
          fullName: users.fullName,
          email: users.email,
        })
        .from(expenses)
        .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(
          and(
            eq(expenses.id, claimId),
            eq(expenses.organizationId, organizationId),
            eq(expenses.kind, "claim"),
          ),
        ),
    );
    if (!claim) return yield* Effect.fail(claimNotFound);
    if (claim.status !== expected) {
      return yield* Effect.fail(
        new Conflict({ message: NOT_EXPECTED[expected] }),
      );
    }
    const who = claim.fullName ?? claim.email;
    const phone = yield* requireConfirmedPayoutPhone(tx, claim.userId).pipe(
      Effect.catchTag("PayoutPhoneNotConfirmed", () =>
        Effect.fail(
          new Conflict({
            message: `${who} hasn't confirmed an M-Pesa number yet. Approve & pay is blocked until they do.`,
          }),
        ),
      ),
    );
    const accountName = claim.fullName?.trim();
    if (!accountName) {
      return yield* Effect.fail(
        new Conflict({
          message: `Add ${who}'s full name before paying them: we pay M-Pesa in the recipient's name.`,
        }),
      );
    }
    return {
      claimId,
      status: claim.status,
      amountKes: claim.amountKes,
      latestPayoutId: claim.payoutId,
      recipient: { method: "mpesa_phone", phone, accountName },
    };
  });
}

const pays = (payout: Payout, claim: PayableClaim): boolean =>
  payout.requestedKesCents === claim.amountKes &&
  payout.payrollRunId === null &&
  payout.recipient.method === "mpesa_phone" &&
  payout.recipient.phone === claim.recipient.phone &&
  payout.recipient.accountName === claim.recipient.accountName;

/**
 * The claim's payout awaiting approval (`awaitingPayoutFor`). A claim whose
 * payment failed is paid by a retry of that payout, to the claimant's
 * current number.
 */
function payoutFor(
  organizationId: string,
  actor: AuditActor,
  claim: PayableClaim,
): Effect.Effect<Payout, PrepareError | Conflict, PayoutEngineDeps> {
  return awaitingPayoutFor({
    organizationId,
    actor,
    subjectType: "claim",
    subjectId: claim.claimId,
    keyPrefix: "claim",
    pays: (payout) => pays(payout, claim),
    replaced: REPLACED,
    alreadyPaying: "This claim is already being paid.",
    prepare: (idempotencyKey) =>
      Effect.gen(function* () {
        if (claim.status === "payout_failed") {
          if (!claim.latestPayoutId) {
            return yield* Effect.dieMessage(
              `claim ${claim.claimId} failed without a payout`,
            );
          }
          return yield* retryPayout({
            organizationId,
            failedPayoutId: claim.latestPayoutId,
            idempotencyKey,
            actor,
            recipient: claim.recipient,
          });
        }
        const [prepared] = yield* preparePayouts({
          organizationId,
          actor,
          requests: [
            {
              subjectType: "claim",
              subjectId: claim.claimId,
              idempotencyKey,
              recipient: claim.recipient,
              amountKesCents: claim.amountKes,
            },
          ],
        });
        if (!prepared) {
          return yield* Effect.dieMessage("claim prepared nothing");
        }
        return prepared;
      }),
  });
}

export interface ClaimPaymentPreviewView {
  readonly claimId: string;
  readonly payoutId: string;
  readonly claimantName: string;
  readonly phoneLast4: string;
  readonly claimedKes: bigint;
  readonly receivesKes: bigint;
  readonly rate: string;
  readonly usdc: bigint;
  readonly feeAllowanceUsdc: bigint;
  readonly maxDebitUsdc: bigint;
}

export interface ClaimApprovalView {
  readonly challengeId: string;
  readonly options: ApprovalChallenge["options"];
  readonly claims: readonly ClaimPaymentPreviewView[];
  readonly totals: {
    readonly receivesKes: bigint;
    readonly usdc: bigint;
    readonly feeAllowanceUsdc: bigint;
    readonly maxDebitUsdc: bigint;
  };
  readonly wallet: WalletCover;
}

function previewOf(payout: Payout): ClaimPaymentPreviewView {
  const { recipient } = payout;
  return {
    claimId: payout.subjectId,
    payoutId: payout.id,
    claimantName: recipient.accountName,
    phoneLast4:
      recipient.method === "mpesa_phone" ? recipient.phone.slice(-4) : "",
    claimedKes: payout.requestedKesCents,
    receivesKes: payout.amountKes,
    ...costOf(payout),
  };
}

/**
 * Prepares each payout and returns one passkey challenge for all of them,
 * with the cost the admin confirms: what each person receives, the USDC,
 * the most the fee can add, and whether the wallet covers it.
 */
function approvalFor(
  tenant: Tenant,
  claims: readonly PayableClaim[],
): Effect.Effect<
  ClaimApprovalView,
  PrepareError | Conflict | Forbidden,
  PayoutEngineDeps
> {
  const actor = { type: "user", id: tenant.userId } as const;
  return Effect.gen(function* () {
    const batch: Payout[] = [];
    for (const claim of claims) {
      batch.push(yield* payoutFor(tenant.organizationId, actor, claim));
    }
    const challenge = yield* requestPayoutApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      payoutIds: batch.map((payout) => payout.id),
    });
    const previews = batch.map(previewOf);
    const sum = (pick: (preview: ClaimPaymentPreviewView) => bigint) =>
      previews.reduce((total, preview) => total + pick(preview), 0n);
    const totals = {
      receivesKes: sum((preview) => preview.receivesKes),
      usdc: sum((preview) => preview.usdc),
      feeAllowanceUsdc: sum((preview) => preview.feeAllowanceUsdc),
      maxDebitUsdc: sum((preview) => preview.maxDebitUsdc),
    };
    return {
      challengeId: challenge.challengeId,
      options: challenge.options,
      claims: previews,
      totals,
      wallet: yield* walletCover(tenant.organizationId, batch),
    };
  });
}

/**
 * Step one of Approve & pay for submitted claims: each must be waiting for
 * approval, and its claimant must have a confirmed M-Pesa number and a
 * name (spec §6.18). Nothing is prepared unless every claim qualifies.
 */
export function requestClaimApproval(
  tenant: Tenant,
  claimIds: readonly string[],
): Effect.Effect<
  ClaimApprovalView,
  PrepareError | Conflict | NotFound | Forbidden,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const claims = yield* withScope(tenant, (tx) =>
      Effect.forEach(claimIds, (claimId) =>
        readPayableClaim(tx, tenant.organizationId, claimId, "submitted"),
      ),
    );
    return yield* approvalFor(tenant, claims);
  });
}

/**
 * Retry after a failed payment (spec §6.8): a new payout with a new key, to
 * the claimant's current confirmed number, waiting for a fresh passkey
 * approval. Nothing is sent until the admin confirms.
 */
export function requestClaimRetry(
  tenant: Tenant,
  claimId: string,
): Effect.Effect<
  ClaimApprovalView,
  PrepareError | Conflict | NotFound | Forbidden,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const claim = yield* withScope(tenant, (tx) =>
      readPayableClaim(tx, tenant.organizationId, claimId, "payout_failed"),
    );
    return yield* approvalFor(tenant, [claim]);
  });
}

/** The claim payouts a payout-approval challenge was issued for. */
function claimPayoutsOfChallenge(
  tenant: Tenant,
  challengeId: string,
): Effect.Effect<Payout[], NotFound | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const batch = yield* challengePayouts(
      tenant,
      challengeId,
      approvalNotFound,
    );
    const claims = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ id: expenses.id })
          .from(expenses)
          .where(
            and(
              inArray(
                expenses.id,
                batch.map((payout) => payout.subjectId),
              ),
              eq(expenses.organizationId, tenant.organizationId),
              eq(expenses.kind, "claim"),
            ),
          ),
      ),
    );
    const known = new Set(claims.map((claim) => claim.id));
    if (
      batch.some(
        (payout) =>
          payout.subjectType !== "claim" || !known.has(payout.subjectId),
      )
    ) {
      return yield* Effect.fail(approvalNotFound);
    }
    return batch;
  });
}

export interface ClaimPaymentResultView {
  readonly claims: readonly {
    readonly claimId: string;
    readonly status: ExpenseStatus;
    readonly payout: {
      readonly id: string;
      readonly status: Payout["status"];
      readonly failureReason: string | null;
    };
  }[];
}

/**
 * Step two: the admin's passkey assertion approves the payouts and they're
 * funded, once. The challenge is single-use, so a second confirmation,
 * concurrent or replayed, is refused before anything moves.
 */
export function confirmClaimApproval(
  tenant: Tenant,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Effect.Effect<
  ClaimPaymentResultView,
  PayoutRejected | Conflict | NotFound | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const batch = yield* claimPayoutsOfChallenge(tenant, challengeId);
    yield* approveAndPay({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      challengeId,
      response,
    }).pipe(
      Effect.catchTag("PayoutRejected", (error) => topUpConflict(error, batch)),
    );
    const rows = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({
            claimId: expenses.id,
            status: expenses.status,
            payout: {
              id: payouts.id,
              status: payouts.status,
              failureReason: payouts.failureReason,
            },
          })
          .from(payouts)
          .innerJoin(expenses, eq(expenses.id, payouts.subjectId))
          .where(
            inArray(
              payouts.id,
              batch.map((payout) => payout.id),
            ),
          ),
      ),
    );
    return { claims: rows };
  });
}
