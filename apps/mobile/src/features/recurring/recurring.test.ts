import { describe, expect, it } from "vitest";

import type { RecurringItem } from "@expendi-business/shared";
import {
  createRecurringItemRequestSchema,
  updateRecurringItemRequestSchema,
} from "@expendi-business/shared";

import {
  blankDraft,
  defaultScheduleDay,
  draftFromItem,
  isoWeekday,
  nextDueDate,
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
