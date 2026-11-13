import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { TestCompany, TestUser } from "./db.js";
import {
  accountingConnections,
  accountingSyncs,
  cardholders,
  cardLoads,
  cardPrograms,
  cardPurchases,
  cards,
  expenses,
  notificationOutbox,
  paidFromAccounts,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { addCategory } from "./claims.js";
import { addMember, createCompany, createUser } from "./db.js";

const SIGNED = {
  "webhook-id": "msg_test",
  "webhook-timestamp": "1800000000",
  "webhook-signature": "v1,dGVzdA==",
  "content-type": "application/json",
};

export interface CardCompany {
  readonly company: TestCompany;
  readonly holder: TestUser;
  readonly holderMembershipId: string;
  readonly categoryId: string;
  readonly accountId: string;
  readonly cardId: string;
  readonly cardToken: string;
}

/** A company with cards on, one employee cardholder, and a loaded Card balance. */
export async function createCardCompany(
  db: Database,
  { loadedUsdCents = 100_000n }: { readonly loadedUsdCents?: bigint } = {},
): Promise<CardCompany> {
  const company = await createCompany(db);
  const holder = await createUser(db);
  const holderMembershipId = await addMember(db, company, holder, {
    role: "employee",
    status: "active",
  });
  const categoryId = await addCategory(db, company, "Software");
  const { organizationId } = company;
  const scope = { organizationId, userId: company.admin.id };
  const cardToken = `card-${randomUUID()}`;
  const { cardId, accountId } = await runInScope(db, scope, async (tx) => {
    const [account] = await tx
      .insert(paidFromAccounts)
      .values({ organizationId, name: "Expendi cards", kind: "card" })
      .returning({ id: paidFromAccounts.id });
    if (!account) throw new Error("account insert returned no row");
    await tx.insert(cardPrograms).values({
      organizationId,
      legalName: "Acme Ltd",
      kraPin: "A012345678Z",
      addressLine1: "1 Moi Avenue",
      city: "Nairobi",
      postalCode: "00100",
      phone: "+254712345678",
      contactFirstName: "Wanjiru",
      contactLastName: "Kamau",
      contactEmail: "wanjiru@example.com",
      contactPhone: "+254712345678",
      lithicAccountHolderToken: `holder-${randomUUID()}`,
      lithicAccountToken: `account-${randomUUID()}`,
      paidFromAccountId: account.id,
      turnedOnBy: company.admin.id,
    });
    const [cardholder] = await tx
      .insert(cardholders)
      .values({
        organizationId,
        membershipId: holderMembershipId,
        lithicAccountHolderToken: `holder-${randomUUID()}`,
        lithicAccountToken: `account-${randomUUID()}`,
      })
      .returning({ id: cardholders.id });
    if (!cardholder) throw new Error("cardholder insert returned no row");
    const [card] = await tx
      .insert(cards)
      .values({
        organizationId,
        cardholderId: cardholder.id,
        membershipId: holderMembershipId,
        lithicCardToken: cardToken,
        nickname: "Subscriptions",
        lastFour: "4242",
        monthlyLimitUsdCents: 500_000n,
        defaultCategoryId: categoryId,
        issuedBy: company.admin.id,
      })
      .returning({ id: cards.id });
    if (!card) throw new Error("card insert returned no row");
    if (loadedUsdCents > 0n) {
      await tx.insert(cardLoads).values({
        organizationId,
        amountUsdCents: loadedUsdCents,
        amountKes: loadedUsdCents * 129n,
        usdKesRate: "129",
        loadedBy: company.admin.id,
        approvalId: randomUUID(),
      });
    }
    return { cardId: card.id, accountId: account.id };
  });
  return {
    company,
    holder,
    holderMembershipId,
    categoryId,
    accountId,
    cardId,
    cardToken,
  };
}

export interface CompanyHeldCard {
  readonly cardId: string;
  readonly cardToken: string;
}

/**
 * A company-held card on the company's card program, written straight to the
 * table as issuing it would leave it: no cardholder, open, issued by the
 * company's admin. `values` overrides any column, e.g. to break a rule.
 */
export async function addCompanyHeldCard(
  db: Database,
  company: TestCompany,
  values: Partial<typeof cards.$inferInsert> &
    Pick<typeof cards.$inferInsert, "defaultCategoryId">,
): Promise<CompanyHeldCard> {
  const { organizationId } = company;
  const cardToken = `card-${randomUUID()}`;
  const [card] = await runInScope(
    db,
    { organizationId, userId: company.admin.id },
    (tx) =>
      tx
        .insert(cards)
        .values({
          organizationId,
          companyHeld: true,
          cardholderId: null,
          membershipId: null,
          lithicCardToken: cardToken,
          nickname: "Software subscriptions",
          lastFour: "1881",
          monthlyLimitUsdCents: 50_000n,
          issuedBy: company.admin.id,
          ...values,
        })
        .returning({ id: cards.id, cardToken: cards.lithicCardToken }),
  );
  if (!card) throw new Error("card insert returned no row");
  return { cardId: card.id, cardToken: card.cardToken };
}

export const sendLithicEvent = (
  app: App,
  body: unknown,
  headers: Record<string, string> = SIGNED,
): Promise<Response> =>
  Promise.resolve(
    app.request("/webhooks/lithic", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );

export const transactionEvent = (token: string) => ({
  event_type: "card_transaction.updated",
  payload: { token },
});

export interface AuthorizationOptions {
  readonly status?: string;
  readonly created?: string;
  readonly descriptor?: string;
  /** Lithic's merchant ID; left out, as an older request may be. */
  readonly acceptorId?: string;
}

/** An Auth Stream Access request for `cents` US cents. */
export async function authorize(
  app: App,
  cardToken: string,
  transactionToken: string,
  cents: number,
  {
    status = "AUTHORIZATION",
    created,
    descriptor = "ACME SOFTWARE",
    acceptorId,
  }: AuthorizationOptions = {},
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const response = await app.request("/webhooks/lithic/authorization", {
    method: "POST",
    headers: SIGNED,
    body: JSON.stringify({
      token: transactionToken,
      status,
      ...(created !== undefined && { created }),
      card: { token: cardToken },
      amounts: {
        cardholder: { amount: cents, currency: "USD", conversion_rate: "1" },
        merchant: { amount: cents, currency: "USD" },
        hold: { amount: cents, currency: "USD" },
        settlement: null,
      },
      merchant: {
        ...(acceptorId !== undefined && { acceptor_id: acceptorId }),
        descriptor,
        mcc: "5734",
        city: "NAIROBI",
        country: "KEN",
      },
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, body };
}

export function readPurchaseByToken(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
  transactionToken: string,
) {
  return runInScope(db, { organizationId }, async (tx) => {
    const [purchase] = await tx
      .select()
      .from(cardPurchases)
      .where(eq(cardPurchases.lithicTransactionToken, transactionToken));
    return purchase ?? null;
  });
}

export function readExpense(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
  expenseId: string,
) {
  return runInScope(db, { organizationId }, async (tx) => {
    const [expense] = await tx
      .select()
      .from(expenses)
      .where(eq(expenses.id, expenseId));
    return expense ?? null;
  });
}

export function cardExpensesOf(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
) {
  return runInScope(db, { organizationId }, (tx) =>
    tx.select().from(expenses).where(eq(expenses.kind, "card")),
  );
}

export function outboxOf(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
  kind: string,
) {
  return runInScope(db, { organizationId, role: "admin" }, (tx) =>
    tx
      .select({
        dedupeKey: notificationOutbox.dedupeKey,
        body: notificationOutbox.body,
        channel: notificationOutbox.channel,
      })
      .from(notificationOutbox)
      .where(eq(notificationOutbox.kind, kind)),
  );
}

export async function connectAccounting(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
): Promise<void> {
  await runInScope(db, { organizationId }, (tx) =>
    tx.insert(accountingConnections).values({ organizationId }),
  );
}

export function accountingSyncsOf(
  db: Database,
  { organizationId }: Pick<TestCompany, "organizationId">,
) {
  return runInScope(db, { organizationId }, (tx) =>
    tx.select().from(accountingSyncs),
  );
}
