import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { StaffCardSimulations } from "@expendi-business/shared";
import { staffCardSimulationsSchema } from "@expendi-business/shared";

import {
  CardSimulationsView,
  lastSimulationSummary,
} from "./card-simulations-view";

const ID = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const simulations = (overrides: object = {}): StaffCardSimulations =>
  staffCardSimulationsSchema.parse({
    available: true,
    payments: [
      {
        id: ID(1),
        payeeName: "Anthropic",
        state: "paused",
        estimateUsdCents: "2000",
        card: {
          nickname: "Software subscriptions",
          lastFour: "1881",
          state: "frozen",
        },
        nextBill: {
          id: ID(2),
          dueOn: "2026-11-13",
          status: "overdue",
          amountUsdCents: "2150",
        },
        lastSimulation: {
          at: "2026-11-12T07:00:00.000Z",
          amountUsdCents: "2150",
          merchantKey: "SBX0123456789AB",
          result: "declined",
          byStaff: false,
        },
      },
    ],
    ...overrides,
  });

const render = (data: StaffCardSimulations) =>
  renderToStaticMarkup(
    <CardSimulationsView
      simulations={data}
      renderAction={(payment) => (
        <button type="button">act {payment.id}</button>
      )}
    />,
  );

describe("CardSimulationsView", () => {
  it("shows each payment's estimate, card, next bill and last simulation", () => {
    // #when
    const markup = render(simulations());

    // #then
    for (const text of [
      "Anthropic",
      "Paused",
      "USD 20.00",
      "Software subscriptions ··1881",
      "frozen",
      "Due 2026-11-13, USD 21.50",
      "overdue",
      "Declined · USD 21.50 · by the daily job",
      "SBX0123456789AB",
      `act ${ID(1)}`,
    ]) {
      expect(markup).toContain(text);
    }
  });

  it("says when nothing is paid by a company-held card", () => {
    // #then
    expect(render(simulations({ payments: [] }))).toContain(
      "No recurring payment is paid by a company-held card.",
    );
  });

  it("says when simulated purchases are turned off for this environment, and offers nothing", () => {
    // #when
    const markup = render(simulations({ available: false }));

    // #then
    expect(markup).toContain(
      "Simulated purchases are turned off for this environment.",
    );
    expect(markup).toContain("CARD_SIMULATIONS_ENABLED");
    expect(markup).not.toContain("act ");
  });
});

describe("lastSimulationSummary", () => {
  it.each([
    [null, true, "Not seen by the purchase check yet · USD 1.00 · by staff"],
    ["approved", false, "Approved · USD 1.00 · by the daily job"],
    [
      "unknown",
      true,
      "Outcome unknown: Lithic didn't confirm it · USD 1.00 · by staff",
    ],
  ] as const)("words a %s simulation", (result, byStaff, words) => {
    // #then
    expect(
      lastSimulationSummary({
        at: "2026-11-12T07:00:00.000Z",
        amountUsdCents: "100",
        merchantKey: "SBX1",
        result,
        byStaff,
      }),
    ).toBe(words);
  });
});
