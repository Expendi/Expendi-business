import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type {
  PayoutStatus,
  PretiumTransactionEvidence,
  ResolveOutcome,
  WalletChain,
} from "@expendi-business/shared";
import { resolveOutcomeSchema } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type {
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { BaseRpc } from "../chain/base-rpc.js";
import type { NearRpc } from "../chain/near-rpc.js";
import type { NearChain } from "../chain/near.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { ConfirmationRefused } from "./confirmations.js";
import type { CompanyWalletSendView } from "./near-send-evidence.js";
import type {
  LedgerRow,
  PayoutEvidence,
  PretiumLookup,
} from "./payout-evidence.js";
import type { LedgerEntryView } from "./payouts.js";
import type { StaffMember } from "./staff-auth.js";
import {
  companyWalletSends,
  payouts,
  walletTransactions,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { lockPayout } from "../payout/guards.js";
import { applyPayoutOutcome } from "../payout/subjects.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../pretium/settlement.js";
import {
  issueConfirmation,
  peekConfirmation,
  spendConfirmation,
} from "./confirmations.js";
import { companyWalletSendView } from "./near-send-evidence.js";
import {
  gatherChainAndPaycrest,
  isPayoutsPretiumTransaction,
  payoutLedger,
  planResolution,
  refundedUsdc,
} from "./payout-evidence.js";
import { ledgerView, payoutOrganization, readScopedPayout } from "./payouts.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * Resolving a payout under review (spec §6.8, §6.15): a person closes it as
 * paid or failed, with a written reason and a second confirmation, once
 * Paycrest and the chain support the outcome. It never sends, re-sends or
 * orders anything. The only money record it writes is the one ledger debit
 * the chain shows was missing.
 *
 * A USDC payout on NEAR is resolved from its company wallet sends. If one
 * is still open, its outcome was never read and it holds up every other
 * send from that wallet, so resolving the payout closes it too: as run,
 * where the chain shows it moved the USDC, or as never having moved
 * anything, once it can no longer run.
 */

type EvidenceDeps =
  DatabaseService | Paycrest | Pretium | BaseRpc | NearRpc | NearChain;
type ResolveDeps = EvidenceDeps | AuditLog;
type ResolveError =
  | NotFound
  | Conflict
  | ServiceUnavailable
  | ConfirmationRefused
  | DatabaseError;

/** Shown to the company in place of the old failure; the note stays in the audit log. */
const RESOLVED_FAILED_REASON =
  "Expendi reviewed this payout and closed it as failed. Nothing more will be sent.";

export interface PretiumEvidenceView {
  readonly settlementAddress: string;
  readonly depositAddressIsSettlement: boolean;
  readonly transferHash: string | null;
  readonly transaction: PretiumTransactionEvidence;
  readonly refundRequestedAt: string | null;
  readonly refundTxHash: string | null;
  readonly refundCreditedUsdc: bigint | null;
}

export interface EvidenceView {
  readonly paycrestStatus: string | null;
  readonly pretium: PretiumEvidenceView | null;
  readonly fundingStarted: boolean;
  readonly depositTransfers: readonly {
    readonly chain: WalletChain;
    readonly txHash: string;
    readonly logIndex: number;
    readonly blockNumber: bigint;
    readonly usdcAmount: bigint;
  }[];
  readonly ledgerDebits: readonly LedgerEntryView[];
  readonly refunds: readonly LedgerEntryView[];
  /**
   * A NEAR payout's company wallet sends, newest first, each with the
   * relayer transactions that carried it and what the chain shows of them.
   * Empty for a payout funded on Base.
   */
  readonly companyWalletSends: readonly CompanyWalletSendView[];
}

function pretiumTransactionView(
  payout: Payout,
  transferHash: string | null,
  lookup: PretiumLookup,
): PretiumTransactionEvidence {
  if (lookup.state !== "found") return lookup;
  const { transaction } = lookup;
  return {
    state: "found",
    lookedUpBy: lookup.lookedUpBy,
    transactionCode: transaction.transactionCode,
    status: transaction.status,
    transactionHash: transaction.transactionHash,
    receiptNumber: transaction.receiptNumber,
    message: transaction.message,
    isThisPayouts: isPayoutsPretiumTransaction(
      payout,
      transferHash,
      transaction,
    ),
  };
}

function pretiumView(
  payout: Payout,
  evidence: PayoutEvidence,
): PretiumEvidenceView | null {
  const { pretium } = evidence;
  if (!pretium) return null;
  return {
    settlementAddress: PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase(),
    depositAddressIsSettlement: pretium.depositAddressIsSettlement,
    transferHash: pretium.transferHash,
    transaction: pretiumTransactionView(
      payout,
      pretium.transferHash,
      pretium.lookup,
    ),
    refundRequestedAt: payout.refundRequestedAt?.toISOString() ?? null,
    refundTxHash: payout.refundTxHash,
    refundCreditedUsdc:
      evidence.refunds.length === 0 ? null : refundedUsdc(evidence.refunds),
  };
}

export function evidenceView(
  payout: Payout,
  evidence: PayoutEvidence,
): EvidenceView {
  return {
    paycrestStatus: evidence.paycrestStatus,
    pretium: pretiumView(payout, evidence),
    fundingStarted: evidence.fundingStarted,
    depositTransfers: evidence.depositTransfers.map((transfer) => ({
      chain: evidence.chain,
      txHash: transfer.txHash,
      logIndex: transfer.logIndex,
      blockNumber: transfer.blockNumber,
      usdcAmount: transfer.amount,
    })),
    ledgerDebits: evidence.ledgerDebits.map(ledgerView),
    refunds: evidence.refunds.map(ledgerView),
    companyWalletSends: (evidence.near?.sends ?? []).map(companyWalletSendView),
  };
}

const notUnderReview = (payout: Payout) =>
  new Conflict({
    message: `Only a payout under review can be resolved; this one is ${payout.status}.`,
  });

/**
 * A payout with what its cash-out provider (Paycrest or Pretium), the
 * chain and the ledger say of it right now.
 */
function gatherEvidence(
  organizationId: string,
  payoutId: string,
): Effect.Effect<
  { payout: Payout; evidence: PayoutEvidence },
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  EvidenceDeps
> {
  return Effect.gen(function* () {
    const scoped = yield* readScopedPayout(organizationId, payoutId);
    const { payout } = scoped;
    const chain = yield* gatherChainAndPaycrest(payout, {
      chain: scoped.walletChain,
      address: scoped.walletAddress,
      transitAddress: scoped.transitAddress,
    });
    const ledger = yield* withStaffReadScope({ organizationId }, (tx) =>
      payoutLedger(tx, payoutId),
    );
    return {
      payout,
      evidence: {
        ...chain,
        ledgerDebits: ledger.debits,
        refunds: ledger.refunds,
      },
    };
  });
}

function evidenceFor(
  organizationId: string,
  payoutId: string,
): Effect.Effect<
  { payout: Payout; evidence: PayoutEvidence },
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  EvidenceDeps
> {
  return gatherEvidence(organizationId, payoutId).pipe(
    Effect.filterOrFail(
      ({ payout }) => payout.status === "needs_review",
      ({ payout }) => notUnderReview(payout),
    ),
  );
}

/**
 * What the chain, Paycrest and the ledger show for a payout in any status,
 * gathered fresh: for a NEAR payout, its saved company wallet sends, their
 * relayer transactions and the USDC those moved. It only reads.
 */
export function payoutEvidence(
  payoutId: string,
): Effect.Effect<
  EvidenceView,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  EvidenceDeps
> {
  return payoutOrganization(payoutId).pipe(
    Effect.flatMap((organizationId) =>
      gatherEvidence(organizationId, payoutId),
    ),
    Effect.map(({ payout, evidence }) => evidenceView(payout, evidence)),
  );
}

/**
 * Step one: checks the outcome against fresh evidence and, if it holds,
 * returns a confirmation token with what confirming will do.
 */
export interface PreparedResolution {
  readonly token: string;
  readonly expiresAt: string;
  readonly outcome: ResolveOutcome;
  readonly reason: string;
  readonly evidence: EvidenceView;
  readonly consequences: readonly string[];
}

export function prepareResolution(
  staff: StaffMember,
  payoutId: string,
  request: { readonly outcome: ResolveOutcome; readonly reason: string },
): Effect.Effect<
  PreparedResolution,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  ResolveDeps
> {
  return Effect.gen(function* () {
    const organizationId = yield* payoutOrganization(payoutId);
    const { payout, evidence } = yield* evidenceFor(organizationId, payoutId);
    const plan = yield* planResolution(
      payout,
      request.outcome,
      evidence,
      Date.now(),
    );
    const issued = yield* withScope({}, (tx) =>
      issueConfirmation(tx, staff, {
        purpose: "resolve_payout",
        target: payoutId,
        params: { outcome: request.outcome, reason: request.reason },
      }),
    );
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      outcome: request.outcome,
      reason: request.reason,
      evidence: evidenceView(payout, evidence),
      consequences: [
        ...plan.consequences,
        "The resolution is audited under your name, with your reason.",
      ],
    };
  });
}

export interface ResolutionResult {
  readonly status: PayoutStatus;
  readonly ledgerDebit: LedgerEntryView | null;
  readonly evidence: EvidenceView;
}

/**
 * Step two: applies exactly what was prepared. The evidence is gathered
 * again, then the token is spent, the payout locked and re-checked, any
 * missing debit recorded, and the resolution audited, all in one
 * transaction.
 */
export function confirmResolution(
  staff: StaffMember,
  payoutId: string,
  token: string,
): Effect.Effect<ResolutionResult, ResolveError, ResolveDeps> {
  const expected = { purposes: ["resolve_payout"], target: payoutId } as const;
  return Effect.gen(function* () {
    const organizationId = yield* payoutOrganization(payoutId);
    const prepared = yield* withScope({}, (tx) =>
      peekConfirmation(tx, staff, token, expected),
    );
    const outcome = resolveOutcomeSchema.safeParse(prepared.params.outcome);
    const reason = prepared.params.reason;
    if (!outcome.success || !reason) {
      return yield* Effect.fail(
        new BadRequest({
          message: "This confirmation is for something else. Start again.",
        }),
      );
    }
    const { evidence: gathered } = yield* evidenceFor(organizationId, payoutId);

    return yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const confirmation = yield* spendConfirmation(
          tx,
          staff,
          token,
          expected,
        );
        const payout = yield* lockPayout(tx, payoutId);
        if (!payout)
          return yield* Effect.dieMessage(`payout ${payoutId} vanished`);
        const ledger = yield* payoutLedger(tx, payoutId);
        const evidence: PayoutEvidence = {
          ...gathered,
          ledgerDebits: ledger.debits,
          refunds: ledger.refunds,
        };
        const plan = yield* planResolution(
          payout,
          outcome.data,
          evidence,
          Date.now(),
        );

        const transfer = plan.debitToRecord;
        let recorded: LedgerRow | null = null;
        if (transfer) {
          const [row] = yield* query(() =>
            tx
              .insert(walletTransactions)
              .values({
                organizationId,
                walletId: payout.walletId,
                type:
                  payout.subjectType === "withdrawal" ? "withdrawal" : "payout",
                chain: evidence.chain,
                usdcAmount: -transfer.amount,
                txHash: transfer.txHash,
                // A NEAR row names a log only together with its receipt,
                // which the evidence doesn't carry.
                ...(evidence.chain === "base" && {
                  logIndex: transfer.logIndex,
                }),
                blockNumber: transfer.blockNumber,
                counterpartyAddress: transfer.to,
                payoutId,
              })
              .returning(),
          );
          recorded = row ?? null;
        }

        const [onChain] = evidence.depositTransfers;
        const now = new Date();
        const [updated] = yield* query(() =>
          tx
            .update(payouts)
            .set({
              status: outcome.data,
              ...(onChain && !payout.txHash && { txHash: onChain.txHash }),
              ...(outcome.data === "paid"
                ? {
                    paidAt: now,
                    ...(payout.provider === "onchain" &&
                      onChain &&
                      !payout.providerReference && {
                        providerReference: onChain.txHash,
                      }),
                  }
                : { failureReason: RESOLVED_FAILED_REASON }),
            })
            .where(
              and(eq(payouts.id, payoutId), eq(payouts.status, "needs_review")),
            )
            .returning(),
        );
        if (!updated) {
          return yield* Effect.dieMessage(
            `payout ${payoutId} changed under its lock`,
          );
        }

        for (const closure of plan.sendsToClose) {
          const [closed] = yield* query(() =>
            tx
              .update(companyWalletSends)
              .set({
                status: closure.status,
                txHash: closure.txHash,
                blockHeight: closure.blockHeight,
                failure: closure.failure,
              })
              .where(
                and(
                  eq(companyWalletSends.id, closure.sendId),
                  inArray(companyWalletSends.status, ["reserved", "signed"]),
                ),
              )
              .returning({ id: companyWalletSends.id }),
          );
          // The send settled itself after the evidence was read: the
          // resolution was planned on evidence that no longer holds.
          if (!closed) {
            return yield* Effect.fail(
              new Conflict({
                message:
                  "The company wallet's send changed while this was being confirmed. Nothing was changed; start again.",
              }),
            );
          }
        }

        const after = {
          ...evidence,
          ledgerDebits: recorded ? [...ledger.debits, recorded] : ledger.debits,
        };
        const view = evidenceView(payout, after);
        yield* audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: "payout.resolved",
          entity: { type: "payout", id: payoutId },
          before: {
            status: payout.status,
            failureReason: payout.failureReason,
          },
          after: {
            status: updated.status,
            resolution: outcome.data,
            paycrestStatus: view.paycrestStatus,
            ...(view.pretium && { pretium: view.pretium }),
            depositTransfers: view.depositTransfers,
            ledgerDebits: view.ledgerDebits,
            refunds: view.refunds,
            companyWalletSendsClosed: plan.sendsToClose,
            via: "admin-app",
            note: reason,
            confirmationId: confirmation.id,
          },
        });
        yield* applyPayoutOutcome(tx, updated);
        return {
          status: updated.status,
          ledgerDebit: recorded ? ledgerView(recorded) : null,
          evidence: view,
        };
      }),
    );
  });
}
