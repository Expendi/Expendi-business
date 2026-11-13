import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { StaffCardPaidPayment } from "@expendi-business/shared";
import { staffCardPaidPaymentSchema } from "@expendi-business/shared";

import { ApiError } from "~/lib/api";
import {
  CARD_SIMULATION_COPY,
  CardSimulationFlow,
  defaultAmount,
  isAmountRefusal,
  SimulationOutcome,
  SimulationReview,
} from "./card-simulation-flow";

vi.mock("~/contexts/staff-auth-context", () => ({
  useStaffAuth: () => ({ api: {} }),
}));

const payment = (overrides: object = {}): StaffCardPaidPayment =>
  staffCardPaidPaymentSchema.parse({
    id: "00000000-0000-4000-8000-000000000001",
    payeeName: "Anthropic",
    state: "active",
    estimateUsdCents: "2000",
    card: {
      nickname: "Software subscriptions",
      lastFour: "1881",
      state: "open",
    },
    nextBill: null,
    lastSimulation: null,
    ...overrides,
  });

const html = (text: string) => text.replaceAll("'", "&#x27;");

const noop = () => undefined;

describe("CardSimulationFlow", () => {
  it("offers the purchase with what it does, before asking anything", () => {
    // #when
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={new QueryClient()}>
        <CardSimulationFlow
          organizationId="00000000-0000-4000-8000-000000000002"
          payment={payment()}
        />
      </QueryClientProvider>,
    );

    // #then
    expect(markup).toContain(CARD_SIMULATION_COPY.button);
    expect(markup).toContain(html(CARD_SIMULATION_COPY.hint));
    expect(markup).not.toContain("Amount in US dollars");
  });
});

describe("defaultAmount", () => {
  it("starts from the bill still owed", () => {
    // #then
    expect(
      defaultAmount(
        payment({
          nextBill: {
            id: "00000000-0000-4000-8000-000000000003",
            dueOn: "2026-11-13",
            status: "due",
            amountUsdCents: "2150",
          },
        }),
      ),
    ).toBe("21.50");
  });

  it("falls back to the estimate, then to nothing", () => {
    // #then
    expect(defaultAmount(payment())).toBe("20.00");
    expect(defaultAmount(payment({ estimateUsdCents: "5" }))).toBe("0.05");
    expect(defaultAmount(payment({ estimateUsdCents: null }))).toBe("");
  });
});

describe("SimulationReview", () => {
  const review = (
    overrides: object = {},
    options: { newMerchant?: boolean } = {},
  ) =>
    renderToStaticMarkup(
      <SimulationReview
        payment={payment(overrides)}
        amountUsdCents="1250"
        newMerchant={options.newMerchant ?? false}
        pending={false}
        error={null}
        onConfirm={noop}
        onBack={noop}
      />,
    );

  it("says who it pretends to be, what it charges and to which card", () => {
    // #when
    const markup = review();

    // #then
    expect(markup).toContain(html("Anthropic's usual merchant"));
    expect(markup).toContain("USD 12.50");
    expect(markup).toContain("Software subscriptions");
    expect(markup).toContain("1881");
    expect(markup).toContain(CARD_SIMULATION_COPY.confirm);
  });

  it("says when the merchant is a new one", () => {
    // #then
    expect(review({}, { newMerchant: true })).toContain(
      "a merchant this card has never seen",
    );
  });

  it.each([
    ["a paused payment", { state: "paused" }, "This payment is paused"],
    [
      "a frozen card",
      {
        card: {
          nickname: "Software subscriptions",
          lastFour: "1881",
          state: "frozen",
        },
      },
      "The card is frozen",
    ],
  ])("warns that %s should be declined", (_case, overrides, warning) => {
    // #then
    expect(review(overrides)).toContain(warning);
  });

  it("shows a refusal such as the hourly limit where the purchase is confirmed", () => {
    // #when
    const markup = renderToStaticMarkup(
      <SimulationReview
        payment={payment()}
        amountUsdCents="1250"
        newMerchant={false}
        pending={false}
        error="Too many simulated purchases for this company in the last hour. Try again later."
        onConfirm={noop}
        onBack={noop}
      />,
    );

    // #then
    expect(markup).toContain(
      "Too many simulated purchases for this company in the last hour. Try again later.",
    );
    expect(markup).toContain(CARD_SIMULATION_COPY.confirm);
  });
});

describe("isAmountRefusal", () => {
  it("sends an amount the API won't take, such as one over the monthly limit, back to the amount field", () => {
    // #then
    expect(
      isAmountRefusal(
        new ApiError(
          400,
          "BadRequest",
          "That's more than this card's monthly limit of USD 50.00.",
        ),
      ),
    ).toBe(true);
  });

  it.each([
    new ApiError(
      429,
      "TooManyRequests",
      "Too many simulated purchases for this company in the last hour. Try again later.",
    ),
    new ApiError(503, "ServiceUnavailable", "Lithic's sandbox didn't answer."),
    new Error("offline"),
  ])("keeps any other refusal in the review: %s", (error) => {
    // #then
    expect(isAmountRefusal(error)).toBe(false);
  });
});

describe("SimulationOutcome", () => {
  it.each([
    ["approved", "Approved"],
    ["declined", "Declined"],
  ] as const)("shows a %s purchase and its merchant", (result, label) => {
    // #when
    const markup = renderToStaticMarkup(
      <SimulationOutcome
        result={{ transactionToken: "tx-1", result, merchant: "ANTHROPIC" }}
        onDone={noop}
      />,
    );

    // #then
    expect(markup).toContain(label);
    expect(markup).toContain("From ANTHROPIC");
  });

  it("says plainly when Lithic didn't say how the purchase check answered", () => {
    // #when
    const markup = renderToStaticMarkup(
      <SimulationOutcome
        result={{
          transactionToken: "tx-1",
          result: "unknown",
          merchant: "ANTHROPIC",
        }}
        onDone={noop}
      />,
    );

    // #then
    expect(markup).toContain("Not seen yet");
    expect(markup).toContain(
      html(
        "Lithic made the purchase but didn't say whether the purchase check approved it, so it wasn't settled. Check the company's Card purchases before running it again.",
      ),
    );
    expect(markup).not.toContain("Declined");
  });
});
