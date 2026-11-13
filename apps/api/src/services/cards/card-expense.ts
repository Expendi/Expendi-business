import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { CardPurchase } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { cardPrograms, cards, memberships } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * The reason a Card expense goes without a receipt when admins didn't
 * recognise its merchant: nobody has one, and the expense still has to
 * reach the books.
 */
export const NOT_RECOGNISED_REASON = "Not recognised by an admin";

export interface CardExpenseSource {
  readonly membershipId: string;
  readonly paidFromAccountId: string;
  readonly description: string;
}

/**
 * Whose spending a Card purchase records, and from which account: the
 * cardholder's, or, on a company-held card, which has no cardholder, the
 * admin who issued it (spec §6.25); always the card program's "Expendi
 * cards" account.
 */
export function cardExpenseSource(
  tx: Transaction,
  purchase: Pick<CardPurchase, "id" | "cardId" | "membershipId">,
): Effect.Effect<CardExpenseSource, DatabaseError> {
  return Effect.gen(function* () {
    const [card] = yield* query(() =>
      tx
        .select({
          nickname: cards.nickname,
          lastFour: cards.lastFour,
          issuerMembershipId: memberships.id,
          paidFromAccountId: cardPrograms.paidFromAccountId,
        })
        .from(cards)
        .innerJoin(
          cardPrograms,
          eq(cardPrograms.organizationId, cards.organizationId),
        )
        .leftJoin(
          memberships,
          and(
            eq(memberships.organizationId, cards.organizationId),
            eq(memberships.userId, cards.issuedBy),
          ),
        )
        .where(eq(cards.id, purchase.cardId))
        .limit(1),
    );
    if (!card) {
      return yield* Effect.dieMessage(
        `purchase ${purchase.id}: its card or program vanished`,
      );
    }
    const membershipId = purchase.membershipId ?? card.issuerMembershipId;
    if (membershipId === null) {
      return yield* Effect.dieMessage(
        `purchase ${purchase.id}: its card's issuer has no membership`,
      );
    }
    return {
      membershipId,
      paidFromAccountId: card.paidFromAccountId,
      description: `Expendi card ${card.nickname}, ending ${card.lastFour}`,
    };
  });
}
