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
  issuedAt: "2026-10-21T08:30:00.000Z",
  closedAt: null,
} as const;

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
    closedAt: "2026-11-02T09:00:00.000Z",
  },
];

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
  holder: WANJIRU,
  yours: true,
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
];

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
  client.setQueryData(queryKeys.cardProgram(org), CARD_PROGRAM);
  client.setQueryData(queryKeys.cardList(org), list);
  client.setQueryData(queryKeys.cardLoads(org), SAMPLE_LOADS);
  client.setQueryData(
    queryKeys.cardPurchases(org, {
      cardId: null,
      status: null,
      needsReceipt: null,
    }),
    { pages: [page], pageParams: [null] },
  );
}
