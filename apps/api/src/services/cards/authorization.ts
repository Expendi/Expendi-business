import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { CardRef } from "./transactions.js";
import { cardPurchases, cards } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { notify } from "../notification/notify.js";
import {
  isCardBalanceLow,
  lockCardProgram,
  readCardBalance,
} from "./balance.js";
import { merchantKeyOf, merchantRefused } from "./merchants.js";
import {
  cardByLithicToken,
  companyScope,
  merchantNameOf,
} from "./transactions.js";

/**
 * Auth Stream Access (spec §6.25): Lithic asks before each spend, and this
 * answers from the Card balance alone, since the sandbox can't hold one,
 * and from the merchants a company-held card turns away. It must answer
 * fast, so it never calls Lithic or Paycrest.
 *
 * Holds are serialised on the company's card program row, the same lock as
 * Card loads, so two authorizations can't both spend the same balance.
 */

const amount = z.looseObject({ amount: z.number().int() });

/** Only the fields a decision needs; Lithic documents many more. */
export const cardAuthorizationRequestSchema = z.looseObject({
  token: z.string().min(1),
  status: z.string(),
  created: z.string().optional(),
  card: z.looseObject({ token: z.string().min(1) }),
  authorization_amount: z.number().int().optional(),
  amount: z.number().int().optional(),
  amounts: z
    .looseObject({
      cardholder: amount.nullish(),
      hold: amount.nullish(),
    })
    .optional(),
  merchant: z
    .looseObject({
      acceptor_id: z.string().nullish(),
      descriptor: z.string().nullish(),
      mcc: z.string().nullish(),
      city: z.string().nullish(),
      country: z.string().nullish(),
    })
    .optional(),
});

export type CardAuthorizationRequest = z.infer<
  typeof cardAuthorizationRequestSchema
>;

export type AuthorizationDecision =
  | {
      readonly token: string;
      readonly result:
        | "APPROVED"
        | "INSUFFICIENT_FUNDS"
        | "CARD_PAUSED"
        | "UNAUTHORIZED_MERCHANT";
    }
  | {
      readonly token: string;
      readonly result: "APPROVED";
      readonly balance: {
        readonly amount: number;
        readonly available: number;
      };
    };

const SPENDS: ReadonlySet<string> = new Set([
  "AUTHORIZATION",
  "FINANCIAL_AUTHORIZATION",
]);

/** The amount in the card's own currency, whichever field Lithic filled. */
function spendCents(request: CardAuthorizationRequest): bigint {
  const { amounts } = request;
  const figures = amounts
    ? [amounts.hold?.amount ?? 0, amounts.cardholder?.amount ?? 0]
    : [request.authorization_amount ?? request.amount ?? 0];
  return BigInt(Math.max(...figures.map(Math.abs)));
}

const atLeastZero = (cents: bigint): number => Number(cents < 0n ? 0n : cents);

function holdSpend(
  tx: Transaction,
  ref: CardRef,
  request: CardAuthorizationRequest,
): Effect.Effect<AuthorizationDecision, DatabaseError> {
  const { organization_id: organizationId, card_id: cardId } = ref;
  const { token } = request;
  return Effect.gen(function* () {
    if (!(yield* lockCardProgram(tx, organizationId))) {
      return { token, result: "CARD_PAUSED" };
    }
    const [card] = yield* query(() =>
      tx
        .select({
          membershipId: cards.membershipId,
          defaultCategoryId: cards.defaultCategoryId,
          companyHeld: cards.companyHeld,
          state: cards.state,
          closeRequestedAt: cards.closeRequestedAt,
        })
        .from(cards)
        .where(
          and(eq(cards.id, cardId), eq(cards.organizationId, organizationId)),
        )
        .limit(1),
    );
    // A leaver's card still works at Lithic until the station job closes it.
    if (card?.state !== "open" || card.closeRequestedAt !== null) {
      return { token, result: "CARD_PAUSED" };
    }
    const [existing] = yield* query(() =>
      tx
        .select({ status: cardPurchases.status })
        .from(cardPurchases)
        .where(eq(cardPurchases.lithicTransactionToken, token))
        .limit(1),
    );
    // Lithic may deliver the same request twice; it's already held.
    if (existing) {
      return existing.status === "pending" || existing.status === "settled"
        ? { token, result: "APPROVED" }
        : { token, result: "INSUFFICIENT_FUNDS" };
    }
    // A company-held card turns away a merchant admins didn't recognise, or
    // whose recurring payment is paused, ended or paid another way; any other
    // merchant passes with nobody present (spec §6.25).
    const merchantKey = card.companyHeld
      ? merchantKeyOf(
          request.merchant?.acceptor_id,
          request.merchant?.descriptor,
        )
      : null;
    if (
      merchantKey !== null &&
      (yield* merchantRefused(tx, cardId, merchantKey))
    ) {
      return { token, result: "UNAUTHORIZED_MERCHANT" };
    }
    const spend = spendCents(request);
    if (spend === 0n) return { token, result: "APPROVED" };
    const totals = yield* readCardBalance(tx, organizationId);
    if (spend > totals.available) {
      return { token, result: "INSUFFICIENT_FUNDS" };
    }
    yield* query(() =>
      tx
        .insert(cardPurchases)
        .values({
          organizationId,
          cardId,
          membershipId: card.membershipId,
          lithicTransactionToken: token,
          status: "pending",
          merchant: merchantNameOf(request.merchant?.descriptor),
          merchantKey,
          mcc: request.merchant?.mcc ?? "",
          merchantCity: request.merchant?.city ?? null,
          merchantCountry: request.merchant?.country ?? null,
          holdUsdCents: spend,
          authorizedAt: request.created
            ? new Date(request.created)
            : new Date(),
          categoryId: card.defaultCategoryId,
        })
        .onConflictDoNothing({
          target: cardPurchases.lithicTransactionToken,
        }),
    );
    const left = { ...totals, available: totals.available - spend };
    if (isCardBalanceLow(left)) {
      yield* notify(tx, {
        kind: "card_balance_low",
        organizationId,
        today: nairobiDate(new Date()),
        availableUsdCents: left.available,
      });
    }
    return { token, result: "APPROVED" };
  });
}

/** An unknown card declines; everything else not a spend is simply approved. */
export function authorizeCardRequest(
  request: CardAuthorizationRequest,
): Effect.Effect<AuthorizationDecision, DatabaseError, DatabaseService> {
  const { token, status } = request;
  return Effect.gen(function* () {
    const ref = yield* cardByLithicToken(request.card.token);
    if (!ref) return { token, result: "CARD_PAUSED" } as const;
    const scope = companyScope(ref.organization_id);
    if (SPENDS.has(status)) {
      return yield* withScope(scope, (tx) => holdSpend(tx, ref, request));
    }
    if (status === "BALANCE_INQUIRY") {
      const totals = yield* withScope(scope, (tx) =>
        readCardBalance(tx, ref.organization_id),
      );
      return {
        token,
        result: "APPROVED",
        balance: {
          amount: atLeastZero(totals.loaded + totals.refunded - totals.spent),
          available: atLeastZero(totals.available),
        },
      } as const;
    }
    return { token, result: "APPROVED" } as const;
  });
}
