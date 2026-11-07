import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  Claim,
  ClaimApproval,
  ClaimPaymentResult,
} from "@expendi-business/shared";
import { CLAIM_APPROVAL_MAX_CLAIMS } from "@expendi-business/shared";

import type { PasskeyAssertion } from "~/lib/passkeys";
import { createApiClient } from "~/lib/api";
import { approveWithPasskey } from "~/lib/approval";
import { createCustomerApi } from "~/lib/customer-api";
import {
  blockedReason,
  describePaymentResult,
  preparePayment,
  previewRows,
  sameCost,
  toggleSelection,
} from "./payment";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const CHALLENGE = "00000000-0000-4000-8000-0000000000cc";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const approval: ClaimApproval = {
  challengeId: CHALLENGE,
  options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
  claims: [1, 2, 3].map((n) => ({
    claimId: id(n),
    payoutId: id(100 + n),
    claimantName: `Person ${String(n)}`,
    phoneLast4: "5678",
    claimedKes: "150050",
    receivesKes: "150100",
    rate: "128.68",
    usdc: "11664595",
    feeAllowanceUsdc: "116646",
    maxDebitUsdc: "11781241",
  })),
  totals: {
    receivesKes: "450300",
    usdc: "34993785",
    feeAllowanceUsdc: "349938",
    maxDebitUsdc: "35343723",
  },
  wallet: { availableUsdc: "100000000", shortfallUsdc: "0", topUpKes: null },
};

const paid: ClaimPaymentResult = {
  claims: approval.claims.map((preview) => ({
    claimId: preview.claimId,
    status: "paying",
    payout: { id: preview.payoutId, status: "paying", failureReason: null },
  })),
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Approve & pay from the dashboard", () => {
  it("prepares the selected claims together and confirms them with one signature, once", async () => {
    // #given the API answers the batch approval, then its confirmation
    const fetcher = vi.fn((url: string, _init: RequestInit) =>
      Promise.resolve(
        Response.json(
          { success: true, data: url.endsWith("/confirm") ? paid : approval },
          { status: url.endsWith("/confirm") ? 200 : 201 },
        ),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = createCustomerApi(
      createApiClient({
        baseUrl: "https://api.example.com",
        getAccessToken: () => Promise.resolve("token"),
      }),
    );
    const sign = vi.fn(() => Promise.resolve(assertion));
    const claimIds = approval.claims.map((preview) => preview.claimId);

    // #when
    const outcome = await approveWithPasskey(
      {
        request: (ids: readonly string[]) =>
          preparePayment(api, ORG, { kind: "approve", claimIds: ids }),
        confirm: (challenge, signed) =>
          api.confirmClaimApproval(ORG, challenge.challengeId, signed),
      },
      claimIds,
      sign,
    );

    // #then
    expect({
      outcome,
      signatures: sign.mock.calls.length,
      requests: fetcher.mock.calls.map(([url, init]) => [
        init.method,
        url,
        typeof init.body === "string"
          ? (JSON.parse(init.body) as unknown)
          : null,
      ]),
    }).toEqual({
      outcome: { status: "approved", result: paid },
      signatures: 1,
      requests: [
        [
          "POST",
          `https://api.example.com/organizations/${ORG}/claims/approval`,
          { claimIds },
        ],
        [
          "POST",
          `https://api.example.com/organizations/${ORG}/claims/approval/${CHALLENGE}/confirm`,
          { response: assertion },
        ],
      ],
    });
  });

  it("retries a failed claim through its own route", async () => {
    // #given
    const fetcher = vi.fn(() =>
      Promise.resolve(
        Response.json({ success: true, data: approval }, { status: 201 }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = createCustomerApi(
      createApiClient({
        baseUrl: "https://api.example.com",
        getAccessToken: () => Promise.resolve("token"),
      }),
    );

    // #when
    await preparePayment(api, ORG, { kind: "retry", claimId: id(9) });

    // #then
    expect(fetcher).toHaveBeenCalledWith(
      `https://api.example.com/organizations/${ORG}/claims/${id(9)}/retry`,
      expect.objectContaining({ method: "POST" }),
    );
  });
});

describe("toggleSelection", () => {
  it(`selects at most ${String(CLAIM_APPROVAL_MAX_CLAIMS)} claims`, () => {
    // #given
    const full = Array.from({ length: CLAIM_APPROVAL_MAX_CLAIMS }, (_, n) =>
      id(n),
    );

    // #when
    const result = {
      added: toggleSelection([id(1)], id(2)),
      removed: toggleSelection([id(1), id(2)], id(1)),
      overFull: toggleSelection(full, id(99)),
    };

    // #then
    expect(result).toEqual({
      added: [id(1), id(2)],
      removed: [id(2)],
      overFull: full,
    });
  });
});

describe("blockedReason", () => {
  const claim = (
    submittedBy: Partial<Claim["submittedBy"]>,
  ): Pick<Claim, "submittedBy"> => ({
    submittedBy: {
      membershipId: id(1),
      name: "Jane Wanjiku",
      email: "jane@example.com",
      payoutPhoneConfirmed: true,
      ...submittedBy,
    },
  });

  it("lets a claimant with a confirmed number and a name be paid", () => {
    // #then
    expect(blockedReason(claim({}))).toBeNull();
  });

  it("explains a missing payout number or name", () => {
    // #then
    expect([
      blockedReason(claim({ payoutPhoneConfirmed: false })),
      blockedReason(claim({ name: null })),
    ]).toEqual([
      "Can't be paid until they confirm their M-Pesa number in the app.",
      "Can't be paid until they add their name in the app.",
    ]);
  });
});

describe("sameCost", () => {
  it("notices a changed total", () => {
    // #given
    const fresh = {
      ...approval,
      totals: { ...approval.totals, maxDebitUsdc: "35343724" },
    };

    // #then
    expect([sameCost(approval, approval), sameCost(approval, fresh)]).toEqual([
      true,
      false,
    ]);
  });
});

describe("previewRows", () => {
  it("shows the rounding up to a whole shilling", () => {
    // #given
    const [preview] = approval.claims;
    if (!preview) throw new Error("no preview");

    // #then
    expect(previewRows(preview)).toEqual([
      { label: "They receive", value: { kind: "kes", cents: "150100" } },
      {
        label: "Submitted",
        value: {
          kind: "kes",
          cents: "150050",
          note: "rounded up to a whole shilling for M-Pesa",
        },
      },
      {
        label: "Paid to",
        value: { kind: "text", text: "Person 1, M-Pesa ending 5678" },
      },
      { label: "USDC", value: { kind: "usdc", units: "11664595" } },
      {
        label: "Paycrest fee, at most",
        value: { kind: "usdc", units: "116646" },
      },
      {
        label: "Total, at most",
        value: { kind: "usdc", units: "11781241" },
      },
    ]);
  });
});

describe("describePaymentResult", () => {
  it("leads with a payment that needs review", () => {
    // #given
    const result: ClaimPaymentResult = {
      claims: [
        ...paid.claims,
        {
          claimId: id(7),
          status: "paying",
          payout: { id: id(8), status: "needs_review", failureReason: null },
        },
      ],
    };

    // #then
    expect(describePaymentResult(result).outcome).toBe("review");
  });

  it("says payments are on their way while they're paying", () => {
    // #then
    expect(describePaymentResult(paid).outcome).toBe("sent");
  });
});
