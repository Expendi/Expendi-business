import type { SQL } from "drizzle-orm";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  CardBalance,
  CardState,
  RecurringItemState,
} from "@expendi-business/shared";
import { readsWholeCompany } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CardProgram as CardProgramRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import {
  cardLoads,
  cardPrograms,
  cardPurchases,
  cards,
  categories,
  memberships,
  organizations,
  payees,
  platformSettings,
  recurringItems,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
import { hasNotEndedForCardsSql } from "../recurring/card-paid-state.js";
import {
  cardBalanceResponse,
  isCardBalanceLow,
  readCardBalance,
} from "./balance.js";

/**
 * Reading Expendi cards (spec §6.25). Admins and accountants see every card;
 * anyone else only the ones they hold. `spentThisMonthUsdCents` covers
 * purchases authorized this UTC calendar month, the same month Lithic counts
 * a card's limit in.
 */

/** `ExpendiCard` before serialisation turns bigints and dates into strings. */
export interface CardView {
  readonly id: string;
  readonly nickname: string;
  readonly lastFour: string;
  readonly state: CardState;
  readonly monthlyLimitUsdCents: bigint;
  readonly spentThisMonthUsdCents: bigint;
  readonly companyHeld: boolean;
  /** Null exactly when company-held. */
  readonly holder: CardHolderView | null;
  readonly yours: boolean;
  readonly defaultCategory: { readonly id: string; readonly name: string };
  readonly recurringPayments: readonly CardRecurringPaymentView[];
  readonly issuedAt: Date;
  readonly closedAt: Date | null;
}

export interface CardHolderView {
  readonly membershipId: string;
  readonly name: string | null;
  readonly email: string;
}

/** A recurring payment a company-held card pays, while it hasn't ended. */
export interface CardRecurringPaymentView {
  readonly id: string;
  readonly payeeName: string;
  readonly state: RecurringItemState;
}

export interface CardLoadView {
  readonly id: string;
  readonly amountUsdCents: bigint;
  readonly amountKes: bigint;
  readonly usdKesRate: string;
  readonly simulated: boolean;
  readonly loadedBy: string;
  readonly createdAt: Date;
}

export type CardProgramView =
  | { readonly status: "off" }
  | {
      readonly status: "on";
      readonly legalName: string;
      readonly balance: CardBalance;
      readonly lowBalance: boolean;
      readonly paused: boolean;
      readonly turnedOnAt: Date;
    };

export const cardNotFound = new NotFound({
  message: "That card wasn't found.",
});

/** The cards this person may see at all; employees get NotFound for the rest. */
export function visibleCards(tenant: Tenant): SQL | undefined {
  return and(
    eq(cards.organizationId, tenant.organizationId),
    readsWholeCompany(tenant.role)
      ? undefined
      : eq(cards.membershipId, tenant.membershipId),
  );
}

/** Whether ops have paused the company or the platform, and the daily cap. */
export function companyControls(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<
  { readonly paused: boolean; readonly dailyCapKes: bigint },
  DatabaseError
> {
  return Effect.gen(function* () {
    const [company] = yield* query(() =>
      tx
        .select({
          paused: organizations.payoutsPaused,
          dailyCapKes: organizations.dailyPayoutCapKes,
        })
        .from(organizations)
        .where(eq(organizations.id, organizationId)),
    );
    const [platform] = yield* query(() =>
      tx
        .select({ paused: platformSettings.payoutsPaused })
        .from(platformSettings)
        .limit(1),
    );
    return {
      paused: !company || company.paused || (platform?.paused ?? true),
      dailyCapKes: company?.dailyCapKes ?? 0n,
    };
  });
}

/** The program's "on" answer, read fresh. */
export function programOn(
  tx: Transaction,
  program: CardProgramRow,
): Effect.Effect<Extract<CardProgramView, { status: "on" }>, DatabaseError> {
  return Effect.gen(function* () {
    const totals = yield* readCardBalance(tx, program.organizationId);
    const { paused } = yield* companyControls(tx, program.organizationId);
    return {
      status: "on",
      legalName: program.legalName,
      balance: cardBalanceResponse(totals),
      lowBalance: isCardBalanceLow(totals),
      paused,
      turnedOnAt: program.createdAt,
    };
  });
}

export function getCardProgram(
  tenant: Tenant,
): Effect.Effect<CardProgramView, DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [program] = yield* query(() =>
        tx
          .select()
          .from(cardPrograms)
          .where(eq(cardPrograms.organizationId, tenant.organizationId))
          .limit(1),
      );
      if (!program) return { status: "off" as const };
      return yield* programOn(tx, program);
    }),
  );
}

const startOfUtcMonth = sql`(date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')`;

function selectCards(tx: Transaction, where: SQL | undefined) {
  return tx
    .select({
      id: cards.id,
      nickname: cards.nickname,
      lastFour: cards.lastFour,
      state: cards.state,
      monthlyLimitUsdCents: cards.monthlyLimitUsdCents,
      spentThisMonth: sql<string>`(
        SELECT coalesce(sum(${cardPurchases.settledUsdCents} + ${cardPurchases.holdUsdCents}), 0)::text
        FROM ${cardPurchases}
        WHERE ${cardPurchases.cardId} = ${cards.id}
          AND ${cardPurchases.kind} = 'purchase'
          AND ${cardPurchases.authorizedAt} >= ${startOfUtcMonth}
      )`,
      companyHeld: cards.companyHeld,
      membershipId: cards.membershipId,
      holderName: users.fullName,
      holderEmail: users.email,
      categoryId: categories.id,
      categoryName: categories.name,
      issuedAt: cards.createdAt,
      closedAt: cards.closedAt,
    })
    .from(cards)
    .leftJoin(memberships, eq(memberships.id, cards.membershipId))
    .leftJoin(users, eq(users.id, memberships.userId))
    .innerJoin(categories, eq(categories.id, cards.defaultCategoryId))
    .where(where);
}

type CardListRow = Awaited<ReturnType<typeof selectCards>>[number];

/** The cardholder of a card or purchase; null on a company-held card. */
export function cardHolderView(
  membershipId: string | null,
  name: string | null,
  email: string | null,
): CardHolderView | null {
  return membershipId === null || email === null
    ? null
    : { membershipId, name, email };
}

function toCardView(
  tenant: Tenant,
  row: CardListRow,
  recurringPayments: readonly CardRecurringPaymentView[],
): CardView {
  return {
    id: row.id,
    nickname: row.nickname,
    lastFour: row.lastFour,
    state: row.state,
    monthlyLimitUsdCents: row.monthlyLimitUsdCents,
    spentThisMonthUsdCents: BigInt(row.spentThisMonth),
    companyHeld: row.companyHeld,
    holder: cardHolderView(row.membershipId, row.holderName, row.holderEmail),
    yours:
      row.membershipId !== null && row.membershipId === tenant.membershipId,
    defaultCategory: { id: row.categoryId, name: row.categoryName },
    recurringPayments,
    issuedAt: row.issuedAt,
    closedAt: row.closedAt,
  };
}

/**
 * The recurring payments each card pays that haven't ended, oldest first.
 * Only admins and accountants can read recurring payments, and only a
 * company-held card has any.
 */
function recurringPaymentsByCard(
  tx: Transaction,
  organizationId: string,
  cardIds: readonly string[],
): Effect.Effect<
  ReadonlyMap<string, readonly CardRecurringPaymentView[]>,
  DatabaseError
> {
  if (cardIds.length === 0) return Effect.succeed(new Map());
  return query(() =>
    tx
      .select({
        cardId: recurringItems.cardId,
        id: recurringItems.id,
        payeeName: payees.name,
        active: recurringItems.active,
      })
      .from(recurringItems)
      .innerJoin(payees, eq(payees.id, recurringItems.payeeId))
      .where(
        and(
          eq(recurringItems.organizationId, organizationId),
          inArray(recurringItems.cardId, [...cardIds]),
          hasNotEndedForCardsSql(),
        ),
      )
      .orderBy(asc(recurringItems.createdAt), asc(recurringItems.id)),
  ).pipe(
    Effect.map((rows) => {
      const byCard = new Map<string, CardRecurringPaymentView[]>();
      for (const row of rows) {
        if (row.cardId === null) continue;
        const payments = byCard.get(row.cardId) ?? [];
        payments.push({
          id: row.id,
          payeeName: row.payeeName,
          state: row.active ? "active" : "paused",
        });
        byCard.set(row.cardId, payments);
      }
      return byCard;
    }),
  );
}

function toCardViews(
  tx: Transaction,
  tenant: Tenant,
  rows: readonly CardListRow[],
): Effect.Effect<CardView[], DatabaseError> {
  return recurringPaymentsByCard(
    tx,
    tenant.organizationId,
    rows.filter((row) => row.companyHeld).map((row) => row.id),
  ).pipe(
    Effect.map((payments) =>
      rows.map((row) => toCardView(tenant, row, payments.get(row.id) ?? [])),
    ),
  );
}

export function readCardView(
  tx: Transaction,
  tenant: Tenant,
  cardId: string,
): Effect.Effect<CardView, NotFound | DatabaseError> {
  return query(() =>
    selectCards(tx, and(visibleCards(tenant), eq(cards.id, cardId))).limit(1),
  ).pipe(
    Effect.flatMap((rows) => toCardViews(tx, tenant, rows)),
    Effect.flatMap(([card]) =>
      card ? Effect.succeed(card) : Effect.fail(cardNotFound),
    ),
  );
}

export function getCard(
  tenant: Tenant,
  cardId: string,
): Effect.Effect<CardView, NotFound | DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) => readCardView(tx, tenant, cardId));
}

export function listCards(
  tenant: Tenant,
  filters: {
    readonly state?: CardState | undefined;
    readonly mine?: boolean | undefined;
    readonly companyHeld?: boolean | undefined;
  },
): Effect.Effect<
  { readonly cards: readonly CardView[] },
  DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    query(() =>
      selectCards(
        tx,
        and(
          visibleCards(tenant),
          filters.state ? eq(cards.state, filters.state) : undefined,
          filters.mine
            ? eq(cards.membershipId, tenant.membershipId)
            : undefined,
          filters.companyHeld === undefined
            ? undefined
            : eq(cards.companyHeld, filters.companyHeld),
        ),
      ).orderBy(desc(cards.createdAt), desc(cards.id)),
    ).pipe(Effect.flatMap((rows) => toCardViews(tx, tenant, rows))),
  ).pipe(Effect.map((views) => ({ cards: views })));
}

export function listCardLoads(
  tenant: Tenant,
): Effect.Effect<
  { readonly loads: readonly CardLoadView[] },
  DatabaseError,
  DatabaseService
> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select({
          id: cardLoads.id,
          amountUsdCents: cardLoads.amountUsdCents,
          amountKes: cardLoads.amountKes,
          usdKesRate: cardLoads.usdKesRate,
          simulated: cardLoads.simulated,
          loadedByName: users.fullName,
          loadedByEmail: users.email,
          createdAt: cardLoads.createdAt,
        })
        .from(cardLoads)
        .innerJoin(users, eq(users.id, cardLoads.loadedBy))
        .where(eq(cardLoads.organizationId, tenant.organizationId))
        .orderBy(desc(cardLoads.createdAt), desc(cardLoads.id)),
    ),
  ).pipe(
    Effect.map((rows) => ({
      loads: rows.map((row) => ({
        id: row.id,
        amountUsdCents: row.amountUsdCents,
        amountKes: row.amountKes,
        usdKesRate: row.usdKesRate,
        simulated: row.simulated,
        loadedBy: row.loadedByName ?? row.loadedByEmail,
        createdAt: row.createdAt,
      })),
    })),
  );
}
