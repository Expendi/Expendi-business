import { describe, expect, it } from "vitest";

import type {
  CardPurchase,
  ExpendiCard,
  MembersResponse,
} from "@expendi-business/shared";
import { reviewCardPurchaseRequestSchema } from "@expendi-business/shared";

import {
  answerRequest,
  answerSavedText,
  asksForReceipt,
  canAddReceipt,
  canAnswer,
  canWaiveReceipt,
  eligibleCardholders,
  formatUsd,
  hasPurchaseFilter,
  holderName,
  limitChangeOf,
  maskedLastFour,
  matchedPaymentOf,
  needsAnswer,
  paymentsDeclinedWhenFrozen,
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
  companyHeld: false,
  holder: { membershipId: id(3), name: "Jane", email: "jane@example.com" },
  yours: false,
  merchant: "Canva",
  merchantKey: null,
  match: null,
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
  companyHeld: false,
  holder: { membershipId: id(3), name: "Jane", email: "jane@example.com" },
  yours: false,
  defaultCategory: { id: id(5), name: "Software" },
  recurringPayments: [],
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
      good: read({
        card: id(1),
        status: "declined",
        receipt: "true",
        review: "true",
      }),
      bad: read({ status: "lost", receipt: "maybe", review: "false" }),
      none: hasPurchaseFilter(read({})),
      some: hasPurchaseFilter(read({ receipt: "false" })),
      review: hasPurchaseFilter(read({ review: "true" })),
    }).toEqual({
      good: {
        cardId: id(1),
        status: "declined",
        needsReceipt: "true",
        needsReview: "true",
      },
      bad: {
        cardId: null,
        status: null,
        needsReceipt: null,
        needsReview: null,
      },
      none: false,
      some: true,
      review: true,
    });
  });
});

describe("maskedLastFour", () => {
  it("never shows more than the last four digits", () => {
    expect(maskedLastFour("0001")).toBe("•••• 0001");
  });
});

describe("answerRequest", () => {
  const recurringItemId = id(30);

  it("sends the recurring payment only with link, as the API takes it", () => {
    // #then
    expect(
      (["link", "one_off", "not_recognised"] as const).map((decision) =>
        reviewCardPurchaseRequestSchema.parse(
          answerRequest(decision, recurringItemId),
        ),
      ),
    ).toEqual([
      { decision: "link", recurringItemId },
      { decision: "one_off" },
      { decision: "not_recognised" },
    ]);
  });

  it("asks for an answer, and for the payment a link pays", () => {
    // #when
    const issues = [answerRequest(null, ""), answerRequest("link", "")].map(
      (request) =>
        reviewCardPurchaseRequestSchema
          .safeParse(request)
          .error?.issues.map((issue) => issue.message),
    );

    // #then
    expect(issues).toEqual([
      [
        "Say whether it's one of the card's recurring payments, a one-off, or not recognised.",
      ],
      ["Pick the recurring payment it pays."],
    ]);
  });
});

describe("company-held card purchases", () => {
  const matched = purchase({
    companyHeld: true,
    holder: null,
    needsReceipt: true,
    expenseId: id(9),
    match: {
      state: "matched",
      recurringItemId: id(30),
      billId: id(31),
      payeeName: "Vercel",
    },
  });

  it("asks no receipt of a purchase that pays a bill", () => {
    // #then
    expect({
      matched: [asksForReceipt(matched), canWaiveReceipt(matched)],
      oneOff: asksForReceipt({
        ...matched,
        match: {
          state: "one_off",
          recurringItemId: null,
          billId: null,
          payeeName: null,
        },
      }),
      paid: matchedPaymentOf(matched),
    }).toEqual({
      matched: [false, false],
      oneOff: true,
      paid: { payeeName: "Vercel", billId: id(31) },
    });
  });

  it("is answered for once, and a one-off can still change", () => {
    // #given
    const withMatch = (state: "needs_review" | "one_off" | "not_recognised") =>
      purchase({
        companyHeld: true,
        holder: null,
        match: { state, recurringItemId: null, billId: null, payeeName: null },
      });

    // #then
    expect({
      needsReview: [
        needsAnswer(withMatch("needs_review")),
        canAnswer(withMatch("needs_review")),
      ],
      oneOff: canAnswer(withMatch("one_off")),
      notRecognised: canAnswer(withMatch("not_recognised")),
      matched: canAnswer(matched),
    }).toEqual({
      needsReview: [true, true],
      oneOff: true,
      notRecognised: false,
      matched: false,
    });
  });

  it("names the recurring payments a frozen card declines: those not paused", () => {
    // #given
    const companyCard = card({
      companyHeld: true,
      holder: null,
      recurringPayments: [
        { id: id(30), payeeName: "Vercel", state: "active" },
        { id: id(32), payeeName: "Notion", state: "paused" },
      ],
    });

    // #then
    expect(
      paymentsDeclinedWhenFrozen(companyCard).map(
        (payment) => payment.payeeName,
      ),
    ).toEqual(["Vercel"]);
  });

  it("calls a company-held card's holder Company-held", () => {
    // #then
    expect(holderName(null)).toBe("Company-held");
  });

  it("lets an admin add the receipt for a company-held card's one-off purchase, from the hold on", () => {
    // #given
    const oneOff = purchase({
      companyHeld: true,
      holder: null,
      match: {
        state: "one_off",
        recurringItemId: null,
        billId: null,
        payeeName: null,
      },
    });

    // #then
    expect({
      settled: canAddReceipt(oneOff),
      pending: canAddReceipt({ ...oneOff, status: "pending", expenseId: null }),
      declined: canAddReceipt({ ...oneOff, status: "declined" }),
      refund: canAddReceipt({ ...oneOff, kind: "refund" }),
      hasOne: canAddReceipt({ ...oneOff, needsReceipt: false }),
      paysBill: canAddReceipt(matched),
      personsCard: canAddReceipt(purchase({})),
    }).toEqual({
      settled: true,
      pending: true,
      declined: false,
      refund: false,
      hasOne: false,
      paysBill: false,
      personsCard: false,
    });
  });
});

describe("answerSavedText", () => {
  const waiting = purchase({
    companyHeld: true,
    holder: null,
    merchant: "VERCEL INC.",
    card: { id: id(2), nickname: "Software", lastFour: "0004" },
  });
  const savedAs = (
    state: "matched" | "one_off" | "not_recognised",
    payeeName: string | null = null,
  ): CardPurchase => ({
    ...waiting,
    match: { state, recurringItemId: null, billId: null, payeeName },
  });
  const link = { decision: "link", recurringItemId: id(30) } as const;

  it("says what the API did with the answer, not what was asked", () => {
    // #then
    expect({
      linked: answerSavedText(link, savedAs("matched", "Vercel"), "Vercel"),
      keptInBooks: answerSavedText(link, savedAs("one_off"), "Vercel"),
      oneOff: answerSavedText({ decision: "one_off" }, savedAs("one_off"), ""),
      notRecognised: answerSavedText(
        { decision: "not_recognised" },
        savedAs("not_recognised"),
        "",
      ),
    }).toEqual({
      linked:
        "Saved. It pays Vercel’s bill, and later purchases from VERCEL INC. match on their own.",
      keptInBooks:
        "Vercel’s later purchases will pay its bills. This one stays a Card expense because it’s already in your books.",
      oneOff:
        "Saved as a one-off purchase. It stays a Card expense and needs a receipt.",
      notRecognised: "Saved. VERCEL INC. is declined on Software from now on.",
    });
  });
});
