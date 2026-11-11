import { describe, expect, it } from "vitest";

import type { FundIn } from "@expendi-business/shared";
import { FUND_IN_STATUSES } from "@expendi-business/shared";

import {
  FUND_IN_STATUS,
  fundInDraft,
  fundInPollInterval,
  isFinalFundIn,
} from "./fund-in";

const BASE_ADDRESS = "0x12ab7c3e9f04d5b6a8c1e2f3d4b5a6c7e8f99f3c";
const SOLANA_ADDRESS = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";

const fundIn: FundIn = {
  id: "00000000-0000-4000-8000-000000000621",
  chain: "base",
  amountIn: "2500000000",
  amountOut: "2499870000",
  depositAddress: "0x9d4c1e7a2b5f8036c1d4e7a9b2c5f8e1d4a7b0c3",
  deadline: "2026-11-06T08:30:00.000Z",
  status: "awaiting_deposit",
  createdAt: "2026-11-06T06:30:00.000Z",
};

describe("starting a fund-in from another chain", () => {
  it("asks for the chain, the amount in base units and the refund address", () => {
    // #when
    const draft = fundInDraft("arbitrum", "2500.5", ` ${BASE_ADDRESS} `);

    // #then
    expect(draft).toEqual({
      ok: true,
      request: {
        chain: "arbitrum",
        amount: "2500500000",
        refundAddress: BASE_ADDRESS,
      },
    });
  });

  it("refuses a refund address that isn't on the chosen chain", () => {
    // #when
    const drafts = [
      fundInDraft("solana", "100", BASE_ADDRESS),
      fundInDraft("base", "100", SOLANA_ADDRESS),
      fundInDraft("solana", "100", SOLANA_ADDRESS),
      fundInDraft("ethereum", "100", ""),
    ];

    // #then
    expect(drafts.map((draft) => (draft.ok ? "ok" : draft.errors))).toEqual([
      {
        refundAddress:
          "That isn't a Solana address. Check it for typos, or paste it again.",
      },
      {
        refundAddress:
          "That isn't an address on that chain. Enter 0x followed by 40 characters.",
      },
      "ok",
      { refundAddress: "Enter the address a refund should go to." },
    ]);
  });

  it("refuses an amount that isn't a positive USDC amount", () => {
    // #when
    const drafts = [
      fundInDraft("base", "", BASE_ADDRESS),
      fundInDraft("base", "0", BASE_ADDRESS),
      fundInDraft("base", "1.0000001", BASE_ADDRESS),
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
        fundInPollInterval({ ...fundIn, status }),
      ]),
    ).toEqual([
      ["awaiting_deposit", false, 5000],
      ["processing", false, 5000],
      ["completed", true, false],
      ["refunded", true, false],
      ["failed", true, false],
      ["expired", true, false],
    ]);
  });

  it("asks again while the fund-in hasn't loaded", () => {
    // #then
    expect(fundInPollInterval(undefined)).toBe(5000);
  });

  it("words every status", () => {
    // #then
    expect(
      FUND_IN_STATUSES.map((status) => [
        FUND_IN_STATUS[status].label,
        FUND_IN_STATUS[status].tone,
      ]),
    ).toEqual([
      ["Waiting for your USDC", "neutral"],
      ["On its way", "neutral"],
      ["In the wallet", "success"],
      ["Refunded", "warning"],
      ["Failed", "warning"],
      ["Expired", "warning"],
    ]);
  });
});
