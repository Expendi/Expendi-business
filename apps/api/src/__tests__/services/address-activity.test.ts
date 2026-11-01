import { describe, expect, it } from "vitest";

import {
  parseAddressActivity,
  verifyAlchemySignature,
} from "../../services/alchemy/address-activity.js";
import { signAlchemyBody, TEST_ALCHEMY_SIGNING_KEY } from "../helpers/fakes.js";

const BODY = JSON.stringify({ type: "ADDRESS_ACTIVITY", id: "whevt_1" });

describe("verifyAlchemySignature", () => {
  it("accepts the HMAC of the exact body", () => {
    expect(
      verifyAlchemySignature(BODY, signAlchemyBody(BODY), [
        TEST_ALCHEMY_SIGNING_KEY,
      ]),
    ).toBe(true);
  });

  it("accepts a signature from any configured key, for rotation", () => {
    expect(
      verifyAlchemySignature(BODY, signAlchemyBody(BODY), [
        "whsec_old",
        TEST_ALCHEMY_SIGNING_KEY,
      ]),
    ).toBe(true);
  });

  it("rejects a body changed after signing", () => {
    expect(
      verifyAlchemySignature(`${BODY} `, signAlchemyBody(BODY), [
        TEST_ALCHEMY_SIGNING_KEY,
      ]),
    ).toBe(false);
  });

  it("rejects a missing signature", () => {
    expect(
      verifyAlchemySignature(BODY, undefined, [TEST_ALCHEMY_SIGNING_KEY]),
    ).toBe(false);
  });

  it("rejects everything when no key is configured", () => {
    expect(verifyAlchemySignature(BODY, signAlchemyBody(BODY), [])).toBe(false);
  });
});

describe("parseAddressActivity", () => {
  it("returns null for other webhook types", () => {
    expect(
      parseAddressActivity({ type: "MINED_TRANSACTION", id: "whevt_1" }),
    ).toBeNull();
  });

  it("drops malformed entries and keeps the rest", () => {
    // #given
    const body = {
      type: "ADDRESS_ACTIVITY",
      id: "whevt_2",
      event: {
        network: "BASE_MAINNET",
        activity: [
          { fromAddress: "not-an-address", toAddress: "0xab", hash: "0x1" },
          {
            category: "token",
            fromAddress: "0xAAAA",
            toAddress: "0xBBBB",
            hash: "0x2",
            rawContract: { address: "0xCCCC" },
            log: { removed: true },
          },
        ],
      },
    };

    // #when
    const event = parseAddressActivity(body);

    // #then
    expect(event).toEqual({
      id: "whevt_2",
      network: "BASE_MAINNET",
      activity: [
        {
          category: "token",
          fromAddress: "0xaaaa",
          toAddress: "0xbbbb",
          hash: "0x2",
          contractAddress: "0xcccc",
          removed: true,
        },
      ],
    });
  });
});
