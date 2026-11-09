import { describe, expect, it } from "vitest";

import type {
  CardPurchase,
  ExpendiCard,
  MembersResponse,
} from "@expendi-business/shared";

import {
  canWaiveReceipt,
  eligibleCardholders,
  formatUsd,
  hasPurchaseFilter,
  limitChangeOf,
  maskedLastFour,
  purchaseAmount,
  readPurchaseFilters,
  sortCards,
  usdNumber,
} from "./cards-display";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const purchase = (overrides: Partial<CardPurchase>): CardPurchase => ({
  id: id(1),
  kind: "purchase",
  status: "settled",
  card: { id: id(2), nickname: "Ads", lastFour: "0001" },
  holder: { membershipId: id(3), name: "Jane", email: "jane@example.com" },
  yours: false,
  merchant: "Canva",
  mcc: "5734",
  holdUsdCents: "0",
  settledUsdCents: "4500",
  amountKes: null,
  usdKesRate: null,
  authorizedAt: "2026-11-05T08:12:00.000Z",
  declineReason: null,
  expenseId: id(4),
  category: { id: id(5), name: "Software" },
  receiptCount: 0,
  noReceiptReason: null,
  needsReceipt: true,
  changedAfterExpense: false,
  ...overrides,
});

const card = (overrides: Partial<ExpendiCard>): ExpendiCard => ({
  id: id(10),
  nickname: "Ads",
  lastFour: "0001",
  state: "open",
  monthlyLimitUsdCents: "50000",
  spentThisMonthUsdCents: "1000",
  holder: { membershipId: id(3), name: "Jane", email: "jane@example.com" },
  yours: false,
  defaultCategory: { id: id(5), name: "Software" },
  issuedAt: "2026-10-21T08:30:00.000Z",
  closedAt: null,
  ...overrides,
});

describe("formatUsd", () => {
  it("reads US cents and keeps a balance below zero readable", () => {
    expect({
      plain: formatUsd("150050"),
      zero: formatUsd("0"),
      negativeCents: formatUsd("-50"),
      negative: formatUsd("-250075"),
      number: usdNumber("-250075"),
    }).toEqual({
      plain: "USD 1,500.50",
      zero: "USD 0.00",
      negativeCents: "−USD 0.50",
      negative: "−USD 2,500.75",
      number: "2,500.75",
    });
  });
});

describe("limitChangeOf", () => {
  it("raises, lowers or refuses a limit against the current one", () => {
    expect({
      raise: limitChangeOf("50000", "600"),
      lower: limitChangeOf("50000", "400.50"),
      same: limitChangeOf("50000", "500"),
      junk: limitChangeOf("50000", "twelve"),
      empty: limitChangeOf("50000", ""),
    }).toEqual({
      raise: { ok: true, direction: "raise" },
      lower: { ok: true, direction: "lower" },
      same: { ok: false, error: "The limit is already USD 500.00." },
      junk: {
        ok: false,
        error: "Enter an amount in US dollars, e.g. 250 or 250.50.",
      },
      empty: {
        ok: false,
        error: "Enter an amount in US dollars, e.g. 250 or 250.50.",
      },
    });
  });
});

describe("purchaseAmount", () => {
  it("shows the hold until it clears, then what settled and what's left", () => {
    expect({
      held: purchaseAmount(
        purchase({ holdUsdCents: "10000", settledUsdCents: "0" }),
      ),
      partly: purchaseAmount(
        purchase({ holdUsdCents: "300", settledUsdCents: "700" }),
      ),
      recorded: purchaseAmount(
        purchase({ settledUsdCents: "700", amountKes: "90300" }),
      ),
    }).toEqual({
      held: { cents: "10000", sub: "On hold" },
      partly: { cents: "700", sub: "USD 3.00 on hold" },
      recorded: { cents: "700", sub: "KES 903" },
    });
  });
});

describe("canWaiveReceipt", () => {
  it("allows a waiver only on a Card expense still missing its receipt", () => {
    expect({
      recorded: canWaiveReceipt(purchase({})),
      noExpense: canWaiveReceipt(purchase({ expenseId: null })),
      hasReceipt: canWaiveReceipt(purchase({ needsReceipt: false })),
      refund: canWaiveReceipt(purchase({ kind: "refund" })),
    }).toEqual({
      recorded: true,
      noExpense: false,
      hasReceipt: false,
      refund: false,
    });
  });
});

describe("eligibleCardholders", () => {
  const member = (
    n: number,
    role: MembersResponse[number]["role"],
    status: MembersResponse[number]["status"],
    name: string,
  ): MembersResponse[number] => ({
    id: id(n),
    name,
    email: `${name.toLowerCase()}@example.com`,
    role,
    status,
    invitedAt: null,
    payoutPhoneConfirmed: false,
  });

  it("keeps active admins and employees, never accountants or anyone not active", () => {
    const names = eligibleCardholders([
      member(1, "employee", "active", "Zed"),
      member(2, "admin", "active", "Amina"),
      member(3, "accountant", "active", "Cole"),
      member(4, "employee", "invited", "Dan"),
      member(5, "employee", "removed", "Eve"),
    ]).map((holder) => holder.name);

    expect(names).toEqual(["Amina", "Zed"]);
  });
});

describe("sortCards", () => {
  it("sorts by name, holder or amount, with ties by name", () => {
    const cards = [
      card({ id: id(1), nickname: "Beta", spentThisMonthUsdCents: "900" }),
      card({
        id: id(2),
        nickname: "Alpha",
        spentThisMonthUsdCents: "900",
        monthlyLimitUsdCents: "90000",
        holder: { membershipId: id(4), name: "Abel", email: "a@example.com" },
      }),
      card({ id: id(3), nickname: "Cara", spentThisMonthUsdCents: "5000" }),
    ];
    const names = (
      key: "card" | "holder" | "spent" | "limit",
      dir: "asc" | "desc",
    ) => sortCards(cards, { key, dir }).map((sorted) => sorted.nickname);

    expect({
      name: names("card", "asc"),
      holder: names("holder", "asc"),
      spentDesc: names("spent", "desc"),
      limitDesc: names("limit", "desc"),
    }).toEqual({
      name: ["Alpha", "Beta", "Cara"],
      holder: ["Alpha", "Beta", "Cara"],
      spentDesc: ["Cara", "Alpha", "Beta"],
      limitDesc: ["Alpha", "Beta", "Cara"],
    });
  });
});

describe("readPurchaseFilters", () => {
  it("keeps values the API takes and drops the rest", () => {
    const read = (values: Record<string, string>) =>
      readPurchaseFilters((name) => values[name] ?? null);

    expect({
      good: read({ card: id(1), status: "declined", receipt: "true" }),
      bad: read({ status: "lost", receipt: "maybe" }),
      none: hasPurchaseFilter(read({})),
      some: hasPurchaseFilter(read({ receipt: "false" })),
    }).toEqual({
      good: { cardId: id(1), status: "declined", needsReceipt: "true" },
      bad: { cardId: null, status: null, needsReceipt: null },
      none: false,
      some: true,
    });
  });
});

describe("maskedLastFour", () => {
  it("never shows more than the last four digits", () => {
    expect(maskedLastFour("0001")).toBe("•••• 0001");
  });
});
