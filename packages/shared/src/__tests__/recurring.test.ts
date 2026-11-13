import { describe, expect, it } from "vitest";

import {
  createRecurringItemRequestSchema,
  describeSchedule,
  updateRecurringItemRequestSchema,
} from "../recurring.js";

describe("describeSchedule", () => {
  it.each([
    ["weekly", 1, "2026-11-02", "Every Monday"],
    ["weekly", 7, "2026-11-02", "Every Sunday"],
    ["monthly", 1, "2026-11-02", "Monthly on the 1st"],
    ["monthly", 22, "2026-11-02", "Monthly on the 22nd"],
    ["monthly", 13, "2026-11-02", "Monthly on the 13th"],
    ["monthly", 28, "2026-11-02", "Monthly on the 28th"],
    [
      "monthly",
      31,
      "2026-11-02",
      "Monthly on the 31st, or the month’s last day",
    ],
    [
      "quarterly",
      31,
      "2026-01-01",
      "Quarterly on the 31st of Jan, Apr, Jul and Oct, or the month’s last day",
    ],
    [
      "quarterly",
      20,
      "2026-11-01",
      "Quarterly on the 20th of Feb, May, Aug and Nov",
    ],
    ["yearly", 29, "2028-02-29", "Yearly on the last day of February"],
    ["yearly", 31, "2026-04-01", "Yearly on 30 April"],
    ["yearly", 25, "2026-12-01", "Yearly on 25 December"],
  ] as const)(
    "%s on day %i from %s reads “%s”",
    (schedule, day, startsOn, words) => {
      // #then
      expect(describeSchedule(schedule, day, startsOn)).toBe(words);
    },
  );
});

describe("createRecurringItemRequestSchema", () => {
  const valid = {
    payeeId: "11111111-1111-4111-8111-111111111111",
    categoryId: "22222222-2222-4222-8222-222222222222",
    amountKes: "15,000",
    schedule: "monthly",
    scheduleDay: 31,
    startsOn: "2026-11-02",
  } as const;

  it("parses the amount into cents and fills in the defaults", () => {
    // #when
    const parsed = createRecurringItemRequestSchema.parse(valid);

    // #then
    expect(parsed).toMatchObject({
      amountKes: 1_500_000n,
      variable: false,
      payVia: "expendi",
      reminderDays: 3,
    });
  });

  it.each([
    ["a weekday past 7", { schedule: "weekly", scheduleDay: 8 }],
    ["an end before the start", { endsOn: "2026-11-01" }],
    ["a variable amount", { variable: true }],
    ["no amount on a fixed payment", { amountKes: null }],
  ] as const)("refuses %s", (_case, overrides) => {
    // #then
    expect(
      createRecurringItemRequestSchema.safeParse({ ...valid, ...overrides })
        .success,
    ).toBe(false);
  });

  describe("paid by a company-held card", () => {
    const cardId = "33333333-3333-4333-8333-333333333333";
    const byCard = {
      ...valid,
      amountKes: undefined,
      amountUsd: "20",
      payVia: "card",
      cardId,
    } as const;

    it("takes the card and a USD estimate", () => {
      // #when
      const parsed = createRecurringItemRequestSchema.parse(byCard);

      // #then
      expect(parsed).toMatchObject({
        payVia: "card",
        cardId,
        amountUsd: 20_000_000n,
      });
    });

    it("takes no estimate when it's variable", () => {
      // #when
      const parsed = createRecurringItemRequestSchema.safeParse({
        ...byCard,
        amountUsd: null,
        variable: true,
      });

      // #then
      expect(parsed.success).toBe(true);
    });

    it("needs the card", () => {
      // #when
      const parsed = createRecurringItemRequestSchema.safeParse({
        ...byCard,
        cardId: undefined,
      });

      // #then
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({
          path: ["cardId"],
          message: "Pick the company-held card that pays it.",
        }),
      ]);
    });

    it("refuses an estimate in KES", () => {
      // #when
      const parsed = createRecurringItemRequestSchema.safeParse({
        ...byCard,
        amountUsd: undefined,
        amountKes: "2,600",
      });

      // #then
      expect(parsed.error?.issues).toEqual([
        expect.objectContaining({ path: ["amountKes"] }),
      ]);
    });

    it.each(["expendi", "outside"] as const)(
      "refuses a card on a payment made %s",
      (payVia) => {
        // #when
        const parsed = createRecurringItemRequestSchema.safeParse({
          ...valid,
          payVia,
          cardId,
        });

        // #then
        expect(parsed.error?.issues).toEqual([
          expect.objectContaining({
            path: ["cardId"],
            message: "Only a payment by company-held card has a card.",
          }),
        ]);
      },
    );
  });
});

describe("updateRecurringItemRequestSchema", () => {
  const cardId = "33333333-3333-4333-8333-333333333333";

  it("switches a payment to a company-held card", () => {
    // #when
    const parsed = updateRecurringItemRequestSchema.parse({
      payVia: "card",
      cardId,
      amountUsd: "20",
    });

    // #then
    expect(parsed).toEqual({
      payVia: "card",
      cardId,
      amountUsd: 20_000_000n,
    });
  });

  it("changes the amount alone", () => {
    // #then
    expect(
      updateRecurringItemRequestSchema.safeParse({ amountUsd: "25" }).success,
    ).toBe(true);
  });

  it.each([
    ["no card when switching to one", { payVia: "card" }, ["cardId"]],
    ["a card without switching to one", { cardId }, ["cardId"]],
    [
      "a card when switching to Expendi",
      { payVia: "expendi", cardId },
      ["cardId"],
    ],
    [
      "a KES estimate for a card",
      { payVia: "card", cardId, amountKes: "2,600" },
      ["amountKes"],
    ],
    ["both currencies", { amountKes: "2,600", amountUsd: "20" }, ["amountUsd"]],
  ] as const)("refuses %s", (_case, request, path) => {
    // #when
    const parsed = updateRecurringItemRequestSchema.safeParse(request);

    // #then
    expect(parsed.error?.issues).toEqual([expect.objectContaining({ path })]);
  });
});
