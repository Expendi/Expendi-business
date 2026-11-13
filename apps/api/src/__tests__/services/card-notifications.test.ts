import { describe, expect, it } from "vitest";

import { merchantShown } from "../../services/notification/card-notifications.js";

describe("merchantShown", () => {
  it("quotes a plain descriptor as it is", () => {
    expect(merchantShown("ANTHROPIC SUBSCRIPTION")).toBe(
      '"ANTHROPIC SUBSCRIPTION"',
    );
  });

  it("keeps letters in any script, and only &'-.*# besides", () => {
    expect(merchantShown('Café "Zürich" <b>@home</b> 50% off!')).toBe(
      '"Café Zürich bhome b 50 off"',
    );
  });

  it.each([
    ["evil.example/x", '"evil. example x"'],
    ["CLAUDE.AI SUBSCRIPTION", '"CLAUDE. AI SUBSCRIPTION"'],
    ["pay at www.evil.co/login", '"pay at www. evil. co login"'],
    ["v2.0 by 1.1.1.1", '"v2. 0 by 1. 1. 1. 1"'],
  ])("never leaves %s something a mail client links", (descriptor, shown) => {
    expect(merchantShown(descriptor)).toBe(shown);
  });

  it("leaves a dot alone where nothing follows it", () => {
    expect(merchantShown("ACME INC. ")).toBe('"ACME INC."');
  });

  it("cuts it at 40 characters", () => {
    expect(merchantShown("A".repeat(60))).toBe(`"${"A".repeat(40)}"`);
  });

  it("names a merchant with nothing printable left", () => {
    expect(merchantShown("<<>>")).toBe('"Unknown merchant"');
  });
});
