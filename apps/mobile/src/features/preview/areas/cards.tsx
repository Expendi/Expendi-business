/** DEV PREVIEW — an employee's Expendi cards: the list and one card's purchases. */
import type { JSX } from "react";
import { View } from "react-native";

import type { CardPurchase, ExpendiCard } from "@expendi-business/shared";

import type { PreviewArea } from "../types";
import CardsRoute from "~/app/(employee)/cards";
import CardRoute from "~/app/(employee)/cards/[cardId]";
import PurchaseRoute from "~/app/(employee)/cards/purchases/[purchaseId]";
import { DetailHeader } from "~/components/detail-header";

/** Open with `&cardId=` so the card screen finds it: `preview?screen=card&cardId=…`. */
export const PREVIEW_TRAVEL_CARD_ID = "3c9e1a42-8d5b-4f6a-9e21-7b4c0d2e1f01";
const FUEL_CARD_ID = "3c9e1a42-8d5b-4f6a-9e21-7b4c0d2e1f02";

const HOLDER = {
  membershipId: "9d2e4c1a-7b3f-4a6e-8d5c-0f1e2a3b4c02",
  name: "Brian Otieno",
  email: "brian@mawingulabs.co.ke",
};
const TRAVEL = { id: "5d1e3b20-6c4f-4f9a-8b72-4d3e2f1a0b11", name: "Travel" };
const FUEL = { id: "5d1e3b20-6c4f-4f9a-8b72-4d3e2f1a0b12", name: "Fuel" };

const CARDS: ExpendiCard[] = [
  {
    id: PREVIEW_TRAVEL_CARD_ID,
    nickname: "Travel",
    lastFour: "4821",
    state: "open",
    monthlyLimitUsdCents: "150000",
    spentThisMonthUsdCents: "41250",
    companyHeld: false,
    holder: HOLDER,
    yours: true,
    defaultCategory: TRAVEL,
    recurringPayments: [],
    issuedAt: "2026-09-01T07:00:00.000Z",
    closedAt: null,
  },
  {
    id: FUEL_CARD_ID,
    nickname: "Fuel and parking",
    lastFour: "7730",
    state: "open",
    monthlyLimitUsdCents: "30000",
    spentThisMonthUsdCents: "9640",
    companyHeld: false,
    holder: HOLDER,
    yours: true,
    defaultCategory: FUEL,
    recurringPayments: [],
    issuedAt: "2026-09-01T07:00:00.000Z",
    closedAt: null,
  },
];

function travelPurchase(
  id: string,
  merchant: string,
  mcc: string,
  usdCents: string,
  authorizedAt: string,
  settled: { amountKes: string; receiptCount: number } | null,
): CardPurchase {
  return {
    id,
    kind: "purchase",
    status: settled ? "settled" : "pending",
    card: { id: PREVIEW_TRAVEL_CARD_ID, nickname: "Travel", lastFour: "4821" },
    companyHeld: false,
    holder: HOLDER,
    yours: true,
    merchant,
    merchantKey: null,
    mcc,
    holdUsdCents: settled ? "0" : usdCents,
    settledUsdCents: settled ? usdCents : "0",
    amountKes: settled?.amountKes ?? null,
    usdKesRate: settled ? "129.18" : null,
    authorizedAt,
    declineReason: null,
    expenseId: settled ? id.replace(/01$/, "e1") : null,
    category: TRAVEL,
    receiptCount: settled?.receiptCount ?? 0,
    noReceiptReason: null,
    needsReceipt: (settled?.receiptCount ?? 0) === 0,
    changedAfterExpense: false,
    match: null,
  };
}

const UBER = travelPurchase(
  "8e2d4f10-1a3b-4c5d-9e6f-0a1b2c3d4e01",
  "Uber",
  "4121",
  "1420",
  "2026-11-12T16:20:00.000Z",
  { amountKes: "183436", receiptCount: 0 },
);
const HOTEL = travelPurchase(
  "8e2d4f10-1a3b-4c5d-9e6f-0a1b2c3d4e02",
  "Sarova Stanley",
  "7011",
  "11230",
  "2026-11-11T09:05:00.000Z",
  null,
);
const FLIGHT = travelPurchase(
  "8e2d4f10-1a3b-4c5d-9e6f-0a1b2c3d4e03",
  "Kenya Airways",
  "4511",
  "28600",
  "2026-11-09T06:40:00.000Z",
  { amountKes: "3694548", receiptCount: 1 },
);

function Cards(): JSX.Element {
  return (
    <View className="flex-1 bg-gray-50">
      <DetailHeader title="My Expendi cards" onBack={() => undefined} />
      <CardsRoute />
    </View>
  );
}

function Card(): JSX.Element {
  return <CardRoute />;
}

function Purchase(): JSX.Element {
  return (
    <View className="flex-1 bg-gray-50">
      <DetailHeader title="Purchase" onBack={() => undefined} />
      <PurchaseRoute />
    </View>
  );
}

export const CARDS_AREA: PreviewArea = {
  routes: [
    { path: /\/cards\/purchases\/[0-9a-f-]{36}$/, data: UBER },
    { path: /\/cards\?mine=true$/, data: { cards: CARDS } },
    {
      path: /\/cards\/purchases\?mine=true&needsReceipt=true/,
      data: { purchases: [UBER, HOTEL], nextCursor: null },
    },
    {
      path: /\/cards\/purchases\?mine=true&cardId=/,
      data: { purchases: [UBER, HOTEL, FLIGHT], nextCursor: null },
    },
  ],
  screens: [
    { key: "cards", name: "My Expendi cards", role: "employee", render: Cards },
    { key: "card", name: "Card · Travel", role: "employee", render: Card },
    {
      key: "card-purchase",
      name: "Card purchase",
      role: "employee",
      render: Purchase,
    },
  ],
};
