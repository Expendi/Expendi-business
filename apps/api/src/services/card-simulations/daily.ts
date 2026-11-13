import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  lte,
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { Cause, Effect, Exit } from "effect";

import { DATED_BILL_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import {
  bills,
  cardPurchases,
  cards,
  cardSimulations,
  recurringItems,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { nairobiDate } from "../bills/status.js";
import { hasNotEndedForCardsSql } from "../recurring/card-paid-state.js";
import { LithicSimulator } from "./lithic-simulator.js";
import { simulateCardPurchase, withCompanyReadScope } from "./simulate.js";

/**
 * The pretend merchant's daily round (spec §6.25): on and after each
 * card-paid bill's due date, the Card purchase a real merchant would make.
 *
 * A bill is charged again only when its last purchase was declined, and
 * not within `RETRY_AFTER_MS` of the last try, so a second instance or a
 * quick re-run never makes two, and a declined one is tried again the
 * next day, as a merchant would.
 */

export const RETRY_AFTER_MS = 20 * 60 * 60 * 1000;

/** Two sandbox writes each, at about one a second: under a minute a run. */
export const MAX_SIMULATIONS_PER_RUN = 20;

export interface CardSimulationsRun {
  /** The Nairobi day the run used. */
  readonly today: string;
  readonly approved: number;
  readonly declined: number;
  /** Made, but Lithic didn't say whether the purchase check approved it. */
  readonly unknown: number;
  readonly failed: number;
}

interface DueBill {
  readonly billId: string;
  readonly recurringItemId: string;
}

function dueBills(
  tx: Transaction,
  organizationId: string,
  today: string,
  at: Date,
  limit: number,
): Effect.Effect<DueBill[], DatabaseError> {
  const retryBefore = new Date(at.getTime() - RETRY_AFTER_MS);
  // An attempt Lithic never confirmed has a token no Card purchase carries,
  // so only the retry window holds it back.
  const settledOrRecent = tx
    .select({ id: cardSimulations.id })
    .from(cardSimulations)
    .leftJoin(
      cardPurchases,
      eq(
        cardPurchases.lithicTransactionToken,
        cardSimulations.lithicTransactionToken,
      ),
    )
    .where(
      and(
        eq(cardSimulations.billId, bills.id),
        or(
          gt(cardSimulations.createdAt, retryBefore),
          ne(cardPurchases.status, "declined"),
        ),
      ),
    );
  return query(() =>
    tx
      .select({ billId: bills.id, recurringItemId: recurringItems.id })
      .from(bills)
      .innerJoin(recurringItems, eq(recurringItems.id, bills.recurringItemId))
      .innerJoin(cards, eq(cards.id, recurringItems.cardId))
      .where(
        and(
          eq(bills.organizationId, organizationId),
          inArray(bills.status, [...DATED_BILL_STATUSES]),
          lte(bills.dueOn, today),
          eq(recurringItems.payVia, "card"),
          eq(recurringItems.active, true),
          hasNotEndedForCardsSql(),
          eq(cards.companyHeld, true),
          ne(cards.state, "closed"),
          or(isNotNull(bills.amountUsdc), isNotNull(recurringItems.amountUsdc)),
          notExists(settledOrRecent),
        ),
      )
      .orderBy(asc(bills.dueOn), asc(bills.id))
      .limit(limit),
  );
}

/**
 * Every company with a bill still owed, as the reminders read them; which
 * of those are card-paid and due is read in each company's own scope.
 */
function companiesWithBillsOwed(): Effect.Effect<
  string[],
  DatabaseError,
  DatabaseService
> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<{ organization_id: string }>(
        sql`SELECT organization_id FROM reminder_companies()`,
      ),
    ),
  ).pipe(
    Effect.map(({ rows }) => rows.map((row) => row.organization_id).sort()),
  );
}

/** Null when Lithic's sandbox isn't set up: there is no card to charge. */
export function runDueCardSimulations(
  now?: Date,
  maxPerRun: number = MAX_SIMULATIONS_PER_RUN,
): Effect.Effect<
  CardSimulationsRun | null,
  DatabaseError,
  DatabaseService | LithicSimulator | AuditLog
> {
  return Effect.gen(function* () {
    const simulator = yield* LithicSimulator;
    if (!simulator.configured) return null;
    const at = now ?? new Date();
    const today = nairobiDate(at);
    let approved = 0;
    let declined = 0;
    let unknown = 0;
    let failed = 0;
    for (const organizationId of yield* companiesWithBillsOwed()) {
      const left = maxPerRun - approved - declined - unknown - failed;
      if (left <= 0) break;
      const found = yield* Effect.exit(
        withCompanyReadScope(organizationId, (tx) =>
          dueBills(tx, organizationId, today, at, left),
        ),
      );
      if (Exit.isFailure(found)) {
        failed += 1;
        console.error(
          `[card-simulations] company ${organizationId} failed`,
          Cause.pretty(found.cause),
        );
        continue;
      }
      for (const bill of found.value) {
        const exit = yield* Effect.exit(
          simulateCardPurchase({
            organizationId,
            recurringItemId: bill.recurringItemId,
            billId: bill.billId,
            runBy: { kind: "job" },
            now: at,
          }),
        );
        if (Exit.isFailure(exit)) {
          failed += 1;
          console.error(
            `[card-simulations] bill ${bill.billId} failed`,
            Cause.pretty(exit.cause),
          );
        } else if (exit.value.result === "approved") {
          approved += 1;
        } else if (exit.value.result === "declined") {
          declined += 1;
        } else {
          unknown += 1;
        }
      }
    }
    return { today, approved, declined, unknown, failed };
  });
}
