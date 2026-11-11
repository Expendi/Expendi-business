import { describe, expect, it } from "vitest";

import { parseEvidence } from "./evidence";

describe("parseEvidence", () => {
  it("accepts the three evidence modes", () => {
    // #given #when #then
    expect(parseEvidence("receipt")).toBe("receipt");
    expect(parseEvidence("sms")).toBe("sms");
    expect(parseEvidence("etims")).toBe("etims");
  });

  it("takes the first of a repeated param", () => {
    // #given #when #then
    expect(parseEvidence(["sms", "receipt"])).toBe("sms");
  });

  it("opens the plain form for anything else", () => {
    // #given #when #then
    expect(parseEvidence(undefined)).toBeUndefined();
    expect(parseEvidence("camera")).toBeUndefined();
    expect(parseEvidence([])).toBeUndefined();
  });
});
