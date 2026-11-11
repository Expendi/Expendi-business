import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  IntentQuoteResolution,
  IntentQuoteStatus,
  PayoutStatus,
} from "@expendi-business/shared";
import { intentQuoteResolutionSchema } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type {
  DatabaseError,
  NotFound,
  ServiceUnavailable,
} from "../../errors.js";
import type { OneClick } from "../intents/one-click.js";
import type { ConfirmationRefused } from "./confirmations.js";
import type { EvidenceDeps } from "./intent-quote-evidence.js";
import type { IntentQuoteEvidenceView } from "./intent-quotes.js";
import type { StaffMember } from "./staff-auth.js";
import {
  companyWalletSends,
  intentQuotes,
  payouts,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { settleFromOneClick } from "../intents/quote-settle.js";
import { applyPayoutOutcome } from "../payout/subjects.js";
import {
  issueConfirmation,
  peekConfirmation,
  spendConfirmation,
} from "./confirmations.js";
import {
  gatherQuoteEvidence,
  planQuoteResolution,
  quotePayouts,
} from "./intent-quote-evidence.js";
import {
  oneClickUnavailable,
  quoteEvidenceView,
  quoteOrganization,
  readScopedQuote,
} from "./intent-quotes.js";

/**
 * Resolving a NEAR Intents quote under review (spec §6.8, §6.15): a person
 * says what became of its USDC (delivered, refunded, or never deposited),
 * with a written reason and a second confirmation, once 1Click and the
 * chains show it. It never signs, sends or re-sends anything, and writes
 * no ledger entry.
 *
 * 1Click is asked again first, through the step the outbound quotes job
 * settles every quote with, so a quote 1Click has since settled is settled
 * exactly as the job would. A resolution then corrects the quote's record
 * (its status, its deposit, a company wallet send nobody closed) and hands
 * the payouts it held under review back to the code that follows them,
 * which applies the outcome on its next run as it would have had 1Click
 * reported it: a cash-out is funded after a delivered hop or failed after
 * a refunded one, and a USDC payout is paid, or failed with its refund
 * credited, by the delivery code's own ledger rules.
 */

type ResolveDeps = EvidenceDeps | OneClick | AuditLog;
type ResolveError =
  | NotFound
  | Conflict
  | ServiceUnavailable
  | ConfirmationRefused
  | DatabaseError;

/**
 * Asks 1Click about the quote and settles it through the job's own step.
 * That step carries on unchanged when 1Click doesn't answer, so only a
 * new check time on the row shows the answer came.
 */
function askOneClick(
  quote: IntentQuote,
): Effect.Effect<
  IntentQuote,
  ServiceUnavailable | DatabaseError,
  OneClick | DatabaseService
> {
  const askedBefore = quote.oneClickCheckedAt?.getTime() ?? null;
  return settleFromOneClick(quote).pipe(
    Effect.filterOrFail(
      (asked) =>
        asked.oneClickCheckedAt !== null &&
        asked.oneClickCheckedAt.getTime() !== askedBefore,
      () => oneClickUnavailable,
    ),
  );
}

export interface PreparedQuoteResolution {
  readonly token: string;
  readonly expiresAt: string;
  readonly outcome: IntentQuoteResolution;
  readonly reason: string;
  readonly status: IntentQuoteStatus;
  readonly evidence: IntentQuoteEvidenceView;
  readonly consequences: readonly string[];
}

/**
 * Step one: asks 1Click again, checks the outcome against fresh evidence
 * and, if it holds, returns a confirmation token with what confirming will
 * do.
 */
export function prepareQuoteResolution(
  staff: StaffMember,
  quoteId: string,
  request: {
    readonly outcome: IntentQuoteResolution;
    readonly reason: string;
  },
): Effect.Effect<
  PreparedQuoteResolution,
  NotFound | Conflict | ServiceUnavailable | DatabaseError,
  ResolveDeps
> {
  return Effect.gen(function* () {
    const organizationId = yield* quoteOrganization(quoteId);
    const scoped = yield* readScopedQuote(organizationId, quoteId);
    const quote = yield* askOneClick(scoped.quote);
    const evidence = yield* gatherQuoteEvidence(quote);
    const plan = yield* planQuoteResolution({
      quote,
      outcome: request.outcome,
      evidence,
      payouts: scoped.payouts,
      now: Date.now(),
    });
    const issued = yield* withScope({}, (tx) =>
      issueConfirmation(tx, staff, {
        purpose: "resolve_intent_quote",
        target: quoteId,
        params: { outcome: request.outcome, reason: request.reason },
      }),
    );
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      outcome: request.outcome,
      reason: request.reason,
      status: quote.status,
      evidence: quoteEvidenceView(quote, evidence, scoped.payouts),
      consequences: [
        ...plan.consequences,
        "The resolution is audited under your name, with your reason and this evidence.",
      ],
    };
  });
}

export interface QuoteResolutionResult {
  readonly status: IntentQuoteStatus;
  readonly payouts: readonly {
    readonly id: string;
    readonly status: PayoutStatus;
  }[];
  readonly evidence: IntentQuoteEvidenceView;
}

const changedMeanwhile = (what: string) =>
  new Conflict({
    message: `${what} changed while this was being confirmed. Nothing was changed; start again.`,
  });

/**
 * Step two: applies exactly what was prepared. 1Click is asked and the
 * evidence gathered again, then the token is spent, the quote and its
 * payouts locked and the plan re-checked against them, and the quote's
 * record corrected, its open sends closed, its held payouts handed back
 * and the resolution audited, all in one transaction.
 */
export function confirmQuoteResolution(
  staff: StaffMember,
  quoteId: string,
  token: string,
): Effect.Effect<QuoteResolutionResult, ResolveError, ResolveDeps> {
  const expected = {
    purposes: ["resolve_intent_quote"],
    target: quoteId,
  } as const;
  return Effect.gen(function* () {
    const organizationId = yield* quoteOrganization(quoteId);
    const prepared = yield* withScope({}, (tx) =>
      peekConfirmation(tx, staff, token, expected),
    );
    const outcome = intentQuoteResolutionSchema.safeParse(
      prepared.params.outcome,
    );
    const reason = prepared.params.reason;
    if (!outcome.success || !reason) {
      return yield* Effect.fail(
        new BadRequest({
          message: "This confirmation is for something else. Start again.",
        }),
      );
    }
    const scoped = yield* readScopedQuote(organizationId, quoteId);
    const asked = yield* askOneClick(scoped.quote);
    const evidence = yield* gatherQuoteEvidence(asked);

    return yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const audit = yield* AuditLog;
        const confirmation = yield* spendConfirmation(
          tx,
          staff,
          token,
          expected,
        );
        const [quote] = yield* query(() =>
          tx
            .select()
            .from(intentQuotes)
            .where(eq(intentQuotes.id, quoteId))
            .for("update"),
        );
        if (!quote)
          return yield* Effect.dieMessage(`quote ${quoteId} vanished`);
        const linked = yield* quotePayouts(tx, quote, true);
        const plan = yield* planQuoteResolution({
          quote,
          outcome: outcome.data,
          evidence,
          payouts: linked,
          now: Date.now(),
        });

        const recordDeposit = plan.deposit && {
          depositTxHash: plan.deposit.txHash,
          ...(plan.deposit.companyWalletSendId !== null && {
            companyWalletSendId: plan.deposit.companyWalletSendId,
          }),
        };
        let settled = quote;
        const { settleAs } = plan;
        if (settleAs !== null) {
          const [moved] = yield* query(() =>
            tx
              .update(intentQuotes)
              .set({
                status: settleAs,
                settledAt: new Date(),
                failure: plan.failure,
                ...recordDeposit,
              })
              .where(
                and(
                  eq(intentQuotes.id, quoteId),
                  eq(intentQuotes.status, "needs_review"),
                ),
              )
              .returning(),
          );
          if (!moved) {
            return yield* Effect.dieMessage(
              `quote ${quoteId} changed under its lock`,
            );
          }
          settled = moved;
        } else if (recordDeposit) {
          const [linkedDeposit] = yield* query(() =>
            tx
              .update(intentQuotes)
              .set(recordDeposit)
              .where(
                and(
                  eq(intentQuotes.id, quoteId),
                  isNull(intentQuotes.depositTxHash),
                ),
              )
              .returning(),
          );
          if (!linkedDeposit) {
            return yield* Effect.fail(changedMeanwhile("The quote's deposit"));
          }
          settled = linkedDeposit;
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
              changedMeanwhile("The company wallet's send"),
            );
          }
        }

        const view = quoteEvidenceView(asked, evidence, linked);
        for (const handBack of plan.payoutsToReturn) {
          const before = linked.find(
            ({ payout }) => payout.id === handBack.payoutId,
          )?.payout;
          const [returned] = yield* query(() =>
            tx
              .update(payouts)
              .set({ status: handBack.status, failureReason: null })
              .where(
                and(
                  eq(payouts.id, handBack.payoutId),
                  eq(payouts.status, "needs_review"),
                ),
              )
              .returning(),
          );
          if (!returned) {
            return yield* Effect.dieMessage(
              `payout ${handBack.payoutId} changed under its lock`,
            );
          }
          yield* audit.record(tx, {
            actor: { type: "staff", id: staff.staffUserId },
            organizationId,
            action: "payout.quote_resolved",
            entity: { type: "payout", id: returned.id },
            before: {
              status: before?.status ?? "needs_review",
              failureReason: before?.failureReason ?? null,
            },
            after: {
              status: returned.status,
              intentQuoteId: quoteId,
              resolution: outcome.data,
              via: "admin-app",
              note: reason,
              confirmationId: confirmation.id,
            },
          });
          yield* applyPayoutOutcome(tx, returned);
        }

        yield* audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: "intent_quote.resolved",
          entity: { type: "intent_quote", id: quoteId },
          before: { status: quote.status, failure: quote.failure },
          after: {
            status: settled.status,
            resolution: outcome.data,
            depositTxHash: settled.depositTxHash,
            companyWalletSendId: settled.companyWalletSendId,
            oneClickStatus: asked.oneClickStatus,
            evidence: {
              deposits: view.deposits,
              deliveries: view.deliveries,
              refunds: view.refunds,
              unreadDeliveries: view.unreadDeliveries,
            },
            companyWalletSendsClosed: plan.sendsToClose,
            payoutsReturned: plan.payoutsToReturn,
            via: "admin-app",
            note: reason,
            confirmationId: confirmation.id,
          },
        });

        const after = yield* quotePayouts(tx, quote);
        return {
          status: settled.status,
          payouts: after.map(({ payout }) => ({
            id: payout.id,
            status: payout.status,
          })),
          evidence: quoteEvidenceView(asked, evidence, after),
        };
      }),
    );
  });
}
