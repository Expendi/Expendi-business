import { describe, expect, it } from "vitest";

import type { RecurringItem } from "@expendi-business/shared";
import { createRecurringItemRequestSchema } from "@expendi-business/shared";

import { RECURRING_ITEMS } from "~/app/dev/preview/_harness/fixtures/bills";
import {
  blankDraft,
  defaultScheduleDay,
  draftFromItem,
  firstDueOn,
  reminderInWords,
  sortRecurringItems,
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
      "Zuku active",
      "Twiga Foods active",
      "Figma active",
      "Safaricom active",
      "KRA active",
      "Nairobi Water active",
      "Kenya Power active",
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
