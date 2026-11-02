import { describe, expect, it } from "vitest";

import {
  normaliseBaseAddress,
  toChecksumAddress,
} from "../../services/chain/address.js";

/** The test vectors from EIP-55 itself. */
const EIP55_VECTORS = [
  "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
  "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
  "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
  "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
];

describe("Base addresses", () => {
  it.each(EIP55_VECTORS)("checksums %s as EIP-55 does", (vector) => {
    // #when
    const checksummed = toChecksumAddress(vector.toLowerCase());

    // #then
    expect(checksummed).toBe(vector);
  });

  it("accepts a checksummed address and lowercases it", () => {
    // #when
    const address = normaliseBaseAddress(` ${EIP55_VECTORS[1] ?? ""} `);

    // #then
    expect(address).toBe("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359");
  });

  it("accepts an address with no checksum to check", () => {
    // #when
    const addresses = [
      normaliseBaseAddress("0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359"),
      normaliseBaseAddress("0xFB6916095CA1DF60BB79CE92CE3EA74C37C5D359"),
    ];

    // #then
    expect(addresses).toEqual([
      "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359",
      "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359",
    ]);
  });

  it("rejects a mixed-case address whose checksum doesn't match", () => {
    // #when the last letter's case is flipped
    const address = normaliseBaseAddress(
      "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5D359",
    );

    // #then
    expect(address).toBeNull();
  });

  it.each([["0x1234"], ["fb6916095ca1df60bb79ce92ce3ea74c37c5d359"], ["0xgg"]])(
    "rejects %j",
    (raw) => {
      // #when
      const address = normaliseBaseAddress(raw);

      // #then
      expect(address).toBeNull();
    },
  );
});
