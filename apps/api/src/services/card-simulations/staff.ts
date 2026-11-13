import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CardSimulationResult,
  StaffCardPaidPayment,
  StaffCardSimulations,
} from "@expendi-business/shared";
import { DATED_BILL_STATUSES } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { StaffMember } from "../staff/staff-auth.js";
import type { SimulateError } from "./simulate.js";
import {
  bills,
  cardPurchases,
  cards,
  cardSimulations,
  payees,
  recurringItems,
} from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { hasNotEndedForCardsSql } from "../recurring/card-paid-state.js";
import { UUID } from "../staff/paging.js";
import { LithicSimulator } from "./lithic-simulator.js";
import {
  isUnconfirmedToken,
  simulateCardPurchase,
  usdCentsOf,
  withCompanyReadScope,
} from "./simulate.js";

/**
 * Ops admin's "Company-held cards (sandbox)" panel (spec §6.25): the
 * company's recurring payments paid by a company-held card, and running
 * the pretend merchant's purchase for one of them now. Never shown to the
 * company itself.
 */

const noSuchCompany = new NotFound({ message: "No company with this ID" });

type LastSimulation = NonNullable<StaffCardPaidPayment["lastSimulation"]>;

function lastSimulations(
  tx: Transaction,
  organizationId: string,
  itemIds: readonly string[],
): Effect.Effect<Map<string, LastSimulation>, DatabaseError> {
  if (itemIds.length === 0) {
    return Effect.succeed(new Map<string, LastSimulation>());
  }
  return query(() =>
    tx
      .selectDistinctOn([cardSimulations.recurringItemId], {
        recurringItemId: cardSimulations.recurringItemId,
        createdAt: cardSimulations.createdAt,
        amountUsdCents: cardSimulations.amountUsdCents,
        merchantKey: cardSimulations.merchantKey,
        runByStaff: cardSimulations.runByStaff,
        transactionToken: cardSimulations.lithicTransactionToken,
        purchaseStatus: cardPurchases.status,
      })
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
          eq(cardSimulations.organizationId, organizationId),
          inArray(cardSimulations.recurringItemId, [...itemIds]),
        ),
      )
      .orderBy(
        asc(cardSimulations.recurringItemId),
        desc(cardSimulations.createdAt),
        desc(cardSimulations.id),
      ),
  ).pipe(
    Effect.map(
      (rows) =>
        new Map(
          rows.map((row) => [
            row.recurringItemId,
            {
              at: row.createdAt.toISOString(),
              amountUsdCents: row.amountUsdCents.toString(),
              merchantKey: row.merchantKey,
              result: isUnconfirmedToken(row.transactionToken)
                ? "unknown"
                : row.purchaseStatus === null
                  ? null
                  : row.purchaseStatus === "declined"
                    ? "declined"
                    : "approved",
              byStaff: row.runByStaff !== null,
            },
          ]),
        ),
    ),
  );
}

function readPayments(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<StaffCardPaidPayment[], DatabaseError> {
  return Effect.gen(function* () {
    const items = yield* query(() =>
      tx
        .select({
          id: recurringItems.id,
          active: recurringItems.active,
          estimateUsdc: recurringItems.amountUsdc,
          payeeName: payees.name,
          cardNickname: cards.nickname,
          cardLastFour: cards.lastFour,
          cardState: cards.state,
        })
        .from(recurringItems)
        .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
        .innerJoin(cards, eq(cards.id, recurringItems.cardId))
        .where(
          and(
            eq(recurringItems.organizationId, organizationId),
            eq(recurringItems.payVia, "card"),
            hasNotEndedForCardsSql(),
          ),
        )
        .orderBy(asc(payees.name), asc(recurringItems.id)),
    );
    const itemIds = items.map(({ id }) => id);
    const openBills =
      itemIds.length === 0
        ? []
        : yield* query(() =>
            tx
              .select({
                id: bills.id,
                recurringItemId: bills.recurringItemId,
                dueOn: bills.dueOn,
                status: bills.status,
                amountUsdc: bills.amountUsdc,
              })
              .from(bills)
              .where(
                and(
                  eq(bills.organizationId, organizationId),
                  inArray(bills.recurringItemId, itemIds),
                  inArray(bills.status, [...DATED_BILL_STATUSES]),
                ),
              )
              .orderBy(asc(bills.dueOn), asc(bills.id)),
          );
    const latest = yield* lastSimulations(tx, organizationId, itemIds);
    return items.map((item) => {
      const bill = openBills.find(
        ({ recurringItemId }) => recurringItemId === item.id,
      );
      const estimate = usdCentsOf(item.estimateUsdc);
      const billAmount = usdCentsOf(bill?.amountUsdc ?? null);
      return {
        id: item.id,
        payeeName: item.payeeName,
        state: item.active ? "active" : "paused",
        estimateUsdCents: estimate === null ? null : estimate.toString(),
        card: {
          nickname: item.cardNickname,
          lastFour: item.cardLastFour,
          state: item.cardState,
        },
        nextBill: bill
          ? {
              id: bill.id,
              dueOn: bill.dueOn,
              status: bill.status,
              amountUsdCents:
                billAmount === null ? null : billAmount.toString(),
            }
          : null,
        lastSimulation: latest.get(item.id) ?? null,
      };
    });
  });
}

/** For every staff role: looking changes nothing. */
export function staffCardSimulations(
  organizationId: string,
): Effect.Effect<
  StaffCardSimulations,
  NotFound | DatabaseError,
  DatabaseService | LithicSimulator
> {
  if (!UUID.test(organizationId)) return Effect.fail(noSuchCompany);
  return Effect.gen(function* () {
    const simulator = yield* LithicSimulator;
    const payments = yield* withCompanyReadScope(organizationId, (tx) =>
      readPayments(tx, organizationId),
    );
    return { available: simulator.configured, payments };
  });
}

/** For an ops admin only; the route enforces it. Audited under the staff member. */
export function runStaffCardSimulation(
  staff: StaffMember,
  organizationId: string,
  request: {
    readonly recurringItemId: string;
    readonly amountUsd?: bigint | undefined;
    readonly newMerchant?: boolean | undefined;
  },
): Effect.Effect<
  CardSimulationResult,
  SimulateError,
  DatabaseService | LithicSimulator | AuditLog
> {
  if (!UUID.test(organizationId)) return Effect.fail(noSuchCompany);
  return simulateCardPurchase({
    organizationId,
    recurringItemId: request.recurringItemId,
    ...(request.amountUsd !== undefined && {
      amountUsdCents: request.amountUsd,
    }),
    newMerchant: request.newMerchant ?? false,
    runBy: { kind: "staff", staffUserId: staff.staffUserId },
  }).pipe(
    Effect.map(({ transactionToken, result, merchant }) => ({
      transactionToken,
      result,
      merchant,
    })),
  );
}
