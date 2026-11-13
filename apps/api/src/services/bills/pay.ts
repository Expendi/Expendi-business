import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  BillCurrency,
  BillStatus,
  PayeeChangeHold,
  PaymentDestination,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { ApprovalChallenge } from "../approval/passkeys.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { PaycrestError } from "../paycrest/paycrest-client.js";
import type { AmountTooSmall } from "../paycrest/quote.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import type { PayeeChangeConfirmation } from "../payees/payment-guard.js";
import type { PaymentCost, WalletCover } from "../payments/payment-approval.js";
import type { PayoutRejected } from "../payout/payout-errors.js";
import type {
  KesPayoutRequest,
  PayoutEngineDeps,
  UsdcPayoutRequest,
} from "../payout/payout-service.js";
import type { PretiumError } from "../pretium/pretium-client.js";
import type { BillAmount } from "./payable.js";
import {
  bills,
  cards,
  payees,
  payouts,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { canonicalJson } from "../approval/passkeys.js";
import { resolvePayeeRecipient } from "../payees/payment-guard.js";
import {
  awaitingPayoutFor,
  challengePayouts,
  costOf,
  destinationOf,
  topUpConflict,
  walletCover,
} from "../payments/payment-approval.js";
import {
  approveAndPay,
  preparePayouts,
  requestPayoutApproval,
} from "../payout/payout-service.js";
import { assertBillPayable } from "./payable.js";

/**
 * Paying bills through Expendi (spec §6.20): **Pay** on one bill or **Pay
 * all** on several. Each bill must be payable (`assertBillPayable`) and its
 * payee payable now (`resolvePayeeRecipient`: the 24-hour hold after a
 * details change, an employee's confirmed number). Then each bill gets its
 * own payout, and one passkey approves them all through the payout engine,
 * whose every guard applies (balance, daily cap, pauses, allowlist). Each
 * bill moves to `paying` in the approval's own transaction, and on with its
 * payout (`bill-payout-hooks.ts`), so one failing never touches the others.
 *
 * A bill to a payee paid in USDC is in USD and pays exactly that USDC
 * (spec §6.19); the engine values it in KES for the daily cap.
 *
 * Idempotency keys are `bill:<billId>:<n>`, n one more than the bill's
 * failed payouts. Salary bills are paid with their payroll run.
 */

export type BillPaymentError =
  | PayoutRejected
  | PaycrestError
  | PretiumError
  | AmountTooSmall
  | Conflict
  | NotFound
  | Forbidden
  | DatabaseError;

const billNotFound = new NotFound({ message: "That bill wasn't found." });
const approvalNotFound = new NotFound({
  message: "That payment wasn't found. Start paying again.",
});
const salaryBill = new Conflict({
  message: "This is a salary payment. Pay it with its payroll run.",
});
const notFailed = new Conflict({
  message: "Only a bill whose payment failed can be retried.",
});

const REPLACED =
  "Replaced before approval: the bill or its payee's details changed. Nothing was sent.";

/** The engine's request for a bill, before its idempotency key. */
type BillPayoutRequest =
  | Omit<KesPayoutRequest, "idempotencyKey">
  | Omit<UsdcPayoutRequest, "idempotencyKey">;

/** A bill ready to pay: what it pays and where, as of now. */
interface PayableBill {
  readonly billId: string;
  readonly payeeName: string;
  readonly currency: BillCurrency;
  readonly request: BillPayoutRequest;
}

interface HeldPayee {
  readonly payee: PayeeChangeHold["payees"][number];
  readonly message: string;
}

/**
 * The engine's request: a USD bill pays exactly its USDC to the payee's
 * allowlisted address, a KES bill its KES through Paycrest. Null if the
 * payee's method and the bill's currency disagree, which
 * `assertBillPayable` has already refused.
 */
function requestFor(
  billId: string,
  amount: BillAmount,
  recipient: PayoutRecipient,
): BillPayoutRequest | null {
  const subject = { subjectType: "bill", subjectId: billId } as const;
  if (amount.currency === "usd") {
    return recipient.method === "usdc"
      ? { ...subject, recipient, amountUsdc: amount.amountUsdc }
      : null;
  }
  return recipient.method === "usdc"
    ? null
    : { ...subject, recipient, amountKesCents: amount.amountKes };
}

/** The bill, locked, with what `assertBillPayable` needs. */
function lockBill(tx: Transaction, organizationId: string, billId: string) {
  return query(() =>
    tx
      .select({
        bill: bills,
        payee: { name: payees.name, kind: payees.kind, method: payees.method },
        recurringPayVia: recurringItems.payVia,
        cardLastFour: cards.lastFour,
      })
      .from(bills)
      .innerJoin(payees, eq(payees.id, bills.payeeId))
      .leftJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .leftJoin(cards, eq(cards.id, recurringItems.cardId))
      .where(
        and(eq(bills.organizationId, organizationId), eq(bills.id, billId)),
      )
      .for("update", { of: bills }),
  ).pipe(Effect.map(([found]) => found ?? null));
}

/**
 * Every bill, payable now, in one transaction; nothing is prepared unless
 * all of them are. Payees inside their 24-hour hold are gathered, so the
 * admin is asked once for all of them.
 */
function readPayableBills(
  tenant: Tenant,
  billIds: readonly string[],
  confirmation: PayeeChangeConfirmation,
  retry: boolean,
): Effect.Effect<
  PayableBill[],
  NotFound | Conflict | DatabaseError,
  DatabaseService
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const payable: PayableBill[] = [];
      const held: HeldPayee[] = [];
      for (const billId of billIds) {
        const found = yield* lockBill(tx, organizationId, billId);
        if (!found) return yield* Effect.fail(billNotFound);
        const { bill, payee } = found;
        if (bill.payrollRunId !== null) return yield* Effect.fail(salaryBill);
        if (retry && bill.status !== "payout_failed") {
          return yield* Effect.fail(notFailed);
        }
        const amount = yield* assertBillPayable({
          bill,
          payee,
          recurringItem:
            found.recurringPayVia === null
              ? null
              : {
                  payVia: found.recurringPayVia,
                  cardLastFour: found.cardLastFour,
                },
        }).pipe(
          Effect.catchTag("BillNotPayable", (error) =>
            Effect.fail(
              new Conflict({
                message: error.message,
                details: { billId: error.billId, reason: error.reason },
              }),
            ),
          ),
        );
        const recipient = yield* resolvePayeeRecipient(
          tx,
          bill.payeeId,
          confirmation,
        ).pipe(
          Effect.map((resolved): PayoutRecipient | null => resolved),
          Effect.catchTags({
            PayeeChangeUnconfirmed: (error) =>
              Effect.sync(() => {
                held.push({
                  payee: {
                    payeeId: error.payeeId,
                    name: payee.name,
                    detailsChangedAt: error.detailsChangedAt.toISOString(),
                  },
                  message: error.message,
                });
                return null;
              }),
            PayeeNotPayable: (error) =>
              Effect.fail(new Conflict({ message: error.message })),
            PayeeNotFound: (error) =>
              Effect.fail(new Conflict({ message: error.message })),
          }),
        );
        if (recipient === null) continue;
        const request = requestFor(billId, amount, recipient);
        if (request === null) {
          return yield* Effect.dieMessage(
            `bill ${billId}'s currency and its payee's method disagree`,
          );
        }
        payable.push({
          billId,
          payeeName: payee.name,
          currency: amount.currency,
          request,
        });
      }
      if (held.length > 0) return yield* Effect.fail(holdConflict(held));
      return payable;
    }),
  );
}

/** Spec §6.19: a warning, and a second confirmation before paying. */
function holdConflict(held: readonly HeldPayee[]): Conflict {
  const payeesHeld = new Map(
    held.map(({ payee }) => [payee.payeeId, payee] as const),
  );
  const details: PayeeChangeHold = {
    reason: "payee_details_changed",
    payees: [...payeesHeld.values()],
  };
  return new Conflict({
    message:
      payeesHeld.size === 1 && held[0]
        ? held[0].message
        : "Some payees' payment details changed in the last 24 hours. Check them, then confirm again to pay.",
    details,
  });
}

/** Whether an awaiting payout still pays exactly this bill, as it is now. */
function pays(payout: Payout, { request }: PayableBill): boolean {
  const sameAmount =
    "amountUsdc" in request
      ? payout.provider === "onchain" &&
        payout.quotedUsdc === request.amountUsdc
      : payout.provider !== "onchain" &&
        payout.requestedKesCents === request.amountKesCents;
  return (
    sameAmount &&
    payout.payrollRunId === null &&
    canonicalJson(payout.recipient) === canonicalJson(request.recipient)
  );
}

function payoutFor(
  organizationId: string,
  actor: AuditActor,
  bill: PayableBill,
): Effect.Effect<
  Payout,
  | PayoutRejected
  | PaycrestError
  | PretiumError
  | AmountTooSmall
  | Conflict
  | DatabaseError,
  PayoutEngineDeps
> {
  return awaitingPayoutFor({
    organizationId,
    actor,
    subjectType: "bill",
    subjectId: bill.billId,
    keyPrefix: "bill",
    pays: (payout) => pays(payout, bill),
    replaced: REPLACED,
    alreadyPaying: "This bill is already being paid.",
    prepare: (idempotencyKey) =>
      Effect.gen(function* () {
        const [prepared] = yield* preparePayouts({
          organizationId,
          actor,
          requests: [{ ...bill.request, idempotencyKey }],
        });
        if (!prepared) {
          return yield* Effect.dieMessage("bill prepared nothing");
        }
        return prepared;
      }),
  });
}

export interface BillPaymentPreviewView extends PaymentCost {
  readonly billId: string;
  readonly payoutId: string;
  readonly payeeName: string;
  readonly paidTo: PaymentDestination;
  readonly currency: BillCurrency;
  readonly billedKes: bigint | null;
  readonly receivesKes: bigint | null;
  readonly receivesUsdc: bigint | null;
  readonly kesEquivalent: bigint;
}

export interface BillPaymentView {
  readonly challengeId: string;
  readonly options: ApprovalChallenge["options"];
  readonly bills: readonly BillPaymentPreviewView[];
  readonly totals: {
    readonly receivesKes: bigint;
    readonly receivesUsdc: bigint;
    readonly kesEquivalent: bigint;
    readonly usdc: bigint;
    readonly feeAllowanceUsdc: bigint;
    readonly maxDebitUsdc: bigint;
  };
  readonly wallet: WalletCover;
}

function previewOf(payout: Payout, bill: PayableBill): BillPaymentPreviewView {
  const usd = bill.currency === "usd";
  return {
    billId: bill.billId,
    payoutId: payout.id,
    payeeName: bill.payeeName,
    paidTo: destinationOf(payout.recipient),
    currency: bill.currency,
    billedKes: usd ? null : payout.requestedKesCents,
    receivesKes: usd ? null : payout.amountKes,
    receivesUsdc: usd ? payout.quotedUsdc : null,
    kesEquivalent: payout.amountKes,
    ...costOf(payout),
  };
}

/**
 * Prepares each bill's payout and one passkey challenge for all of them,
 * with the cost the admin confirms and whether the wallet covers it.
 */
function approvalFor(
  tenant: Tenant,
  payable: readonly PayableBill[],
): Effect.Effect<BillPaymentView, BillPaymentError, PayoutEngineDeps> {
  const actor = { type: "user", id: tenant.userId } as const;
  return Effect.gen(function* () {
    const batch: Payout[] = [];
    for (const bill of payable) {
      batch.push(yield* payoutFor(tenant.organizationId, actor, bill));
    }
    const challenge = yield* requestPayoutApproval({
      organizationId: tenant.organizationId,
      userId: tenant.userId,
      payoutIds: batch.map((payout) => payout.id),
    });
    const previews = batch.map((payout, index) => {
      const bill = payable[index];
      if (!bill) throw new Error("a prepared payout lost its bill");
      return previewOf(payout, bill);
    });
    const sum = (pick: (preview: BillPaymentPreviewView) => bigint | null) =>
      previews.reduce((total, preview) => total + (pick(preview) ?? 0n), 0n);
    return {
      challengeId: challenge.challengeId,
      options: challenge.options,
      bills: previews,
      totals: {
        receivesKes: sum((preview) => preview.receivesKes),
        receivesUsdc: sum((preview) => preview.receivesUsdc),
        kesEquivalent: sum((preview) => preview.kesEquivalent),
        usdc: sum((preview) => preview.usdc),
        feeAllowanceUsdc: sum((preview) => preview.feeAllowanceUsdc),
        maxDebitUsdc: sum((preview) => preview.maxDebitUsdc),
      },
      wallet: yield* walletCover(tenant.organizationId, batch),
    };
  });
}

/**
 * Step one of Pay / Pay all: every bill must be payable, and nothing is
 * prepared unless all are. A payee whose details changed in the last 24
 * hours needs `secondConfirmation` (spec §6.19).
 */
export function requestBillPayment(
  tenant: Tenant,
  billIds: readonly string[],
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<BillPaymentView, BillPaymentError, PayoutEngineDeps> {
  return readPayableBills(tenant, billIds, confirmation, false).pipe(
    Effect.flatMap((payable) => approvalFor(tenant, payable)),
  );
}

/**
 * Retry after a failed payment (spec §6.20): a new payout with a new key,
 * for the bill as it is now, waiting for a fresh passkey approval. Never
 * automatic.
 */
export function requestBillRetry(
  tenant: Tenant,
  billId: string,
  confirmation: PayeeChangeConfirmation,
): Effect.Effect<BillPaymentView, BillPaymentError, PayoutEngineDeps> {
  return readPayableBills(tenant, [billId], confirmation, true).pipe(
    Effect.flatMap((payable) => approvalFor(tenant, payable)),
  );
}

/** The challenge's payouts, if every one pays a bill of this company outside payroll. */
function billPayoutsOfChallenge(
  tenant: Tenant,
  challengeId: string,
): Effect.Effect<Payout[], NotFound | DatabaseError, DatabaseService> {
  return Effect.gen(function* () {
    const batch = yield* challengePayouts(
      tenant,
      challengeId,
      approvalNotFound,
    );
    const known = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({ id: bills.id })
          .from(bills)
          .where(
            and(
              inArray(
                bills.id,
                batch.map((payout) => payout.subjectId),
              ),
              eq(bills.organizationId, tenant.organizationId),
              isNull(bills.payrollRunId),
            ),
          ),
      ),
    );
    const ids = new Set(known.map((bill) => bill.id));
    if (
      batch.some(
        (payout) =>
          payout.subjectType !== "bill" ||
          payout.payrollRunId !== null ||
          !ids.has(payout.subjectId),
      )
    ) {
      return yield* Effect.fail(approvalNotFound);
    }
    return batch;
  });
}

export interface BillPaymentResultView {
  readonly bills: readonly {
    readonly billId: string;
    readonly status: BillStatus;
    readonly payout: {
      readonly id: string;
      readonly status: Payout["status"];
      readonly failureReason: string | null;
    };
  }[];
}

/**
 * Step two: the admin's passkey approves the payouts, and each is funded
 * once and on its own. The challenge is single-use.
 */
export function confirmBillPayment(
  tenant: Tenant,
  challengeId: string,
  response: AuthenticationResponseJSON,
): Effect.Effect<
  BillPaymentResultView,
  PayoutRejected | Conflict | NotFound | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const batch = yield* billPayoutsOfChallenge(tenant, challengeId);
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
            billId: bills.id,
            status: bills.status,
            payout: {
              id: payouts.id,
              status: payouts.status,
              failureReason: payouts.failureReason,
            },
          })
          .from(payouts)
          .innerJoin(bills, eq(bills.id, payouts.subjectId))
          .where(
            inArray(
              payouts.id,
              batch.map((payout) => payout.id),
            ),
          ),
      ),
    );
    return { bills: rows };
  });
}
