import { describe, expect, it } from "vitest";

import {
  companyCardMeta,
  floatsMeta,
  memberCounts,
  teamMeta,
  walletMeta,
} from "./company-display";

describe("memberCounts and teamMeta", () => {
  it("counts active people and pending invites apart", () => {
    // #given
    const members = [
      { status: "active" },
      { status: "active" },
      { status: "invited" },
    ];
    // #when
    const counts = memberCounts(members);
    // #then
    expect(counts).toEqual({ active: 2, invited: 1 });
    expect(teamMeta(counts)).toBe("2 members · 1 invite pending");
  });

  it("leaves out invites when none are waiting", () => {
    // #given #when #then
    expect(teamMeta({ active: 1, invited: 0 })).toBe("1 member");
  });
});

describe("companyCardMeta", () => {
  it("adds the member count once it is known", () => {
    // #given #when #then
    expect(companyCardMeta("Admin", 9)).toBe("Admin · 9 members");
    expect(companyCardMeta("Admin", null)).toBe("Admin");
  });
});

describe("floatsMeta", () => {
  it("counts open floats and what staff still hold", () => {
    // #given
    const floats = [
      { status: "open" as const, leftKes: "362000" },
      { status: "open" as const, leftKes: "1000000" },
      { status: "closed" as const, leftKes: "0" },
    ];
    // #when #then
    expect(floatsMeta(floats)).toBe("2 open · 13,620.00 with staff");
  });

  it("says so when no float is open", () => {
    // #given #when #then
    expect(floatsMeta([])).toBe("No open floats");
  });
});

describe("walletMeta", () => {
  const active = {
    status: "active" as const,
    address: "0xabc",
    chain: "base" as const,
    usdcBalance: "3412580000",
  };

  it("shows USDC and the KES equivalent", () => {
    // #given
    const wallet = {
      ...active,
      kesEquivalent: { kesCents: "44022282", rate: "129.0" },
    };
    // #when #then
    expect(walletMeta(wallet)).toBe("3,412.58 USDC · KES 440,222.82");
  });

  it("says the rate is unavailable rather than guessing", () => {
    // #given #when #then
    expect(walletMeta({ ...active, kesEquivalent: null })).toBe(
      "3,412.58 USDC · KES rate unavailable",
    );
  });

  it("reports a wallet still being set up", () => {
    // #given #when #then
    expect(walletMeta({ status: "creating" })).toBe("Setting up");
  });
});
