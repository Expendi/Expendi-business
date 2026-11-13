import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import type { PayeeChain } from "@expendi-business/shared";
import { formatKesAmount } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Paycrest, PaycrestError } from "../paycrest/paycrest-client.js";
import type { AmountTooSmall } from "../paycrest/quote.js";
import type { KesRecipient, UsdcRecipient } from "../paycrest/recipient.js";
import type { Pretium, PretiumError } from "../pretium/pretium-client.js";
import { payouts, wallets } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { isAllowlisted } from "../allowlist/allowlist.js";
import { canonicalJson } from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";
import { activeCashOutProvider } from "../cash-out/active-provider.js";
import { cashOutRate, quoteKesCashOut } from "../cash-out/quote.js";
import { normalisePayeeAddress } from "../chain/address.js";
import { ceilDiv, fromMicro, kesCentsFor } from "../paycrest/amounts.js";
import { cashOutRecipientProblem } from "./cash-out-check.js";
import { PayoutRejected } from "./payout-errors.js";

export { PAYOUT_MEMO } from "../paycrest/recipient.js";

const USDC_ADDRESS_KINDS: Readonly<Record<PayeeChain, string>> = {
  near: "a NEAR account",
  base: "a Base address",
  solana: "a Solana address",
};

/**
 * Room above the quote for Paycrest's fee and a small rate move before
 * funding: 0.25 USDC plus 0.5%. Only this much can ever leave the wallet;
 * the actual debit is the order's exact amount. Calibrate at Checkpoint B.
 */
export function maxDebitFor(quotedUsdc: bigint): bigint {
  return quotedUsdc + 250_000n + ceilDiv(quotedUsdc * 50n, 10_000n);
}

interface PayoutRequestBase {
  readonly subjectType: Payout["subjectType"];
  readonly subjectId: string;
  /** A split salary's order, from 1 (spec §7.5); leave out otherwise. */
  readonly subjectPart?: number;
  readonly payrollRunId?: string;
  /** Stable for this attempt, e.g. `claim:<id>:1`; a retry uses a new one. */
  readonly idempotencyKey: string;
}

/** A cash-out in KES: the amount is what the recipient receives. */
export interface KesPayoutRequest extends PayoutRequestBase {
  readonly recipient: KesRecipient;
  readonly amountKesCents: bigint;
}

/** USDC straight from the wallet to an allowlisted address, exactly. */
export interface UsdcPayoutRequest extends PayoutRequestBase {
  readonly recipient: UsdcRecipient;
  readonly amountUsdc: bigint;
}

export type PayoutRequest = KesPayoutRequest | UsdcPayoutRequest;

export const isUsdcRequest = (
  request: PayoutRequest,
): request is UsdcPayoutRequest => request.recipient.method === "usdc";

export type PrepareError =
  | PayoutRejected
  | PaycrestError
  | PretiumError
  | AmountTooSmall
  | DatabaseError;

const reject = (reason: PayoutRejected["reason"], message: string) =>
  Effect.fail(new PayoutRejected({ reason, message }));

/**
 * A request with its recipient normalised, as it will be stored. An address
 * that isn't one on its payee chain is left as it is, for pricing to reject.
 */
function normalise(request: PayoutRequest): PayoutRequest {
  if (!isUsdcRequest(request)) return request;
  const { chain, address } = request.recipient;
  return {
    ...request,
    recipient: {
      ...request.recipient,
      address: normalisePayeeAddress(chain, address) ?? address,
    },
  };
}

const sameRequest = (payout: Payout, request: PayoutRequest): boolean =>
  payout.subjectType === request.subjectType &&
  payout.subjectId === request.subjectId &&
  payout.subjectPart === (request.subjectPart ?? 1) &&
  (payout.payrollRunId ?? undefined) === request.payrollRunId &&
  (isUsdcRequest(request)
    ? payout.quotedUsdc === request.amountUsdc
    : payout.requestedKesCents === request.amountKesCents) &&
  canonicalJson(payout.recipient) === canonicalJson(request.recipient);

interface Priced {
  readonly provider: Payout["provider"];
  readonly requestedKesCents: bigint;
  readonly amountKes: bigint;
  readonly quotedRate: string;
  readonly quotedUsdc: bigint;
  readonly maxDebitUsdc: bigint;
}

/**
 * Validates, prices and records payouts awaiting an admin's approval
 * (spec §6.7 steps 1–2). Each copies its recipient, so a later payee edit
 * never changes it. Preparing the same idempotency key again returns the
 * same payout; reusing a key for something different is refused.
 */
export function preparePayouts(input: {
  readonly organizationId: string;
  readonly actor: AuditActor;
  readonly requests: readonly PayoutRequest[];
}): Effect.Effect<
  Payout[],
  PrepareError,
  DatabaseService | AuditLog | Paycrest | Pretium
> {
  const { organizationId, actor } = input;
  const requests = input.requests.map(normalise);
  const scope = { organizationId };

  return Effect.gen(function* () {
    if (requests.length === 0) {
      return yield* reject("empty_batch", "Choose something to pay.");
    }
    const runs = new Set(requests.map((request) => request.payrollRunId));
    if (runs.size > 1) {
      return yield* reject("mixed_batch", "A payroll run is paid on its own.");
    }
    if (
      requests.some(
        (request) =>
          request.subjectType === "withdrawal" &&
          (!isUsdcRequest(request) || request.payrollRunId !== undefined),
      )
    ) {
      return yield* reject(
        "invalid_recipient",
        "A withdrawal is USDC to an allowlisted address.",
      );
    }

    // One read for the whole batch, so its cash-outs can't straddle a change.
    const { wallet, provider } = yield* withScope(scope, (tx) =>
      Effect.gen(function* () {
        const [wallet] = yield* query(() =>
          tx
            .select({
              id: wallets.id,
              perTransactionMaxUsdc: wallets.perTransactionMaxUsdc,
            })
            .from(wallets)
            .where(
              and(
                eq(wallets.organizationId, organizationId),
                eq(wallets.status, "active"),
              ),
            )
            .limit(1),
        );
        return { wallet, provider: yield* activeCashOutProvider(tx) };
      }),
    );
    if (!wallet) {
      return yield* reject("no_wallet", "This company has no wallet yet.");
    }

    const audit = yield* AuditLog;

    const priceKes = (request: KesPayoutRequest) =>
      Effect.gen(function* () {
        const problem = cashOutRecipientProblem(provider, request.recipient);
        if (problem !== null) {
          return yield* reject("invalid_recipient", problem);
        }
        const quote = yield* quoteKesCashOut(
          provider,
          request.amountKesCents,
        ).pipe(
          Effect.catchTag("AmountTooLarge", ({ maxKesCents }) =>
            reject(
              "invalid_amount",
              `A single payment can send at most ${formatKesAmount(maxKesCents)}. Split it into smaller payments.`,
            ),
          ),
        );
        return {
          provider,
          requestedKesCents: request.amountKesCents,
          amountKes: quote.payoutKesCents,
          quotedRate: quote.rate,
          quotedUsdc: quote.usdcAmount,
          maxDebitUsdc: maxDebitFor(quote.usdcAmount),
        } satisfies Priced;
      });

    const priceUsdc = (request: UsdcPayoutRequest) =>
      Effect.gen(function* () {
        const { chain, address, accountName } = request.recipient;
        if (
          normalisePayeeAddress(chain, address) !== address ||
          accountName.trim().length === 0
        ) {
          return yield* reject(
            "invalid_recipient",
            `A USDC payee needs ${USDC_ADDRESS_KINDS[chain]} and a name.`,
          );
        }
        if (request.amountUsdc <= 0n) {
          return yield* reject("invalid_amount", "Enter an amount to pay.");
        }
        const listed = yield* withScope(scope, (tx) =>
          isAllowlisted(tx, organizationId, { chain, address }),
        );
        if (!listed) {
          return yield* reject(
            "not_allowlisted",
            "That address isn't on the company's allowlist.",
          );
        }
        const rate = yield* cashOutRate(provider);
        const kesEquivalent = kesCentsFor(request.amountUsdc, rate);
        if (kesEquivalent <= 0n) {
          return yield* reject("invalid_amount", "That amount is too small.");
        }
        return {
          provider: "onchain",
          requestedKesCents: kesEquivalent,
          amountKes: kesEquivalent,
          quotedRate: rate,
          quotedUsdc: request.amountUsdc,
          // Gas is Expendi's: exactly this amount leaves the wallet.
          maxDebitUsdc: request.amountUsdc,
        } satisfies Priced;
      });

    const prepared: Payout[] = [];
    for (const request of requests) {
      const existing = yield* findByIdempotencyKey(
        organizationId,
        request.idempotencyKey,
      );
      if (existing) {
        if (!sameRequest(existing, request)) {
          return yield* reject(
            "idempotency_key_reused",
            `Idempotency key ${request.idempotencyKey} was already used for a different payment.`,
          );
        }
        prepared.push(existing);
        continue;
      }

      const priced: Priced = isUsdcRequest(request)
        ? yield* priceUsdc(request)
        : yield* priceKes(request);
      if (priced.maxDebitUsdc > wallet.perTransactionMaxUsdc) {
        return yield* reject(
          "over_transaction_cap",
          `A single payment can move at most ${fromMicro(wallet.perTransactionMaxUsdc)} USDC. Split it into smaller payments.`,
        );
      }

      const payout = yield* withScope(scope, (tx) =>
        Effect.gen(function* () {
          const [inserted] = yield* query(() =>
            tx
              .insert(payouts)
              .values({
                organizationId,
                walletId: wallet.id,
                subjectType: request.subjectType,
                subjectId: request.subjectId,
                subjectPart: request.subjectPart ?? 1,
                payrollRunId: request.payrollRunId,
                idempotencyKey: request.idempotencyKey,
                method: request.recipient.method,
                recipient: request.recipient,
                ...priced,
              })
              .onConflictDoNothing()
              .returning(),
          );
          if (!inserted) return null;
          yield* audit.record(tx, {
            actor,
            organizationId,
            action: "payout.prepared",
            entity: { type: "payout", id: inserted.id },
            after: {
              subjectType: inserted.subjectType,
              subjectId: inserted.subjectId,
              subjectPart: inserted.subjectPart,
              payrollRunId: inserted.payrollRunId,
              provider: inserted.provider,
              method: inserted.method,
              recipient: inserted.recipient,
              amountKes: inserted.amountKes,
              quotedRate: inserted.quotedRate,
              maxDebitUsdc: inserted.maxDebitUsdc,
            },
          });
          return inserted;
        }),
      );
      if (payout) {
        prepared.push(payout);
        continue;
      }

      // A conflict: the same key raced us, or the subject is already paying.
      const raced = yield* findByIdempotencyKey(
        organizationId,
        request.idempotencyKey,
      );
      if (raced && sameRequest(raced, request)) {
        prepared.push(raced);
        continue;
      }
      return yield* reject(
        "subject_already_paying",
        "This is already being paid.",
      );
    }
    return prepared;
  });
}

function findByIdempotencyKey(organizationId: string, idempotencyKey: string) {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            eq(payouts.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([payout]) => payout ?? null));
}

/** Live (not failed) payouts of a subject; at most one by construction. */
export function livePayoutOf(
  organizationId: string,
  subjectType: Payout["subjectType"],
  subjectId: string,
) {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(payouts)
        .where(
          and(
            eq(payouts.organizationId, organizationId),
            eq(payouts.subjectType, subjectType),
            eq(payouts.subjectId, subjectId),
            ne(payouts.status, "failed"),
          ),
        )
        .limit(1),
    ),
  ).pipe(Effect.map(([payout]) => payout ?? null));
}
