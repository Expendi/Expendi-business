import { and, eq, inArray, ne, or } from "drizzle-orm";
import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { cardMerchants, cards, recurringItems } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { BadRequest, Conflict } from "../../errors.js";

/**
 * A recurring payment paid by a company-held card (spec §6.20, §6.25):
 * which card may pay it, and what happens to the merchants linked to it
 * when it moves to another card or stops being paid by one. A card's
 * merchants are never deleted: one an admin didn't recognise stays blocked.
 */

export interface PayingCard {
  readonly id: string;
  readonly nickname: string;
  readonly lastFour: string;
}

const pickCompanyHeldCard = new BadRequest({
  message: "Pick one of the company's company-held cards.",
});

/**
 * The company-held card that's to pay a recurring payment, held against
 * closing until the transaction ends. Closing locks the card's row for
 * update while it checks the card pays nothing and asks for the close
 * (`closeCard`), so the two take turns: closing then sees this payment and
 * refuses, or this sees the close asked for and refuses the card. A shared
 * lock, so payments can take the same card at once. Frozen is fine; a
 * person's card, a closed card or another company's isn't.
 */
export function lockPayingCard(
  tx: Transaction,
  organizationId: string,
  cardId: string,
): Effect.Effect<PayingCard, BadRequest | Conflict | DatabaseError> {
  return query(() =>
    tx
      .select({
        id: cards.id,
        nickname: cards.nickname,
        lastFour: cards.lastFour,
        companyHeld: cards.companyHeld,
        state: cards.state,
        closeRequestedAt: cards.closeRequestedAt,
      })
      .from(cards)
      .where(
        and(eq(cards.organizationId, organizationId), eq(cards.id, cardId)),
      )
      .for("share"),
  ).pipe(
    Effect.flatMap(
      ([card]): Effect.Effect<PayingCard, BadRequest | Conflict> => {
        if (!card?.companyHeld) return Effect.fail(pickCompanyHeldCard);
        if (card.state === "closed" || card.closeRequestedAt !== null) {
          const closed = card.state === "closed" ? "closed" : "being closed";
          return Effect.fail(
            new Conflict({
              message: `Card •••• ${card.lastFour} is ${closed}. Pick another company-held card.`,
            }),
          );
        }
        return Effect.succeed({
          id: card.id,
          nickname: card.nickname,
          lastFour: card.lastFour,
        });
      },
    ),
  );
}

export interface MerchantLinkChanges {
  /** Rows the new card gets for merchants it hadn't seen, linked here. */
  readonly added: readonly string[];
  /** The new card's own rows for the same merchants, now linked here. */
  readonly linked: readonly string[];
  /** Rows left behind, linked to nothing. */
  readonly released: readonly string[];
}

const NO_CHANGES: MerchantLinkChanges = { added: [], linked: [], released: [] };

export const changedMerchantLinks = (changes: MerchantLinkChanges): boolean =>
  changes.added.length + changes.linked.length + changes.released.length > 0;

/**
 * Takes the merchant locks a switch or move needs, before the payment's
 * bill and the payment itself (the order in `merchants.ts`): every merchant
 * of the card paying it now and of `toCardId`, and any linked to it. An
 * admin's answer about one of them waits, so it can't link the merchant to
 * the payment while it moves. Returns the card read now, which the caller
 * checks again under the payment's own lock.
 */
export function lockMerchantsToSwitch(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
  toCardId: string | null,
): Effect.Effect<string | null, DatabaseError> {
  return Effect.gen(function* () {
    const [item] = yield* query(() =>
      tx
        .select({ cardId: recurringItems.cardId })
        .from(recurringItems)
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.id, recurringItemId),
          ),
        )
        .limit(1),
    );
    const fromCardId = item?.cardId ?? null;
    // Merchants change only when the payment leaves a card.
    const cardIds =
      fromCardId === null
        ? []
        : [fromCardId, toCardId].filter(
            (cardId): cardId is string => cardId !== null,
          );
    yield* query(() =>
      tx
        .select({ id: cardMerchants.id })
        .from(cardMerchants)
        .where(
          and(
            eq(cardMerchants.organizationId, organizationId),
            or(
              eq(cardMerchants.recurringItemId, recurringItemId),
              cardIds.length === 0
                ? undefined
                : inArray(cardMerchants.cardId, cardIds),
            ),
          ),
        )
        .orderBy(cardMerchants.id)
        .for("update"),
    );
    return fromCardId;
  });
}

/**
 * The recurring payment stops being paid by a card: its merchants stay on
 * the card, linked to nothing, so a later purchase from one asks an admin
 * again.
 */
export function releaseCardMerchants(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
): Effect.Effect<MerchantLinkChanges, DatabaseError> {
  return query(() =>
    tx
      .update(cardMerchants)
      .set({ recurringItemId: null })
      .where(
        and(
          eq(cardMerchants.organizationId, organizationId),
          eq(cardMerchants.recurringItemId, recurringItemId),
        ),
      )
      .returning({ id: cardMerchants.id }),
  ).pipe(
    Effect.map((rows) => ({
      ...NO_CHANGES,
      released: rows.map((row) => row.id),
    })),
  );
}

/**
 * The recurring payment moves to `toCardId`, and the new card takes over
 * the merchants linked to it: a merchant it hasn't seen gets a row there,
 * linked; its own row for one it has seen takes the link unless it's
 * blocked or already pays another of its payments.
 *
 * The old card keeps its rows, released. Were they to move, the old card
 * would forget the merchant, and its next purchase there could take the
 * link of a payment it never paid, as a card's first merchant does.
 */
export function moveCardMerchants(
  tx: Transaction,
  organizationId: string,
  recurringItemId: string,
  toCardId: string,
): Effect.Effect<MerchantLinkChanges, DatabaseError> {
  return Effect.gen(function* () {
    const releasedRows = yield* query(() =>
      tx
        .update(cardMerchants)
        .set({ recurringItemId: null })
        .where(
          and(
            eq(cardMerchants.organizationId, organizationId),
            eq(cardMerchants.recurringItemId, recurringItemId),
            ne(cardMerchants.cardId, toCardId),
          ),
        )
        .returning({
          id: cardMerchants.id,
          merchantKey: cardMerchants.merchantKey,
          descriptor: cardMerchants.descriptor,
        }),
    );
    if (releasedRows.length === 0) return NO_CHANGES;
    const merchants = new Map(
      releasedRows.map((row) => [row.merchantKey, row] as const),
    );
    const seenByNewCard = new Map(
      (yield* query(() =>
        tx
          .select()
          .from(cardMerchants)
          .where(
            and(
              eq(cardMerchants.organizationId, organizationId),
              eq(cardMerchants.cardId, toCardId),
              inArray(cardMerchants.merchantKey, [...merchants.keys()]),
            ),
          )
          .for("update"),
      )).map((row) => [row.merchantKey, row] as const),
    );

    const added: string[] = [];
    const linked: string[] = [];
    for (const merchant of merchants.values()) {
      const existing = seenByNewCard.get(merchant.merchantKey);
      if (existing === undefined) {
        const [row] = yield* query(() =>
          tx
            .insert(cardMerchants)
            .values({
              organizationId,
              cardId: toCardId,
              merchantKey: merchant.merchantKey,
              descriptor: merchant.descriptor,
              recurringItemId,
            })
            .onConflictDoNothing({
              target: [cardMerchants.cardId, cardMerchants.merchantKey],
            })
            .returning({ id: cardMerchants.id }),
        );
        if (row) added.push(row.id);
      } else if (!existing.blocked && existing.recurringItemId === null) {
        yield* query(() =>
          tx
            .update(cardMerchants)
            .set({ recurringItemId })
            .where(eq(cardMerchants.id, existing.id)),
        );
        linked.push(existing.id);
      }
    }
    return {
      added,
      linked,
      released: releasedRows.map((row) => row.id),
    };
  });
}
