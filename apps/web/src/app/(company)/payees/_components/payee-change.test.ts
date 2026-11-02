import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  CreatePayeeRequest,
  Payee,
  PayeeChangeChallenge,
} from "@expendi-business/shared";

import type { PasskeyAssertion } from "~/lib/passkeys";
import { listSummary } from "~/features/payees/payee-display";
import { validateDetails } from "~/features/payees/payee-fields";
import {
  payeeChangeSteps,
  requestPayeeChange,
} from "~/features/payees/payees-api";
import { createApiClient } from "~/lib/api";
import { approveWithPasskey } from "~/lib/approval";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const CHALLENGE = "00000000-0000-4000-8000-0000000000cc";
const PAYEE = "00000000-0000-4000-8000-0000000000dd";
const ADDRESS = "0x1111111111111111111111111111111111111111";

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

const options = { challenge: "Y2hhbGxlbmdl", userVerification: "required" };

const payee: Payee = {
  id: PAYEE,
  kind: "supplier",
  name: "Base Supplies",
  membershipId: null,
  details: { method: "usdc", address: ADDRESS },
  payoutPhoneConfirmed: null,
  detailsChangedAt: "2026-11-02T06:00:00.000Z",
  secondConfirmationUntil: "2026-11-03T06:00:00.000Z",
  archived: false,
  createdAt: "2026-11-02T06:00:00.000Z",
  updatedAt: "2026-11-02T06:00:00.000Z",
};

function stubApi(answer: (url: string) => { status: number; data: unknown }) {
  const fetcher = vi.fn((url: string, _init: RequestInit) => {
    const { status, data } = answer(url);
    return Promise.resolve(Response.json({ success: true, data }, { status }));
  });
  vi.stubGlobal("fetch", fetcher);
  const api = createApiClient({
    baseUrl: "https://api.example.com",
    getAccessToken: () => Promise.resolve("token"),
  });
  const requests = () =>
    fetcher.mock.calls.map(([url, init]) => [
      init.method,
      url,
      typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : null,
    ]);
  return { api, requests };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adding a payee from the dashboard", () => {
  it("asks for the challenge, signs it once, and sends back exactly the change the API echoed", async () => {
    // #given the API wants a passkey for a new USDC payee, then saves it
    const create: CreatePayeeRequest = {
      kind: "supplier",
      name: "Base Supplies",
      details: { method: "usdc", address: ADDRESS },
    };
    const challenge: PayeeChangeChallenge = {
      status: "confirmation_required",
      challengeId: CHALLENGE,
      options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
      change: {
        action: "create",
        payee: { ...create, details: { method: "usdc", address: ADDRESS } },
      },
    };
    const { api, requests } = stubApi((url) =>
      url.endsWith("/confirm")
        ? { status: 200, data: payee }
        : { status: 200, data: challenge },
    );
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    const response = await requestPayeeChange(api, ORG, {
      action: "create",
      payee: create,
    });
    const outcome =
      response.status === "confirmation_required"
        ? await approveWithPasskey(payeeChangeSteps(api, ORG), response, sign)
        : null;

    // #then
    expect({
      outcome,
      signed: sign.mock.calls,
      requests: requests(),
    }).toEqual({
      outcome: { status: "approved", result: payee },
      signed: [[options]],
      requests: [
        ["POST", `https://api.example.com/organizations/${ORG}/payees`, create],
        [
          "POST",
          `https://api.example.com/organizations/${ORG}/payees/changes/${CHALLENGE}/confirm`,
          { change: challenge.change, response: assertion },
        ],
      ],
    });
  });

  it("adds a payee paid outside Expendi at once, with no passkey", async () => {
    // #given
    const outside: Payee = {
      ...payee,
      details: { method: "outside" },
      detailsChangedAt: null,
      secondConfirmationUntil: null,
    };
    const { api, requests } = stubApi(() => ({
      status: 200,
      data: { status: "created", payee: outside },
    }));

    // #when
    const response = await requestPayeeChange(api, ORG, {
      action: "create",
      payee: {
        kind: "vendor",
        name: "Base Supplies",
        details: { method: "outside" },
      },
    });

    // #then
    expect({ response, requests: requests().length }).toEqual({
      response: { status: "created", payee: outside },
      requests: 1,
    });
  });
});

describe("changing a payee's payment details", () => {
  it("asks through the payee's details route, then confirms with one signature", async () => {
    // #given
    const details = {
      method: "mpesa_till",
      tillNumber: "123456",
      accountName: "Base Supplies",
    } as const;
    const challenge: PayeeChangeChallenge = {
      status: "confirmation_required",
      challengeId: CHALLENGE,
      options: { challenge: "Y2hhbGxlbmdl", userVerification: "required" },
      change: { action: "change_details", payeeId: PAYEE, details },
    };
    const { api, requests } = stubApi((url) =>
      url.endsWith("/confirm")
        ? { status: 200, data: { ...payee, details } }
        : { status: 200, data: challenge },
    );
    const sign = vi.fn(() => Promise.resolve(assertion));

    // #when
    const response = await requestPayeeChange(api, ORG, {
      action: "change_details",
      payeeId: PAYEE,
      details,
    });
    const outcome =
      response.status === "confirmation_required"
        ? await approveWithPasskey(payeeChangeSteps(api, ORG), response, sign)
        : null;

    // #then
    expect({
      approved: outcome?.status,
      signatures: sign.mock.calls.length,
      requests: requests(),
    }).toEqual({
      approved: "approved",
      signatures: 1,
      requests: [
        [
          "POST",
          `https://api.example.com/organizations/${ORG}/payees/${PAYEE}/details`,
          { details },
        ],
        [
          "POST",
          `https://api.example.com/organizations/${ORG}/payees/changes/${CHALLENGE}/confirm`,
          { change: challenge.change, response: assertion },
        ],
      ],
    });
  });

  it("sends nothing back when the admin backs out of the passkey prompt", async () => {
    // #given
    const { api, requests } = stubApi(() => ({ status: 200, data: payee }));
    const challenge: PayeeChangeChallenge = {
      status: "confirmation_required",
      challengeId: CHALLENGE,
      options: { challenge: "Y2hhbGxlbmdl" },
      change: {
        action: "change_details",
        payeeId: PAYEE,
        details: { method: "outside" },
      },
    };

    // #when
    const outcome = await approveWithPasskey(
      payeeChangeSteps(api, ORG),
      challenge,
      () => Promise.resolve(null),
    );

    // #then
    expect({ outcome, requests: requests().length }).toEqual({
      outcome: { status: "cancelled" },
      requests: 0,
    });
  });
});

describe("validateDetails", () => {
  it("leaves an employee's M-Pesa number out and checks a bank account", () => {
    // #given
    const values = {
      phone: "",
      tillNumber: "",
      paybillNumber: "",
      accountReference: "",
      bankCode: "",
      accountNumber: "12",
      accountName: "Jane Wanjiku",
      address: "",
    };

    // #then
    expect({
      employeeMpesa: validateDetails("mpesa_phone", "employee", values),
      bank: validateDetails("bank", "supplier", values),
    }).toEqual({
      employeeMpesa: {
        ok: true,
        details: { method: "mpesa_phone", accountName: "Jane Wanjiku" },
      },
      bank: {
        ok: false,
        errors: {
          bankCode: "Choose the bank.",
          accountNumber: "A bank account number is 5 to 20 letters and digits.",
        },
      },
    });
  });
});

describe("listSummary", () => {
  it("shows the details as the API returns them", () => {
    // #then
    expect([
      listSummary(
        {
          details: {
            method: "mpesa_paybill",
            paybillNumber: "888880",
            accountReference: "A-17",
            accountName: "KPLC",
          },
          payoutPhoneConfirmed: null,
        },
        null,
      ),
      listSummary(payee, null),
      listSummary({ details: null, payoutPhoneConfirmed: null }, null),
    ]).toEqual([
      "M-Pesa Paybill · 888880, account A-17",
      "USDC wallet · 0x1111…1111",
      "No payment details yet",
    ]);
  });
});
