import { describe, expect, it, vi } from "vitest";

import type { ApprovalChallenge } from "@expendi-business/shared";

import type { PasskeyAssertion } from "./passkeys";
import { ApiError } from "./api";
import {
  approveWithPasskey,
  describeApprovalError,
  isChallengeFresh,
  topUpFrom,
} from "./approval";
import { PasskeyUnavailableError } from "./passkeys";

const challenge: ApprovalChallenge = {
  challengeId: "00000000-0000-4000-8000-000000000001",
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
};

const assertion: PasskeyAssertion = {
  id: "Y3JlZGVudGlhbA",
  rawId: "Y3JlZGVudGlhbA",
  type: "public-key",
  response: {
    clientDataJSON: "e30",
    authenticatorData: "AAAA",
    signature: "c2ln",
  },
  clientExtensionResults: {},
};

describe("approveWithPasskey", () => {
  it("sends the signed challenge back exactly once", async () => {
    // #given
    const request = vi.fn(() => Promise.resolve(challenge));
    const confirm = vi.fn(() => Promise.resolve("paid"));
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    const outcome = await approveWithPasskey(
      { request, confirm },
      ["claim"],
      sign,
    );

    // #then
    expect({
      outcome,
      signed: sign.mock.calls,
      confirmed: confirm.mock.calls,
    }).toEqual({
      outcome: { status: "approved", result: "paid" },
      signed: [[challenge.options]],
      confirmed: [[challenge, assertion]],
    });
  });

  it("sends nothing when the admin backs out of the passkey prompt", async () => {
    // #given
    const confirm = vi.fn(() => Promise.resolve("paid"));

    // #when
    const outcome = await approveWithPasskey(
      { request: () => Promise.resolve(challenge), confirm },
      undefined,
      () => Promise.resolve(null),
    );

    // #then
    expect({ outcome, confirmed: confirm.mock.calls.length }).toEqual({
      outcome: { status: "cancelled" },
      confirmed: 0,
    });
  });

  it("doesn't retry a confirmation that failed", async () => {
    // #given
    const confirm = vi.fn(() =>
      Promise.reject(new ApiError(503, "ServiceUnavailable", "Try later")),
    );

    // #when
    const approving = approveWithPasskey(
      { request: () => Promise.resolve(challenge), confirm },
      undefined,
      () => Promise.resolve(assertion),
    );

    // #then
    await expect(approving).rejects.toThrow("Try later");
    expect(confirm).toHaveBeenCalledTimes(1);
  });
});

describe("isChallengeFresh", () => {
  it("reuses a challenge for 4 of its 5 minutes", () => {
    // #then
    expect([
      isChallengeFresh(0, 4 * 60_000 - 1),
      isChallengeFresh(0, 4 * 60_000),
    ]).toEqual([true, false]);
  });
});

describe("topUpFrom", () => {
  it("reads the top-up from the API's 409", () => {
    // #given
    const error = new ApiError(409, "Conflict", "Short", {
      shortfallUsdc: "1000000",
      topUpKes: "12900",
    });

    // #then
    expect(topUpFrom(error)).toBe(
      "Top up KES 129.00, then approve again. Nothing was sent.",
    );
  });

  it("ignores any other error", () => {
    // #then
    expect(topUpFrom(new ApiError(409, "Conflict", "Already paying"))).toBe(
      null,
    );
  });
});

describe("describeApprovalError", () => {
  it("prefers the passkey's own explanation", () => {
    // #then
    expect(
      describeApprovalError(new PasskeyUnavailableError("Use your phone")),
    ).toBe("Use your phone");
  });
});
