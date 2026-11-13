import { describe, expect, it } from "vitest";

import type { Bill, BillDetail } from "@expendi-business/shared";
import { updateBillRequestSchema } from "@expendi-business/shared";

import { billBadges } from "./bill-badges";
import {
  automaticCard,
  cardDeclineLine,
  cardPaymentInWords,
  formatEstimate,
  paidByCardAmount,
  paidByCardLabel,
  payingCard,
} from "./bill-card";
import { draftFromBill, toUpdateRequest } from "./bill-draft";

const CARD = {
  id: "44444444-4444-4444-8444-444444444444",
  nickname: "Software",
  lastFour: "1234",
};
const OPEN_CARD = { ...CARD, state: "open" } as const;

/** A bill a company-held card pays: in USD, to a payee paid outside Expendi. */
function cardBill(overrides: Partial<Bill> = {}): Bill {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    status: "upcoming",
    payee: {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Vercel",
      kind: "vendor",
      method: "outside",
      archived: false,
    },
    overviewHeading: "subscriptions",
    category: { id: "22222222-2222-4222-8222-222222222222", name: "Software" },
    variable: false,
    currency: "usd",
    amountKes: null,
    amountUsdc: "20000000",
    reference: null,
    notes: null,
    dueOn: "2026-11-20",
    recurringItemId: "33333333-3333-4333-8333-333333333333",
    payrollRunId: null,
    adjustmentReason: null,
    paidOn: null,
    paidAt: null,
    markedPaidBy: null,
    paidOutsideNote: null,
    cancelledReason: null,
    cancelledAt: null,
    cancelledBy: null,
    payoutId: null,
    paymentReceipts: [],
    fileCount: 0,
    card: CARD,
    cardDeclinedAt: null,
    cardDeclineReason: null,
    cardPurchaseId: null,
    createdAt: "2026-11-01T08:00:00.000Z",
    updatedAt: "2026-11-01T08:00:00.000Z",
    ...overrides,
  };
}

describe("a bill a company-held card pays", () => {
  it("is labelled Automatic with the card's last four, in the neutral style", () => {
    // #when
    const badges = billBadges(cardBill());

    // #then
    expect(badges).toEqual([
      { label: "Upcoming", tone: "neutral" },
      { label: "Automatic · card •••• 1234", tone: "neutral" },
    ]);
  });

  it("adds Card declined in the overdue style while it's still owed", () => {
    // #given
    const declined = cardBill({
      status: "overdue",
      cardDeclinedAt: "2026-11-12T22:30:00.000Z",
      cardDeclineReason: "The Card balance is too low.",
    });

    // #when
    const badges = billBadges(declined);

    // #then
    expect({
      badges,
      line: cardDeclineLine(declined),
    }).toEqual({
      badges: [
        { label: "Overdue", tone: "warning" },
        { label: "Automatic · card •••• 1234", tone: "neutral" },
        { label: "Card declined", tone: "warning" },
      ],
      line: "13 Nov 2026: The Card balance is too low.",
    });
  });

  it("says a decline came with no reason rather than leaving it blank", () => {
    // #then
    expect(
      cardDeclineLine(cardBill({ cardDeclinedAt: "2026-11-12T08:00:00.000Z" })),
    ).toBe("12 Nov 2026: No reason given");
  });

  it("isn't automatic, or declined, once it's settled", () => {
    // #given
    const paid = cardBill({
      status: "paid_by_card",
      paidOn: "2026-11-20",
      cardDeclinedAt: "2026-11-12T08:00:00.000Z",
    });

    // #then
    expect({
      card: automaticCard(paid),
      badges: billBadges(paid),
      decline: cardDeclineLine(paid),
      label: paidByCardLabel(paid),
    }).toEqual({
      card: null,
      badges: [{ label: "Paid by card", tone: "success" }],
      decline: null,
      label: "Paid by card •••• 1234",
    });
  });

  it("reads its amount as an estimate, or says there's none", () => {
    // #then
    expect([
      formatEstimate(cardBill()),
      formatEstimate(cardBill({ variable: true, amountUsdc: null })),
    ]).toEqual(["About USD 20.00", "No estimate"]);
  });

  it("says it's paid when the payee charges the card, once the card is known to be open", () => {
    // #then
    expect({
      open: cardPaymentInWords(cardBill({ card: OPEN_CARD })),
      unknown: cardPaymentInWords(cardBill()),
      settled: cardPaymentInWords(
        cardBill({ status: "paid_by_card", card: OPEN_CARD }),
      ),
    }).toEqual({
      open: "Paid by card •••• 1234 when Vercel charges it",
      unknown: "By company-held card •••• 1234",
      settled: null,
    });
  });

  it("leaves an ordinary bill, and one from an API that sends no card, as it was", () => {
    // #given
    const ordinary = cardBill({ card: null });
    const older = cardBill();
    delete older.card;

    // #then
    expect({
      ordinary: [automaticCard(ordinary), billBadges(ordinary).length],
      older: [automaticCard(older), paidByCardLabel(older)],
    }).toEqual({ ordinary: [null, 1], older: [null, null] });
  });
});

describe("a bill a company-held card won't pay after all", () => {
  const RECURRING = {
    id: "33333333-3333-4333-8333-333333333333",
    state: "active",
    schedule: "monthly",
    scheduleDay: 20,
    startsOn: "2026-01-20",
  } as const satisfies NonNullable<Bill["recurring"]>;

  it.each([
    ["paused", "Paused: Card purchases from Vercel are declined"],
    ["ended", "Ended: Card purchases from Vercel are declined"],
  ] as const)(
    "says why when its recurring payment is %s, even with the card open",
    (state, why) => {
      // #given
      const bill = cardBill({
        card: OPEN_CARD,
        recurring: { ...RECURRING, state },
      });

      // #then
      expect({
        paying: payingCard(bill),
        badges: billBadges(bill),
        howPaid: cardPaymentInWords(bill),
        estimate: formatEstimate(bill),
      }).toEqual({
        paying: null,
        badges: [{ label: "Upcoming", tone: "neutral" }],
        howPaid: why,
        estimate: "About USD 20.00",
      });
    },
  );

  it.each([
    ["frozen", "Card •••• 1234 is frozen", "Card frozen"],
    ["closed", "Card •••• 1234 is closed", "Card closed"],
  ] as const)(
    "says why when its card is %s, naming it in place of Automatic",
    (state, why, badge) => {
      // #given
      const bill = cardBill({ card: { ...CARD, state }, recurring: RECURRING });

      // #then
      expect({
        paying: payingCard(bill),
        badges: billBadges(bill),
        howPaid: cardPaymentInWords(bill),
      }).toEqual({
        paying: null,
        badges: [
          { label: "Upcoming", tone: "neutral" },
          { label: badge, tone: "warning" },
        ],
        howPaid: why,
      });
    },
  );

  it("is still labelled Automatic while its payment is active and the card's state isn't known", () => {
    // #given
    const bill = cardBill({ recurring: RECURRING });

    // #then
    expect({
      paying: payingCard(bill),
      badges: billBadges(bill),
    }).toEqual({
      paying: CARD,
      badges: [
        { label: "Upcoming", tone: "neutral" },
        { label: "Automatic · card •••• 1234", tone: "neutral" },
      ],
    });
  });

  it("is paid by the card when it's the last bill of a payment that ended, unless that's paused", () => {
    // #given
    const lastBill = (active: boolean | undefined) =>
      cardBill({
        card: OPEN_CARD,
        recurring: { ...RECURRING, state: "ended", active },
      });

    // #when
    const said = [true, false, undefined].map((active) => {
      const bill = lastBill(active);
      return {
        paying: payingCard(bill) !== null,
        howPaid: cardPaymentInWords(bill),
      };
    });

    // #then
    expect(said).toEqual([
      {
        paying: true,
        howPaid: "Card •••• 1234 pays this last bill, and nothing after it.",
      },
      {
        paying: false,
        howPaid: "Ended: Card purchases from Vercel are declined",
      },
      {
        paying: false,
        howPaid: "Ended: Card purchases from Vercel are declined",
      },
    ]);
    expect(billBadges(lastBill(true))).toEqual([
      { label: "Upcoming", tone: "neutral" },
      { label: "Automatic · card •••• 1234", tone: "neutral" },
    ]);
  });

  it("names a frozen card on the last bill of a payment that ended", () => {
    // #given
    const bill = cardBill({
      card: { ...CARD, state: "frozen" },
      recurring: { ...RECURRING, state: "ended", active: true },
    });

    // #then
    expect(cardPaymentInWords(bill)).toBe("Card •••• 1234 is frozen");
  });

  it("keeps showing a decline after its payment is paused", () => {
    // #given
    const bill = cardBill({
      status: "overdue",
      recurring: { ...RECURRING, state: "paused" },
      cardDeclinedAt: "2026-11-12T08:00:00.000Z",
    });

    // #then
    expect(billBadges(bill)).toEqual([
      { label: "Overdue", tone: "warning" },
      { label: "Card declined", tone: "warning" },
    ]);
  });
});

describe("a bill's own card state, as the bills list sends it", () => {
  it("names a frozen card in place of Automatic, beside a decline and a paused payment", () => {
    // #given
    const frozen = { ...CARD, state: "frozen" } as const;
    const declined = cardBill({
      status: "overdue",
      card: frozen,
      cardDeclinedAt: "2026-11-12T08:00:00.000Z",
    });
    const paused = cardBill({
      card: frozen,
      recurring: {
        id: "33333333-3333-4333-8333-333333333333",
        state: "paused",
        schedule: "monthly",
        scheduleDay: 20,
        startsOn: "2026-01-20",
      },
    });

    // #then
    expect({
      declined: billBadges(declined),
      paused: billBadges(paused),
    }).toEqual({
      declined: [
        { label: "Overdue", tone: "warning" },
        { label: "Card frozen", tone: "warning" },
        { label: "Card declined", tone: "warning" },
      ],
      paused: [
        { label: "Upcoming", tone: "neutral" },
        { label: "Card frozen", tone: "warning" },
      ],
    });
  });

  it("stops naming the card once the bill is settled, even if it's closed since", () => {
    // #given
    const settled = cardBill({
      status: "paid_by_card",
      card: { ...CARD, state: "closed" },
    });

    // #then
    expect(billBadges(settled)).toEqual([
      { label: "Paid by card", tone: "success" },
    ]);
  });
});

describe("what a Card purchase paid", () => {
  function paidByCard(overrides: Partial<BillDetail> = {}): BillDetail {
    return {
      ...cardBill({ status: "paid_by_card", paidOn: "2026-11-20" }),
      files: [],
      paidAmountKes: "260000",
      ...overrides,
    };
  }

  it("puts the KES it came to beside a USD bill's amount", () => {
    // #then
    expect(paidByCardAmount(paidByCard())).toBe("USD 20.00 · KES 2,600.00");
  });

  it("shows just the amount when the KES isn't known, or the bill is in KES", () => {
    // #then
    expect([
      paidByCardAmount(paidByCard({ paidAmountKes: null })),
      paidByCardAmount(paidByCard({ paidAmountKes: undefined })),
      paidByCardAmount(
        paidByCard({ currency: "kes", amountKes: "260000", amountUsdc: null }),
      ),
      paidByCardAmount(paidByCard({ amountUsdc: null })),
    ]).toEqual(["USD 20.00", "USD 20.00", "KES 2,600.00", null]);
  });
});

describe("editing a bill a company-held card pays", () => {
  it("keeps its USD estimate rather than switching to the payee's KES", () => {
    // #given
    const existing = cardBill();

    // #when
    const draft = draftFromBill(existing);

    // #then
    expect({ currency: draft.currency, amount: draft.amount }).toEqual({
      currency: "usd",
      amount: "20.00",
    });
  });

  it("sends only what changed, so its amount isn't touched", () => {
    // #given
    const existing = cardBill();

    // #when
    const request = toUpdateRequest(existing, {
      ...draftFromBill(existing),
      notes: "Team plan",
    });

    // #then
    expect(request).toEqual({ notes: "Team plan" });
    expect(updateBillRequestSchema.safeParse(request).success).toBe(true);
  });

  it("sends a new estimate in USD", () => {
    // #given
    const existing = cardBill();

    // #when
    const request = toUpdateRequest(existing, {
      ...draftFromBill(existing),
      amount: "25",
      adjustmentReason: "More seats",
    });

    // #then
    expect(request).toEqual({
      amountUsd: "25",
      adjustmentReason: "More seats",
    });
  });
});
