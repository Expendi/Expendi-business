import type { SQL } from "drizzle-orm";
import { and, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { IntentQuote } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { OneClick, OneClickSession } from "./one-click.js";
import { intentQuotes } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { refreshQuoteStatus } from "./quote-status.js";

/**
 * Settling a quote Expendi pays itself from what 1Click reports. Kept apart
 * from the code that pays a deposit address (quote-deposit.ts, sweep.ts) so
 * the staff routes can settle a quote under review through this same path
 * without reaching anything that signs: `internal-routes.test.ts` follows
 * their imports.
 */

/**
 * No deposit is started with less than this left before the deadline: a
 * company wallet send stays valid for about two minutes, and one that lands
 * after the deadline is only refunded.
 */
export const DEPOSIT_MARGIN_MS = 3 * 60_000;

/** A deposit 1Click hasn't settled this long after the deadline is for a person. */
export const UNSETTLED_REVIEW_MS = 30 * 60_000;

/** The key of the one company wallet send that pays a quote. */
export const quoteSendKey = (quoteId: string): string => `quote:${quoteId}`;

export const quoteById = (organizationId: string, quoteId: string) =>
  withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(intentQuotes)
        .where(
          and(
            eq(intentQuotes.id, quoteId),
            eq(intentQuotes.organizationId, organizationId),
          ),
        )
        .limit(1),
    ),
  ).pipe(
    Effect.flatMap(([quote]) =>
      quote
        ? Effect.succeed(quote)
        : Effect.dieMessage("intent quote vanished"),
    ),
  );

/**
 * Changes a quote only if it is still as the caller last saw it (`when`).
 * Null means someone else moved it first; the caller re-reads and stops.
 */
export const moveQuote = (
  quote: Pick<IntentQuote, "id" | "organizationId">,
  when: SQL | undefined,
  changes: Partial<typeof intentQuotes.$inferInsert>,
) =>
  withScope({ organizationId: quote.organizationId }, (tx) =>
    query(() =>
      tx
        .update(intentQuotes)
        .set(changes)
        .where(and(eq(intentQuotes.id, quote.id), when))
        .returning(),
    ),
  ).pipe(Effect.map(([moved]) => moved ?? null));

export const orCurrent = (
  quote: IntentQuote,
  moved: IntentQuote | null,
): Effect.Effect<IntentQuote, DatabaseError, DatabaseService> =>
  moved ? Effect.succeed(moved) : quoteById(quote.organizationId, quote.id);

/**
 * Brings a quote's lifecycle status in line with what 1Click reports for
 * its deposit address, saving 1Click's fields (transaction hashes included)
 * on the way. A quote that touches a confidential account needs the
 * company's `session` to be heard about. Shared by every quote Expendi pays
 * itself:
 *
 * - `SUCCESS` and `REFUNDED` are final, whatever we knew before: they also
 *   resolve a quote under review whose deposit we lost track of;
 * - `FAILED` is for a person: the deposit is somewhere inside 1Click;
 * - a deposit 1Click still hasn't settled long after the deadline is for a
 *   person too.
 *
 * 1Click not answering, or not knowing the deposit address yet, changes
 * nothing.
 */
export function settleFromOneClick(
  quote: IntentQuote,
  session?: OneClickSession,
): Effect.Effect<IntentQuote, DatabaseError, OneClick | DatabaseService> {
  return Effect.gen(function* () {
    const refreshed = yield* refreshQuoteStatus(quote, session).pipe(
      Effect.catchTags({
        OneClickRefused: () => Effect.succeed(null),
        OneClickOutcomeUnknown: () => Effect.succeed(null),
      }),
    );
    const open = inArray(intentQuotes.status, ["depositing", "needs_review"]);
    const reported = refreshed?.oneClickStatus ?? null;
    if (refreshed && reported === "SUCCESS") {
      return yield* orCurrent(
        refreshed,
        yield* moveQuote(refreshed, open, {
          status: "succeeded",
          settledAt: new Date(),
          failure: null,
        }),
      );
    }
    if (refreshed && reported === "REFUNDED") {
      return yield* orCurrent(
        refreshed,
        yield* moveQuote(refreshed, open, {
          status: "refunded",
          settledAt: new Date(),
          failure: refreshed.refundReason,
        }),
      );
    }
    const current = refreshed ?? quote;
    if (current.status !== "depositing") return current;
    if (reported === "FAILED") {
      return yield* orCurrent(
        current,
        yield* moveQuote(current, eq(intentQuotes.status, "depositing"), {
          status: "needs_review",
          failure:
            "1Click reports the swap FAILED after the deposit. Ask NEAR Intents where the deposit is before doing anything.",
        }),
      );
    }
    if (Date.now() > current.deadline.getTime() + UNSETTLED_REVIEW_MS) {
      return yield* orCurrent(
        current,
        yield* moveQuote(current, eq(intentQuotes.status, "depositing"), {
          status: "needs_review",
          failure: `1Click still reports ${reported ?? "nothing"} long after the deadline. Check the deposit address before doing anything.`,
        }),
      );
    }
    return current;
  });
}
