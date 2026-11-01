import { describe, expect, it } from "vitest";

import {
  fromMicro,
  kesCentsFor,
  roundUpToWholeShilling,
  toMicro,
  usdcCovering,
} from "../../services/paycrest/amounts.js";

describe("toMicro / fromMicro", () => {
  it.each([
    ["128.68", 128_680_000n],
    ["0.5", 500_000n],
    ["11.656823", 11_656_823n],
    ["0", 0n],
  ])("parses %s exactly", (value, micro) => {
    expect(toMicro(value)).toBe(micro);
  });

  it.each(["-1", "1e3", "1.1234567", "01.5", "", " 1", "NaN"])(
    "rejects %j",
    (value) => {
      expect(() => toMicro(value)).toThrow(/at most 6 places/);
    },
  );

  it("formats without trailing zeros", () => {
    expect([
      fromMicro(11_656_823n),
      fromMicro(500_000n),
      fromMicro(2n * 1_000_000n),
    ]).toEqual(["11.656823", "0.5", "2"]);
  });
});

describe("roundUpToWholeShilling", () => {
  it.each([
    ["KES 1,499.50 pays KES 1,500", 149_950n, 150_000n],
    ["KES 1,500.00 stays KES 1,500", 150_000n, 150_000n],
    ["KES 99.50 pays KES 100", 9_950n, 10_000n],
    ["KES 0.01 pays KES 1", 1n, 100n],
  ])("%s", (_label, cents, rounded) => {
    expect(roundUpToWholeShilling(cents)).toBe(rounded);
  });

  it("rejects a zero amount", () => {
    expect(() => roundUpToWholeShilling(0n)).toThrow(RangeError);
  });
});

describe("usdcCovering", () => {
  it("prices KES 1,500 at 128.68 to the micro-USDC", () => {
    // 1500 / 128.68 = 11.65682312…, rounded up
    expect(usdcCovering(150_000n, "128.68")).toBe(11_656_824n);
  });

  it("never underpays, and is the least USDC that doesn't, across a table of rates", () => {
    // #given
    const rates = [
      "128.68",
      "100",
      "129.999999",
      "127.333333",
      "0.000001",
      "1",
      "3",
      "7.77",
      "160.123456",
    ];
    const amounts = [100n, 9_950n, 150_000n, 1_234_567n, 38_600_000n];
    const failures: string[] = [];

    // #when
    for (const rate of rates) {
      for (const cents of amounts) {
        const usdc = usdcCovering(cents, rate);
        if (kesCentsFor(usdc, rate) < cents) {
          failures.push(`${rate} × ${usdc} underpays ${cents}`);
        }
        // Exact rational check: usdc × rate ≥ KES, and one unit less isn't.
        const scaled = (units: bigint) => units * toMicro(rate) * 100n;
        const needed = cents * 1_000_000n * 1_000_000n;
        if (scaled(usdc) < needed || scaled(usdc - 1n) >= needed) {
          failures.push(`${rate} → ${usdc} is not the minimum for ${cents}`);
        }
      }
    }

    // #then
    expect(failures).toEqual([]);
  });
});

describe("kesCentsFor", () => {
  it("rounds down, so the KES shown is never more than the USDC buys", () => {
    // 12.5 × 128.68 = 1608.50; 0.000001 more is still 1608.50
    expect([
      kesCentsFor(12_500_000n, "128.68"),
      kesCentsFor(12_500_001n, "128.68"),
    ]).toEqual([160_850n, 160_850n]);
  });
});
