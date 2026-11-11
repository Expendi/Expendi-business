import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FundIn } from "@expendi-business/shared";
import { FUND_IN_STATUSES } from "@expendi-business/shared";

import { FUND_INS } from "~/app/dev/preview/_harness/fixtures/wallet";
import { fundInDraft } from "./fund-in-display";
import { FundInDetails } from "./fund-in-sheet";
import { fundInPollInterval, isFinalFundIn } from "./wallet-api";

vi.mock("~/lib/use-api", () => ({ useApi: () => ({}) }));

/** 09:30 on 6 November 2026 in Nairobi. */
const NOW = new Date("2026-11-06T06:30:00Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

function waiting(): FundIn {
  const fundIn = FUND_INS.find(
    (candidate) => candidate.status === "awaiting_deposit",
  );
  if (!fundIn) throw new Error("No sample fund-in waiting for its deposit");
  return fundIn;
}

function details(fundIn: FundIn): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <FundInDetails fundIn={fundIn} />
    </QueryClientProvider>,
  ).replace(/<[^>]+>/g, " ");
}

describe("starting a fund-in from another chain", () => {
  it("asks for the chain and the amount in base units", () => {
    // #when
    const draft = fundInDraft("arbitrum", "2500.5");

    // #then
    expect(draft).toEqual({
      ok: true,
      request: { chain: "arbitrum", amount: "2500500000" },
    });
  });

  it("refuses an amount that isn't a positive USDC amount", () => {
    // #when
    const drafts = [
      fundInDraft("base", ""),
      fundInDraft("base", "0"),
      fundInDraft("base", "1.0000001"),
    ];

    // #then
    expect(drafts.map((draft) => (draft.ok ? "ok" : draft.errors))).toEqual([
      { amount: "Enter an amount in USDC." },
      { amount: "Enter an amount above zero." },
      { amount: "USDC has at most 6 decimal places." },
    ]);
  });
});

describe("following a fund-in", () => {
  it("keeps asking until the fund-in is final", () => {
    // #then
    expect(
      FUND_IN_STATUSES.map((status) => [
        status,
        isFinalFundIn(status),
        fundInPollInterval({ ...waiting(), status }),
      ]),
    ).toEqual([
      ["awaiting_deposit", false, 5000],
      ["processing", false, 5000],
      ["completed", true, false],
      ["returning", false, 5000],
      ["returned", true, false],
      ["refunded", true, false],
      ["failed", true, false],
      ["expired", true, false],
    ]);
  });

  it("asks again while the fund-in hasn't loaded", () => {
    // #then
    expect(fundInPollInterval(undefined)).toBe(5000);
  });

  it("says what to send, where, what arrives and by when", () => {
    // #when
    const page = details(waiting());

    // #then
    expect({
      status: page.includes("Waiting for your USDC"),
      send: /Send exactly\s+2,500\.00 USDC/.test(page),
      chain: /On\s+Base/.test(page),
      address: ["9d4c", "1e7a", "b0c3"].every((group) => page.includes(group)),
      arrives: /Arrives in the wallet\s+2,499\.87 USDC/.test(page),
      deadline: /Send by\s+Today, 11:30/.test(page),
      copy: page.includes("Copy address"),
      warning: page.includes("Send only USDC on Base"),
    }).toEqual({
      status: true,
      send: true,
      chain: true,
      address: true,
      arrives: true,
      deadline: true,
      copy: true,
      warning: true,
    });
  });

  it.each([
    ["processing", "On its way", "on its way to the company wallet"],
    ["completed", "In the wallet", "is in the company wallet"],
    ["returning", "Returning", "on its way back to your company wallet"],
    ["returned", "Returned", "shows in History as a deposit"],
    ["refunded", "Refunded", "went back to the refund address you gave"],
    ["failed", "Failed", "Expendi is looking into it"],
    ["expired", "Expired", "Start a new fund-in"],
  ] as const)(
    "says a %s fund-in is %s, with nothing left to send",
    (status, label, note) => {
      // #when
      const page = details({ ...waiting(), status });

      // #then
      expect({
        label: page.includes(label),
        note: page.includes(note),
        copy: page.includes("Copy address"),
        warning: page.includes("Send only USDC"),
      }).toEqual({ label: true, note: true, copy: false, warning: false });
    },
  );
});
