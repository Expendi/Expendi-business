import { afterEach, describe, expect, it, vi } from "vitest";

import type { PasskeyRequestOptions } from "@expendi-business/shared";

import { PasskeyUnavailableError, signApprovalChallenge } from "./passkeys";

const browser = vi.hoisted(() => ({ startAuthentication: vi.fn() }));
vi.mock("@simplewebauthn/browser", () => browser);

afterEach(() => {
  browser.startAuthentication.mockReset();
});

const options: PasskeyRequestOptions = {
  challenge: "Y2hhbGxlbmdl",
  rpId: "business.expendi.app",
  timeout: 60_000,
  userVerification: "required",
  allowCredentials: [
    { id: "Y3JlZGVudGlhbA", type: "public-key", transports: ["internal"] },
  ],
};

const assertion = {
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

describe("signApprovalChallenge", () => {
  it("signs the API's options as they are, without the transports that would hide “use a phone or tablet”", async () => {
    // #given
    browser.startAuthentication.mockResolvedValue(assertion);

    // #when
    const signed = await signApprovalChallenge(options);

    // #then
    expect({
      signed,
      calls: browser.startAuthentication.mock.calls,
    }).toEqual({
      signed: assertion,
      calls: [
        [
          {
            optionsJSON: {
              challenge: options.challenge,
              rpId: options.rpId,
              timeout: options.timeout,
              userVerification: "required",
              allowCredentials: [{ id: "Y3JlZGVudGlhbA", type: "public-key" }],
            },
          },
        ],
      ],
    });
  });

  it("is null when the person closes the passkey prompt", async () => {
    // #given simplewebauthn wraps the browser's NotAllowedError
    const closed = new DOMException(
      "The operation either timed out or was not allowed.",
      "NotAllowedError",
    );
    browser.startAuthentication.mockRejectedValue(
      new Error(closed.message, { cause: closed }),
    );

    // #when
    const signed = await signApprovalChallenge(options);

    // #then
    expect(signed).toBeNull();
  });

  it("explains any other failure, pointing at the phone", async () => {
    // #given
    browser.startAuthentication.mockRejectedValue(
      new Error("WebAuthn is not supported in this browser"),
    );

    // #when
    const signing = signApprovalChallenge(options);

    // #then
    await expect(signing).rejects.toThrow(PasskeyUnavailableError);
    await expect(signing).rejects.toThrow(/use a phone or tablet/);
  });
});
