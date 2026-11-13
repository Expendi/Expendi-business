import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { CardPurchaseStatus } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { NewBill, NewRecurringItem } from "../../db/schema/index.js";
import type { CardCompany } from "./card-purchases.js";
import type { TestCompany } from "./db.js";
import {
  cardPurchases,
  cards,
  cardSimulations,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { insertBill, insertPayee } from "./bills.js";
import { addCompanyHeldCard } from "./card-purchases.js";
import { insertRecurringItem } from "./recurring.js";

/** USD 20.00 a month, the estimate a card-paid payment gets by default. */
export const ESTIMATE_USDC = 20_000_000n;

export interface CardPaidPayment {
  readonly company: TestCompany;
  readonly categoryId: string;
  readonly cardId: string;
  readonly cardToken: string;
  readonly payeeId: string;
  readonly itemId: string;
}

/**
 * A recurring payment paid by its own company-held card, monthly with a USD
 * estimate, on a company with cards on. No bill yet.
 */
export async function cardPaidPayment(
  db: Database,
  card: Pick<CardCompany, "company" | "categoryId">,
  {
    payeeName = "Anthropic",
    item = {},
    cardValues = {},
  }: {
    readonly payeeName?: string;
    readonly item?: Partial<NewRecurringItem>;
    readonly cardValues?: Partial<typeof cards.$inferInsert>;
  } = {},
): Promise<CardPaidPayment> {
  const { company, categoryId } = card;
  const { cardId, cardToken } = await addCompanyHeldCard(db, company, {
    defaultCategoryId: categoryId,
    ...cardValues,
  });
  const payeeId = await insertPayee(db, company, {
    kind: "vendor",
    name: payeeName,
  });
  const itemId = await insertRecurringItem(db, company, {
    payeeId,
    categoryId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: ESTIMATE_USDC,
    payVia: "card",
    cardId,
    startsOn: "2026-01-01",
    nextDueOn: "2026-12-13",
    ...item,
  });
  return { company, categoryId, cardId, cardToken, payeeId, itemId };
}

/** The payment's bill still owed, in USD; by default the estimate, due 13 Nov 2026. */
export function cardPaidBill(
  db: Database,
  payment: CardPaidPayment,
  values: Partial<NewBill> = {},
): Promise<string> {
  return insertBill(db, payment.company, {
    payeeId: payment.payeeId,
    categoryId: payment.categoryId,
    recurringItemId: payment.itemId,
    overviewHeading: "subscriptions",
    currency: "usd",
    amountKes: null,
    amountUsdc: ESTIMATE_USDC,
    dueOn: "2026-11-13",
    status: "due",
    ...values,
  });
}

export function simulationsOf(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
) {
  return runInScope(db, { organizationId }, (tx) =>
    tx
      .select()
      .from(cardSimulations)
      .where(eq(cardSimulations.organizationId, organizationId))
      .orderBy(cardSimulations.createdAt),
  );
}

/**
 * An earlier sandbox purchase for the bill, made at `createdAt` by the job
 * or by `runByStaff`, and the Card purchase it led to when `purchase` is
 * given.
 */
export async function earlierSimulation(
  db: Database,
  payment: CardPaidPayment,
  billId: string | null,
  {
    createdAt,
    purchase,
    runByStaff = null,
  }: {
    readonly createdAt: Date;
    readonly purchase?: CardPurchaseStatus;
    readonly runByStaff?: string | null;
  },
): Promise<string> {
  const { organizationId } = payment.company;
  const token = `earlier-${randomUUID()}`;
  await runInScope(db, { organizationId }, async (tx) => {
    await tx.insert(cardSimulations).values({
      organizationId,
      recurringItemId: payment.itemId,
      billId,
      lithicTransactionToken: token,
      amountUsdCents: 2_000n,
      merchantKey: "SBXEARLIER",
      runByStaff,
      createdAt,
    });
    if (purchase) {
      await tx.insert(cardPurchases).values({
        organizationId,
        cardId: payment.cardId,
        lithicTransactionToken: token,
        status: purchase,
        merchant: "ANTHROPIC",
        mcc: "5734",
        authorizedAt: createdAt,
        categoryId: payment.categoryId,
      });
    }
  });
  return token;
}

export function setCardState(
  db: Database,
  payment: CardPaidPayment,
  state: "frozen" | "closed",
): Promise<void> {
  return runInScope(
    db,
    { organizationId: payment.company.organizationId, role: "admin" },
    async (tx) => {
      await tx
        .update(cards)
        .set({ state, closedAt: state === "closed" ? new Date() : null })
        .where(eq(cards.id, payment.cardId));
    },
  );
}
