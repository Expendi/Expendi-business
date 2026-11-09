import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Lithic } from "../lithic/lithic-client.js";
import { cards, organizations } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { cardCloseFailed } from "../alerts/alert-checks.js";
import { raiseAlert } from "../alerts/ops-alerts.js";
import { AuditLog } from "../audit/audit-log.js";
import { exclusively } from "./issuer.js";
import { cardLock, CLOSE_ALERT_ATTEMPTS, closeAtIssuer } from "./manage.js";

/**
 * A leaver's cards (spec §6.25). Removing someone, or making them an
 * accountant, marks their cards for closing in that same transaction. Lithic
 * is called afterwards by the close-cards job, so a card is closed even if
 * Lithic is down at the moment they leave.
 */

const JOB_BATCH = 50;
const JOB_ACTOR: AuditActor = { type: "system", id: "close-cards" };

/** Marks the member's cards to close; run in the transaction ending their access. */
export function requestCardClosures(
  tx: Transaction,
  input: {
    readonly organizationId: string;
    readonly membershipId: string;
    readonly actor: AuditActor;
  },
): Effect.Effect<void, DatabaseError, AuditLog> {
  return Effect.gen(function* () {
    const audit = yield* AuditLog;
    const marked = yield* query(() =>
      tx
        .update(cards)
        .set({ closeRequestedAt: new Date() })
        .where(
          and(
            eq(cards.organizationId, input.organizationId),
            eq(cards.membershipId, input.membershipId),
            ne(cards.state, "closed"),
            isNull(cards.closeRequestedAt),
          ),
        )
        .returning({ id: cards.id }),
    );
    for (const card of marked) {
      yield* audit.record(tx, {
        actor: input.actor,
        organizationId: input.organizationId,
        action: "card.close_requested",
        entity: { type: "card", id: card.id },
      });
    }
  });
}

interface CardToClose extends Record<string, unknown> {
  readonly card_id: string;
  readonly organization_id: string;
}

type Outcome = "closed" | "failed" | "skipped";

function bumpCloseAttempts(
  organizationId: string,
  cardId: string,
): Effect.Effect<number, DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .update(cards)
        .set({ closeAttempts: sql`${cards.closeAttempts} + 1` })
        .where(
          and(eq(cards.id, cardId), eq(cards.organizationId, organizationId)),
        )
        .returning({ attempts: cards.closeAttempts }),
    ),
  ).pipe(Effect.map(([row]) => row?.attempts ?? 0));
}

function closeOne({
  card_id: cardId,
  organization_id: organizationId,
}: CardToClose): Effect.Effect<
  Outcome,
  DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  return exclusively(
    cardLock(cardId),
    Effect.gen(function* () {
      const [row] = yield* withScope({ organizationId }, (tx) =>
        query(() =>
          tx
            .select({ card: cards, company: organizations.name })
            .from(cards)
            .innerJoin(
              organizations,
              eq(organizations.id, cards.organizationId),
            )
            .where(eq(cards.id, cardId))
            .limit(1),
        ),
      );
      if (!row || row.card.state === "closed") return "skipped" as const;

      const closed = yield* Effect.exit(
        closeAtIssuer({ organizationId }, row.card, JOB_ACTOR),
      );
      if (Exit.isSuccess(closed)) return "closed" as const;

      const attempts = yield* bumpCloseAttempts(organizationId, cardId);
      console.error(
        `[close-cards] card ${cardId} not closed, attempt ${attempts}`,
      );
      if (attempts === CLOSE_ALERT_ATTEMPTS) {
        yield* raiseAlert(
          cardCloseFailed({
            cardId,
            organizationId,
            organizationName: row.company,
            lastFour: row.card.lastFour,
            attempts,
          }),
        );
      }
      return "failed" as const;
    }),
  ).pipe(
    // Someone is changing this card right now; the next run picks it up.
    Effect.catchTag("Conflict", () => Effect.succeed("skipped" as const)),
  );
}

/** One pass of the close-cards job; a card that fails doesn't stop the rest. */
export function closeRequestedCards(): Effect.Effect<
  {
    readonly attempted: number;
    readonly closed: number;
    readonly failed: number;
  },
  DatabaseError,
  DatabaseService | AuditLog | Lithic
> {
  return Effect.gen(function* () {
    const { rows } = yield* withScope({}, (tx) =>
      query(() =>
        tx.execute<CardToClose>(
          sql`SELECT * FROM cards_to_close(${JOB_BATCH})`,
        ),
      ),
    );
    let closed = 0;
    let failed = 0;
    for (const row of rows) {
      const exit = yield* Effect.exit(closeOne(row));
      if (Exit.isFailure(exit)) {
        failed += 1;
        console.error(
          `[close-cards] card ${row.card_id} failed`,
          Cause.pretty(exit.cause),
        );
      } else if (exit.value === "closed") {
        closed += 1;
      } else if (exit.value === "failed") {
        failed += 1;
      }
    }
    return { attempted: rows.length, closed, failed };
  });
}
