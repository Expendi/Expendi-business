import type { QueryClient } from "@tanstack/react-query";

import type {
  CardList,
  CardLoadList,
  CardProgram,
  CardPurchase,
  CardPurchaseList,
  ExpendiCard,
} from "@expendi-business/shared";

import { queryKeys } from "~/lib/query-keys";
import { ORGANIZATION_ID, sampleId } from "./company";
import { MEMBERS } from "./team";

const person = (at: number) => {
  const member = MEMBERS[at];
  if (!member) throw new Error(`No sample member at ${String(at)}`);
  return { membershipId: member.id, name: member.name, email: member.email };
};

const WANJIRU = person(0);
const BRIAN = person(2);

const SOFTWARE = { id: sampleId(9201), name: "Software" };
const TRAVEL = { id: sampleId(9202), name: "Travel" };

export const CARD_PROGRAM: CardProgram = {
  status: "on",
  legalName: "Mwangaza Logistics Ltd",
  balance: {
    loadedUsdCents: "500000",
    spentUsdCents: "183450",
    refundedUsdCents: "2500",
    onHoldUsdCents: "12999",
    availableUsdCents: "306051",
  },
  lowBalance: false,
  paused: false,
  turnedOnAt: "2026-10-20T07:00:00.000Z",
};

const base = {
  yours: false,
  companyHeld: false,
  issuedAt: "2026-10-21T08:30:00.000Z",
  closedAt: null,
} as const;

/** The company-held card that pays Vercel and Notion (bills fixtures 315, 316). */
export const SUBSCRIPTIONS_CARD = {
  id: sampleId(9304),
  nickname: "Software subscriptions",
  lastFour: "0004",
} as const;

/** The recurring payments it pays, as the bills fixtures number them. */
export const VERCEL_PAYMENT_ID = sampleId(315);
export const NOTION_PAYMENT_ID = sampleId(316);
/** Vercel's October bill, paid by the card's purchase `CARD_BILL_PURCHASE_ID`. */
export const PAID_BY_CARD_BILL_ID = sampleId(30);
export const CARD_BILL_PURCHASE_ID = sampleId(9406);

export const SAMPLE_CARDS: readonly ExpendiCard[] = [
  {
    ...base,
    id: sampleId(9301),
    nickname: "Marketing subscriptions",
    lastFour: "0001",
    state: "open",
    monthlyLimitUsdCents: "150000",
    spentThisMonthUsdCents: "61200",
    holder: WANJIRU,
    yours: true,
    defaultCategory: SOFTWARE,
    recurringPayments: [],
  },
  {
    ...base,
    id: sampleId(9302),
    nickname: "Field travel",
    lastFour: "0002",
    state: "frozen",
    monthlyLimitUsdCents: "50000",
    spentThisMonthUsdCents: "12750",
    holder: BRIAN,
    defaultCategory: TRAVEL,
    recurringPayments: [],
  },
  {
    ...base,
    id: sampleId(9303),
    nickname: "Old ads card",
    lastFour: "0003",
    state: "closed",
    monthlyLimitUsdCents: "20000",
    spentThisMonthUsdCents: "0",
    holder: BRIAN,
    defaultCategory: SOFTWARE,
    recurringPayments: [],
    closedAt: "2026-11-02T09:00:00.000Z",
  },
  {
    ...base,
    ...SUBSCRIPTIONS_CARD,
    state: "open",
    monthlyLimitUsdCents: "5000",
    spentThisMonthUsdCents: "1980",
    companyHeld: true,
    holder: null,
    defaultCategory: SOFTWARE,
    recurringPayments: [
      { id: VERCEL_PAYMENT_ID, payeeName: "Vercel", state: "active" },
      { id: NOTION_PAYMENT_ID, payeeName: "Notion", state: "active" },
    ],
    issuedAt: "2026-09-18T07:30:00.000Z",
  },
];

const onSubscriptionsCard = {
  card: SUBSCRIPTIONS_CARD,
  companyHeld: true,
  holder: null,
  yours: false,
  expenseId: null,
  amountKes: null,
  usdKesRate: null,
  receiptCount: 0,
  needsReceipt: false,
} as const;

const purchase = (
  n: number,
  overrides: Partial<CardPurchase> & { merchant: string },
): CardPurchase => ({
  id: sampleId(9400 + n),
  kind: "purchase",
  status: "settled",
  card: {
    id: sampleId(9301),
    nickname: "Marketing subscriptions",
    lastFour: "0001",
  },
  companyHeld: false,
  holder: WANJIRU,
  yours: true,
  merchantKey: null,
  match: null,
  mcc: "5734",
  holdUsdCents: "0",
  settledUsdCents: "4500",
  amountKes: "580500",
  usdKesRate: "129",
  authorizedAt: "2026-11-05T08:12:00.000Z",
  declineReason: null,
  expenseId: sampleId(9500 + n),
  category: SOFTWARE,
  receiptCount: 1,
  noReceiptReason: null,
  needsReceipt: false,
  changedAfterExpense: false,
  ...overrides,
});

export const SAMPLE_PURCHASES: readonly CardPurchase[] = [
  purchase(1, {
    merchant: "Canva",
    status: "pending",
    holdUsdCents: "12999",
    settledUsdCents: "0",
    amountKes: null,
    usdKesRate: null,
    expenseId: null,
    receiptCount: 0,
    needsReceipt: true,
    authorizedAt: "2026-11-06T06:10:00.000Z",
  }),
  purchase(2, {
    merchant: "Notion",
    receiptCount: 0,
    needsReceipt: true,
  }),
  purchase(3, {
    merchant: "Google Workspace",
    settledUsdCents: "7200",
    amountKes: "928800",
    changedAfterExpense: true,
    authorizedAt: "2026-11-04T10:02:00.000Z",
  }),
  purchase(4, {
    merchant: "Notion",
    kind: "refund",
    settledUsdCents: "2500",
    amountKes: null,
    usdKesRate: null,
    expenseId: null,
    receiptCount: 0,
    authorizedAt: "2026-11-03T12:30:00.000Z",
  }),
  purchase(5, {
    merchant: "Skyward Express",
    status: "declined",
    settledUsdCents: "0",
    amountKes: null,
    usdKesRate: null,
    expenseId: null,
    receiptCount: 0,
    holder: BRIAN,
    yours: false,
    card: { id: sampleId(9302), nickname: "Field travel", lastFour: "0002" },
    category: TRAVEL,
    declineReason: "Not enough in the Card balance.",
    authorizedAt: "2026-11-02T15:45:00.000Z",
  }),
  purchase(6, {
    ...onSubscriptionsCard,
    merchant: "VERCEL INC.",
    merchantKey: "lithic-merchant-vercel",
    match: {
      state: "matched",
      recurringItemId: VERCEL_PAYMENT_ID,
      billId: PAID_BY_CARD_BILL_ID,
      payeeName: "Vercel",
    },
    settledUsdCents: "1980",
    authorizedAt: "2026-10-20T06:00:00.000Z",
  }),
  purchase(7, {
    ...onSubscriptionsCard,
    merchant: "LINEAR.APP",
    merchantKey: "lithic-merchant-linear",
    match: {
      state: "needs_review",
      recurringItemId: null,
      billId: null,
      payeeName: null,
    },
    status: "pending",
    holdUsdCents: "1600",
    settledUsdCents: "0",
    authorizedAt: "2026-11-05T22:14:00.000Z",
  }),
  purchase(8, {
    ...onSubscriptionsCard,
    merchant: "NOTION LABS",
    merchantKey: "lithic-merchant-notion",
    match: {
      state: "matched",
      recurringItemId: NOTION_PAYMENT_ID,
      billId: null,
      payeeName: "Notion",
    },
    status: "declined",
    settledUsdCents: "0",
    declineReason: "Over the card's monthly limit.",
    authorizedAt: "2026-11-04T06:00:00.000Z",
  }),
];

/** `GET …/cards/purchases?needsReview=true`: what waits for an admin's answer. */
export const PURCHASES_NEEDING_ANSWER: readonly CardPurchase[] =
  SAMPLE_PURCHASES.filter((one) => one.match?.state === "needs_review");

export const SAMPLE_LOADS: CardLoadList = {
  loads: [
    {
      id: sampleId(9601),
      amountUsdCents: "300000",
      amountKes: "38700000",
      usdKesRate: "129",
      simulated: true,
      loadedBy: WANJIRU.name ?? WANJIRU.email,
      createdAt: "2026-11-01T07:00:00.000Z",
    },
    {
      id: sampleId(9602),
      amountUsdCents: "200000",
      amountKes: "25800000",
      usdKesRate: "129",
      simulated: true,
      loadedBy: WANJIRU.name ?? WANJIRU.email,
      createdAt: "2026-10-21T08:40:00.000Z",
    },
  ],
};

export function seedCards(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  const list: CardList = { cards: [...SAMPLE_CARDS] };
  const page: CardPurchaseList = {
    purchases: [...SAMPLE_PURCHASES],
    nextCursor: null,
  };
  const waiting: CardPurchaseList = {
    purchases: [...PURCHASES_NEEDING_ANSWER],
    nextCursor: null,
  };
  const companyHeld: CardList = {
    cards: SAMPLE_CARDS.filter((card) => card.companyHeld),
  };
  const noFilters = {
    cardId: null,
    status: null,
    needsReceipt: null,
    needsReview: null,
  } as const;
  client.setQueryData(queryKeys.cardProgram(org), CARD_PROGRAM);
  client.setQueryData(queryKeys.cardList(org), list);
  client.setQueryData(queryKeys.companyHeldCards(org), companyHeld);
  client.setQueryData(queryKeys.cardLoads(org), SAMPLE_LOADS);
  client.setQueryData(queryKeys.cardPurchases(org, noFilters), {
    pages: [page],
    pageParams: [null],
  });
  client.setQueryData(
    queryKeys.cardPurchases(org, { ...noFilters, needsReview: "true" }),
    { pages: [waiting], pageParams: [null] },
  );
  for (const one of SAMPLE_PURCHASES) {
    client.setQueryData(queryKeys.cardPurchase(org, one.id), one);
  }
}
