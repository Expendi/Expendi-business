import { describe, expect, it } from "vitest";

import type { RecurringItem } from "@expendi-business/shared";
import { createRecurringItemRequestSchema } from "@expendi-business/shared";

import { RECURRING_ITEMS } from "~/app/dev/preview/_harness/fixtures/bills";
import {
  blankDraft,
  defaultScheduleDay,
  draftFromItem,
  firstDueOn,
  mostInOneMonthCents,
  otherCardPayments,
  reminderInWords,
  sortRecurringItems,
  suggestedCardLimitCents,
  switchPayVia,
  toCreateRequest,
  toUpdateRequest,
} from "./recurring-draft";

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const item: RecurringItem = {
  id: id(1),
  state: "active",
  payee: {
    id: id(2),
    name: "Kenya Power",
    kind: "supplier",
    method: "mpesa_paybill",
    archived: false,
  },
  overviewHeading: "transactions",
  category: { id: id(3), name: "Utilities" },
  variable: false,
  currency: "kes",
  amountKes: "450000",
  amountUsdc: null,
  schedule: "monthly",
  scheduleDay: 28,
  startsOn: "2026-11-01",
  endsOn: null,
  payVia: "expendi",
  reminderDays: 3,
  active: true,
  nextDueOn: "2026-12-28",
  nextBill: {
    id: id(4),
    status: "upcoming",
    dueOn: "2026-11-28",
    amountKes: "450000",
    amountUsdc: null,
  },
  createdAt: "2026-11-01T09:00:00.000Z",
  updatedAt: "2026-11-01T09:00:00.000Z",
};

describe("toCreateRequest", () => {
  it("sends a USDC payee's amount in USD, which the API pays exactly", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      payeeId: id(2),
      currency: "usd" as const,
      amount: "120.50",
      categoryId: id(3),
      payVia: "expendi" as const,
    };

    // #when
    const request = toCreateRequest(draft);

    // #then
    expect({
      request,
      parsedUsdc: createRecurringItemRequestSchema
        .parse(request)
        .amountUsd?.toString(),
    }).toEqual({
      request: {
        payeeId: id(2),
        variable: false,
        amountUsd: "120.50",
        schedule: "monthly",
        scheduleDay: 2,
        startsOn: "2026-11-02",
        endsOn: null,
        payVia: "expendi",
        reminderDays: 3,
        overviewHeading: undefined,
        categoryId: id(3),
      },
      parsedUsdc: "120500000",
    });
  });

  it("leaves a variable payment's amount out", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      variable: true,
      amount: "999",
    };

    // #then
    expect(toCreateRequest(draft).amountKes).toBeNull();
  });
});

describe("defaultScheduleDay", () => {
  it("takes the start date's weekday or day of the month", () => {
    // #then
    expect([
      defaultScheduleDay("weekly", "2026-11-02"),
      defaultScheduleDay("monthly", "2026-11-02"),
    ]).toEqual(["1", "2"]);
  });
});

describe("toUpdateRequest", () => {
  it("sends nothing when nothing changed", () => {
    // #then
    expect(toUpdateRequest(item, draftFromItem(item))).toEqual({});
  });

  it("sends only the changes, never the payee, schedule, start date or how it's paid", () => {
    // #given an edit that also tampers with the fields fixed at creation
    const draft = {
      ...draftFromItem(item),
      payeeId: id(9),
      schedule: "weekly" as const,
      scheduleDay: "3",
      startsOn: "2027-01-01",
      payVia: "outside" as const,
      amount: "5000.00",
      reminderDays: "5",
      endsOn: "2027-06-30",
    };

    // #when
    const request = toUpdateRequest(item, draft);

    // #then
    expect(request).toEqual({
      amountKes: "5000.00",
      reminderDays: 5,
      endsOn: "2027-06-30",
    });
  });

  it("makes a fixed payment variable with a null amount", () => {
    // #then
    expect(
      toUpdateRequest(item, { ...draftFromItem(item), variable: true }),
    ).toEqual({ amountKes: null });
  });
});

describe("a payment by company-held card", () => {
  const cardId = id(40);
  const otherCardId = id(41);
  const card = {
    id: cardId,
    nickname: "Software subscriptions",
    lastFour: "0004",
    state: "open",
  } as const;
  const byCard: RecurringItem = {
    ...item,
    payee: { ...item.payee, name: "Vercel", method: "outside" },
    currency: "usd",
    amountKes: null,
    amountUsdc: "20000000",
    payVia: "card",
    card,
  };

  it("sends the card and a USD estimate, whoever the payee is", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      payeeId: id(2),
      currency: "kes" as const,
      amount: "20.00",
      payVia: "card" as const,
      cardId,
      categoryId: id(3),
    };

    // #when
    const request = toCreateRequest(draft);
    const parsed = createRecurringItemRequestSchema.parse(request);

    // #then
    expect({
      payVia: request.payVia,
      cardId: request.cardId,
      variable: request.variable,
      amountUsd: request.amountUsd,
      kes: "amountKes" in request,
      parsedUsdc: parsed.amountUsd?.toString(),
    }).toEqual({
      payVia: "card",
      cardId,
      variable: false,
      amountUsd: "20.00",
      kes: false,
      parsedUsdc: "20000000",
    });
  });

  it("takes no estimate as variable, and asks for the card when none is picked", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      payeeId: id(2),
      payVia: "card" as const,
      categoryId: id(3),
    };

    // #when
    const request = toCreateRequest(draft);
    const parsed = createRecurringItemRequestSchema.safeParse(request);

    // #then
    expect({
      variable: request.variable,
      amountUsd: request.amountUsd,
      issues: parsed.error?.issues.map((issue) => issue.path.join(".")),
    }).toEqual({ variable: true, amountUsd: null, issues: ["cardId"] });
  });

  it("starts the form from the card and the estimate in USD", () => {
    // #when
    const draft = draftFromItem(byCard);

    // #then
    expect({
      payVia: draft.payVia,
      cardId: draft.cardId,
      currency: draft.currency,
      amount: draft.amount,
      unchanged: toUpdateRequest(byCard, draft),
    }).toEqual({
      payVia: "card",
      cardId,
      currency: "usd",
      amount: "20.00",
      unchanged: {},
    });
  });

  it("switches a payment paid outside Expendi to a card, with its estimate", () => {
    // #given
    const outside: RecurringItem = {
      ...item,
      payee: { ...item.payee, method: "outside" },
      payVia: "outside",
    };
    const draft = {
      ...draftFromItem(outside),
      payVia: "card" as const,
      currency: "usd" as const,
      cardId,
      amount: "25",
    };

    // #then
    expect(toUpdateRequest(outside, draft)).toEqual({
      payVia: "card",
      cardId,
      amountUsd: "25",
    });
  });

  it("moves a payment to another card, and back off cards", () => {
    // #given
    const draft = draftFromItem(byCard);

    // #then
    expect({
      anotherCard: toUpdateRequest(byCard, { ...draft, cardId: otherCardId }),
      outside: toUpdateRequest(byCard, {
        ...draft,
        payVia: "outside",
        cardId: null,
      }),
    }).toEqual({
      anotherCard: { payVia: "card", cardId: otherCardId },
      outside: { payVia: "outside" },
    });
  });
});

describe("switchPayVia", () => {
  const cardId = id(40);
  const opened = {
    ...blankDraft("2026-11-02"),
    payVia: "card" as const,
    currency: "usd" as const,
    amount: "20.00",
    cardId,
  };

  it("brings back the estimate and card the form opened with, and what was typed for each way", () => {
    // #given
    const toOutside = switchPayVia(opened, {}, "outside", "kes");
    const typedOutside = { ...opened, ...toOutside.changes, amount: "1500" };

    // #when
    const backToCard = switchPayVia(
      typedOutside,
      toOutside.memory,
      "card",
      "usd",
    );
    const outsideAgain = switchPayVia(
      { ...typedOutside, ...backToCard.changes },
      backToCard.memory,
      "outside",
      "kes",
    );

    // #then
    expect({
      outside: toOutside.changes,
      card: backToCard.changes,
      outsideAgain: outsideAgain.changes,
    }).toEqual({
      outside: { payVia: "outside", currency: "kes", amount: "", cardId: null },
      card: { payVia: "card", currency: "usd", amount: "20.00", cardId },
      outsideAgain: {
        payVia: "outside",
        currency: "kes",
        amount: "1500",
        cardId: null,
      },
    });
  });

  it("carries the amount to a way paid in the same currency that has none yet", () => {
    // #given
    const typed = { ...blankDraft("2026-11-02"), amount: "450" };

    // #then
    expect(switchPayVia(typed, {}, "outside", "kes").changes).toEqual({
      payVia: "outside",
      currency: "kes",
      amount: "450",
      cardId: null,
    });
  });
});

describe("mostInOneMonthCents", () => {
  const usd = (dollars: number) => String(dollars * 1_000_000);

  it("counts five weekly bills, one monthly bill, and a quarterly or yearly bill whole", () => {
    // #then
    expect(
      [
        mostInOneMonthCents([{ amountUsdc: usd(10), schedule: "weekly" }]),
        mostInOneMonthCents([{ amountUsdc: usd(20), schedule: "monthly" }]),
        mostInOneMonthCents([{ amountUsdc: usd(30), schedule: "quarterly" }]),
        mostInOneMonthCents([{ amountUsdc: usd(120), schedule: "yearly" }]),
        mostInOneMonthCents([
          { amountUsdc: usd(120), schedule: "yearly" },
          { amountUsdc: usd(20), schedule: "monthly" },
          { amountUsdc: null, schedule: "weekly" },
        ]),
        mostInOneMonthCents([{ amountUsdc: null, schedule: "monthly" }]),
      ].map(String),
    ).toEqual(["5000", "2000", "3000", "12000", "14000", "null"]);
  });
});

describe("suggestedCardLimitCents", () => {
  const usd = (dollars: number) => String(dollars * 1_000_000);

  it("is the most one month can hold plus 25%, rounded up to a whole cent", () => {
    // #then
    expect(
      [
        suggestedCardLimitCents([{ amountUsdc: usd(20), schedule: "monthly" }]),
        suggestedCardLimitCents([{ amountUsdc: usd(10), schedule: "weekly" }]),
        suggestedCardLimitCents([
          { amountUsdc: usd(30), schedule: "quarterly" },
        ]),
        suggestedCardLimitCents([{ amountUsdc: usd(120), schedule: "yearly" }]),
        suggestedCardLimitCents([
          { amountUsdc: "9990000", schedule: "monthly" },
        ]),
      ].map(String),
    ).toEqual(["2500", "6250", "3750", "15000", "1249"]);
  });

  it("adds what the card's other recurring payments come to, skipping those with no estimate", () => {
    // #then
    expect(
      suggestedCardLimitCents([
        { amountUsdc: usd(20), schedule: "monthly" },
        { amountUsdc: usd(16), schedule: "monthly" },
        { amountUsdc: null, schedule: "monthly" },
      ]),
    ).toBe(4500n);
  });

  it("suggests nothing without an estimate", () => {
    // #then
    expect(
      suggestedCardLimitCents([{ amountUsdc: null, schedule: "monthly" }]),
    ).toBeNull();
  });

  it("counts the card's other payments that haven't ended, not this one", () => {
    // #given
    const cardId = id(40);
    const on = (n: number, overrides: Partial<RecurringItem>) => ({
      ...item,
      id: id(n),
      currency: "usd" as const,
      amountKes: null,
      amountUsdc: usd(n),
      payVia: "card" as const,
      card: {
        id: cardId,
        nickname: "Software",
        lastFour: "0004",
        state: "open" as const,
      },
      ...overrides,
    });

    // #when
    const others = otherCardPayments(
      [
        on(5, {}),
        on(6, { state: "ended" }),
        on(7, {}),
        on(8, { card: null, payVia: "outside" }),
      ],
      cardId,
      id(7),
    );

    // #then
    expect(others).toEqual([{ amountUsdc: usd(5), schedule: "monthly" }]);
  });
});

describe("firstDueOn", () => {
  it("finds the first bill's due date as the API does", () => {
    // #then
    expect([
      firstDueOn({
        schedule: "monthly",
        scheduleDay: 6,
        startsOn: "2026-11-06",
        endsOn: null,
      }),
      firstDueOn({
        schedule: "monthly",
        scheduleDay: 31,
        startsOn: "2027-02-10",
        endsOn: null,
      }),
      firstDueOn({
        schedule: "monthly",
        scheduleDay: 1,
        startsOn: "2026-11-06",
        endsOn: null,
      }),
      firstDueOn({
        schedule: "quarterly",
        scheduleDay: 15,
        startsOn: "2026-11-20",
        endsOn: null,
      }),
      firstDueOn({
        schedule: "weekly",
        scheduleDay: 4,
        startsOn: "2026-11-06",
        endsOn: null,
      }),
      firstDueOn({
        schedule: "yearly",
        scheduleDay: 1,
        startsOn: "2026-11-06",
        endsOn: "2027-06-30",
      }),
    ]).toEqual([
      "2026-11-06",
      "2027-02-28",
      "2026-12-01",
      "2027-02-15",
      "2026-11-12",
      null,
    ]);
  });
});

describe("sortRecurringItems", () => {
  it("lists active payments soonest due first, then paused, then ended", () => {
    // #when
    const sorted = sortRecurringItems(RECURRING_ITEMS);

    // #then
    expect(sorted.map((one) => `${one.payee.name} ${one.state}`)).toEqual([
      "Securex Guards active",
      "Kilimani Properties active",
      "Notion active",
      "Zuku active",
      "Twiga Foods active",
      "Figma active",
      "Safaricom active",
      "KRA active",
      "Nairobi Water active",
      "Kenya Power active",
      "Vercel active",
      "Google Workspace active",
      "Jubilee Health paused",
      "CarMax Mechanics paused",
      "Canva ended",
      "Hotpoint Appliances ended",
    ]);
  });

  it("words the reminder lead time", () => {
    // #then
    expect([0, 1, 5].map(reminderInWords)).toEqual([
      "On the due date",
      "1 day before it’s due",
      "5 days before it’s due",
    ]);
  });
});
