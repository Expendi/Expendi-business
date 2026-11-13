import { describe, expect, it } from "vitest";

import type { RecurringItem } from "@expendi-business/shared";
import {
  createRecurringItemRequestSchema,
  updateRecurringItemRequestSchema,
} from "@expendi-business/shared";

import { billBadges } from "../bills/bill-badges";
import {
  blankDraft,
  defaultScheduleDay,
  draftFromItem,
  isoWeekday,
  nextBillBadgeFields,
  nextBillCardDeclined,
  nextDueDate,
  payingCardLabel,
  payViaInWords,
  recurringAmount,
  reminderInWords,
  toCreateRequest,
  toUpdateRequest,
} from "./recurring-draft";

function item(overrides: Partial<RecurringItem> = {}): RecurringItem {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    state: "active",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Landlord Ltd",
      kind: "supplier",
      method: "bank",
      archived: false,
    },
    overviewHeading: "transactions",
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Rent" },
    variable: false,
    currency: "kes",
    amountKes: "4500000",
    amountUsdc: null,
    schedule: "monthly",
    scheduleDay: 31,
    startsOn: "2026-11-01",
    endsOn: null,
    payVia: "expendi",
    reminderDays: 3,
    active: true,
    nextDueOn: "2026-12-31",
    nextBill: {
      id: "33333333-3333-4333-8333-333333333333",
      status: "upcoming",
      dueOn: "2026-11-30",
      amountKes: "4500000",
      amountUsdc: null,
    },
    createdAt: "2026-11-02T08:00:00.000Z",
    updatedAt: "2026-11-02T08:00:00.000Z",
    ...overrides,
  };
}

describe("a new recurring payment", () => {
  it("starts monthly from today, on today's day of the month", () => {
    // #when
    const draft = blankDraft("2026-11-02");

    // #then
    expect(draft).toMatchObject({
      schedule: "monthly",
      scheduleDay: "2",
      startsOn: "2026-11-02",
      reminderDays: "3",
      payVia: "expendi",
    });
  });

  it("picks the start date's weekday for weekly, Monday being 1", () => {
    // #then
    expect([
      isoWeekday("2026-11-02"),
      isoWeekday("2026-11-08"),
      defaultScheduleDay("weekly", "2026-11-06"),
      defaultScheduleDay("yearly", "2028-02-29"),
    ]).toEqual([1, 7, "5", "29"]);
  });

  it("sends a fixed payment the API accepts, with whole-number days", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      payeeId: "11111111-1111-4111-8111-111111111111",
      categoryId: "22222222-2222-4222-8222-222222222222",
      amount: "45,000",
      scheduleDay: "31",
      reminderDays: "7",
    };

    // #when
    const request = toCreateRequest(draft);

    // #then
    expect(request).toMatchObject({
      amountKes: "45,000",
      scheduleDay: 31,
      reminderDays: 7,
      endsOn: null,
    });
    expect(createRecurringItemRequestSchema.safeParse(request).success).toBe(
      true,
    );
  });

  it("drops the typed amount of a variable payment", () => {
    // #given
    const draft = {
      ...blankDraft("2026-11-02"),
      variable: true,
      amount: "100",
    };

    // #then
    expect(toCreateRequest(draft).amountKes).toBeNull();
  });

  it.each(["", "3.5", "x"])(
    "turns a day typed as %j into one the API refuses",
    (typed) => {
      // #given
      const draft = {
        ...blankDraft("2026-11-02"),
        payeeId: "11111111-1111-4111-8111-111111111111",
        categoryId: "22222222-2222-4222-8222-222222222222",
        amount: "100",
        scheduleDay: typed,
      };

      // #then
      expect(
        createRecurringItemRequestSchema.safeParse(toCreateRequest(draft))
          .success,
      ).toBe(false);
    },
  );
});

describe("editing a recurring payment", () => {
  it("sends nothing when nothing changed", () => {
    // #given
    const existing = item();

    // #then
    expect(toUpdateRequest(existing, draftFromItem(existing))).toEqual({});
  });

  it("sends the amount only when its value changed", () => {
    // #given
    const existing = item();
    const draft = draftFromItem(existing);

    // #then
    expect(toUpdateRequest(existing, { ...draft, amount: "45,000" })).toEqual(
      {},
    );
    expect(toUpdateRequest(existing, { ...draft, amount: "47,500" })).toEqual({
      amountKes: "47,500",
    });
  });

  it("makes a fixed payment variable by clearing the amount", () => {
    // #given
    const existing = item();

    // #then
    expect(
      toUpdateRequest(existing, {
        ...draftFromItem(existing),
        variable: true,
      }),
    ).toEqual({ amountKes: null });
  });

  it("keeps a blank fixed amount an error rather than making it variable", () => {
    // #given
    const existing = item();
    const request = toUpdateRequest(existing, {
      ...draftFromItem(existing),
      amount: " ",
    });

    // #then
    expect(request).toEqual({ amountKes: "" });
    expect(updateRecurringItemRequestSchema.safeParse(request).success).toBe(
      false,
    );
  });

  it("sends a new end date, and null to remove one", () => {
    // #given
    const open = item();
    const ending = item({ endsOn: "2027-06-30" });

    // #then
    expect(
      toUpdateRequest(open, { ...draftFromItem(open), endsOn: "2027-06-30" }),
    ).toEqual({ endsOn: "2027-06-30" });
    expect(
      toUpdateRequest(ending, { ...draftFromItem(ending), endsOn: "" }),
    ).toEqual({ endsOn: null });
  });
});

describe("a recurring payment a company-held card pays", () => {
  const card = {
    id: "44444444-4444-4444-8444-444444444444",
    nickname: "Software",
    lastFour: "1234",
    state: "open" as const,
  };

  /** Set up on the web: USD estimate, payee paid outside Expendi. */
  function byCard(overrides: Partial<RecurringItem> = {}): RecurringItem {
    return item({
      payee: {
        id: "11111111-1111-4111-8111-111111111111",
        name: "Vercel",
        kind: "vendor",
        method: "outside",
        archived: false,
      },
      overviewHeading: "subscriptions",
      currency: "usd",
      amountKes: null,
      amountUsdc: "20000000",
      payVia: "card",
      card,
      nextBill: null,
      ...overrides,
    });
  }

  it("shows the card as how it's paid, and its amount as a USD estimate", () => {
    // #given
    const existing = byCard();

    // #then
    expect({
      card: payingCardLabel(existing),
      amount: recurringAmount(existing, "Variable"),
      noEstimate: recurringAmount(
        byCard({ variable: true, amountUsdc: null }),
        "Variable",
      ),
      paid: payViaInWords(existing),
      reminder: reminderInWords(existing),
    }).toEqual({
      card: "Card •••• 1234",
      amount: "About USD 20.00",
      noEstimate: "No estimate",
      paid: "By company-held card •••• 1234. Each bill is paid when Vercel charges the card.",
      reminder: "Only if a bill goes overdue",
    });
  });

  it("notes a frozen or closed card, which declines its Card purchases", () => {
    // #given
    const frozen = byCard({ card: { ...card, state: "frozen" } });
    const closed = byCard({ card: { ...card, state: "closed" } });

    // #then
    expect({
      frozen: [payingCardLabel(frozen), payViaInWords(frozen)],
      closed: [payingCardLabel(closed), payViaInWords(closed)],
    }).toEqual({
      frozen: [
        "Card •••• 1234 · Frozen",
        "By company-held card •••• 1234. Each bill is paid when Vercel charges the card. The card is frozen, so Card purchases are declined until it’s unfrozen on the web dashboard.",
      ],
      closed: [
        "Card •••• 1234 · Closed",
        "By company-held card •••• 1234. Each bill is paid when Vercel charges the card. The card is closed. Move this payment to another card on the web dashboard.",
      ],
    });
  });

  it("leaves a payment through or outside Expendi worded as before", () => {
    // #given
    const expendi = item();
    const outside = item({ payVia: "outside", reminderDays: 1 });

    // #then
    expect({
      card: [payingCardLabel(expendi), payingCardLabel(outside)],
      amount: recurringAmount(expendi, "Variable"),
      paid: [payViaInWords(expendi), payViaInWords(outside)],
      reminder: [reminderInWords(expendi), reminderInWords(outside)],
    }).toEqual({
      card: [null, null],
      amount: "KES 45,000.00",
      paid: [
        "Through Expendi",
        "Outside Expendi. Mark each bill paid once you’ve paid it.",
      ],
      reminder: ["3 days before it’s due", "1 day before it’s due"],
    });
  });

  it("starts its edit form on the USD estimate, not the payee's KES", () => {
    // #when
    const draft = draftFromItem(byCard());

    // #then
    expect({
      currency: draft.currency,
      amount: draft.amount,
      payVia: draft.payVia,
    }).toEqual({ currency: "usd", amount: "20.00", payVia: "card" });
  });

  it("saves other changes without sending how it's paid or its card", () => {
    // #given
    const existing = byCard();

    // #when
    const request = toUpdateRequest(existing, {
      ...draftFromItem(existing),
      endsOn: "2027-06-30",
      categoryId: "55555555-5555-4555-8555-555555555555",
    });

    // #then
    expect(request).toEqual({
      endsOn: "2027-06-30",
      categoryId: "55555555-5555-4555-8555-555555555555",
    });
    expect(updateRecurringItemRequestSchema.safeParse(request).success).toBe(
      true,
    );
  });

  it("sends a new estimate as amountUsd, which the API takes for a card", () => {
    // #given
    const existing = byCard();

    // #when
    const request = toUpdateRequest(existing, {
      ...draftFromItem(existing),
      amount: "25",
    });

    // #then
    expect(request).toEqual({ amountUsd: "25" });
    expect(
      updateRecurringItemRequestSchema.safeParse({
        ...request,
        payVia: "card",
        cardId: card.id,
      }).success,
    ).toBe(true);
  });

  it("badges its next bill Card declined once the card declined it, beside Automatic", () => {
    // #given
    const nextBill = {
      id: "33333333-3333-4333-8333-333333333333",
      status: "overdue" as const,
      dueOn: "2026-11-20",
      currency: "usd" as const,
      amountKes: null,
      amountUsdc: "20000000",
    };
    const declined = byCard({
      nextBill: { ...nextBill, cardDeclinedAt: "2026-11-20T06:00:00.000Z" },
    });
    const notDeclined = byCard({
      nextBill: { ...nextBill, cardDeclinedAt: null },
    });
    const olderApi = byCard({ nextBill });
    const declinedFields = nextBillBadgeFields(declined);

    // #then
    expect({
      declined: [
        nextBillCardDeclined(declined),
        declinedFields && billBadges(declinedFields),
      ],
      notDeclined: nextBillCardDeclined(notDeclined),
      olderApi: nextBillCardDeclined(olderApi),
      noBill: [nextBillCardDeclined(byCard()), nextBillBadgeFields(byCard())],
    }).toEqual({
      declined: [
        true,
        [
          { label: "Overdue", tone: "warning" },
          { label: "Automatic · card •••• 1234", tone: "neutral" },
          { label: "Card declined", tone: "warning" },
        ],
      ],
      notDeclined: false,
      olderApi: false,
      noBill: [false, null],
    });
  });

  it("drops the estimate as amountUsd: null when it's made usage-based", () => {
    // #given
    const existing = byCard();

    // #then
    expect(
      toUpdateRequest(existing, { ...draftFromItem(existing), variable: true }),
    ).toEqual({ amountUsd: null });
  });
});

describe("nextDueDate", () => {
  it("is the bill still owed when there is one", () => {
    // #then
    expect(nextDueDate(item())).toBe("2026-11-30");
  });

  it("is the schedule's next date when there is no bill", () => {
    // #then
    expect(nextDueDate(item({ nextBill: null }))).toBe("2026-12-31");
  });

  it("is nothing once ended with no bill left", () => {
    // #then
    expect(
      nextDueDate(item({ state: "ended", nextBill: null, nextDueOn: null })),
    ).toBeNull();
  });
});
