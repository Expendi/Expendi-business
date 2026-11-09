import type { SQL } from "drizzle-orm";
import { and, desc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { CardBalance, CardState } from "@expendi-business/shared";
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
  platformSettings,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { NotFound } from "../../errors.js";
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
  readonly holder: {
    readonly membershipId: string;
    readonly name: string | null;
    readonly email: string;
  };
  readonly yours: boolean;
  readonly defaultCategory: { readonly id: string; readonly name: string };
  readonly issuedAt: Date;
  readonly closedAt: Date | null;
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
      membershipId: cards.membershipId,
      holderName: users.fullName,
      holderEmail: users.email,
      categoryId: categories.id,
      categoryName: categories.name,
      issuedAt: cards.createdAt,
      closedAt: cards.closedAt,
    })
    .from(cards)
    .innerJoin(memberships, eq(memberships.id, cards.membershipId))
    .innerJoin(users, eq(users.id, memberships.userId))
    .innerJoin(categories, eq(categories.id, cards.defaultCategoryId))
    .where(where);
}

type CardListRow = Awaited<ReturnType<typeof selectCards>>[number];

function toCardView(tenant: Tenant, row: CardListRow): CardView {
  return {
    id: row.id,
    nickname: row.nickname,
    lastFour: row.lastFour,
    state: row.state,
    monthlyLimitUsdCents: row.monthlyLimitUsdCents,
    spentThisMonthUsdCents: BigInt(row.spentThisMonth),
    holder: {
      membershipId: row.membershipId,
      name: row.holderName,
      email: row.holderEmail,
    },
    yours: row.membershipId === tenant.membershipId,
    defaultCategory: { id: row.categoryId, name: row.categoryName },
    issuedAt: row.issuedAt,
    closedAt: row.closedAt,
  };
}

export function readCardView(
  tx: Transaction,
  tenant: Tenant,
  cardId: string,
): Effect.Effect<CardView, NotFound | DatabaseError> {
  return query(() =>
    selectCards(tx, and(visibleCards(tenant), eq(cards.id, cardId))).limit(1),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(toCardView(tenant, row)) : Effect.fail(cardNotFound),
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
        ),
      ).orderBy(desc(cards.createdAt), desc(cards.id)),
    ),
  ).pipe(
    Effect.map((rows) => ({
      cards: rows.map((row) => toCardView(tenant, row)),
    })),
  );
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
