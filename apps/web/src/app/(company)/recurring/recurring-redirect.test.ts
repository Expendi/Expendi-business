import { describe, expect, it } from "vitest";

import { recurringRedirect } from "./recurring-redirect";

describe("the old recurring page", () => {
  it("sends the list and a linked payment to the Bills sheet", () => {
    // #then
    expect([
      recurringRedirect(undefined),
      recurringRedirect(""),
      recurringRedirect(["a", "b"]),
      recurringRedirect("00000000-0000-4000-8000-000000000301"),
    ]).toEqual([
      "/bills?recurring=all",
      "/bills?recurring=all",
      "/bills?recurring=all",
      "/bills?recurring=00000000-0000-4000-8000-000000000301",
    ]);
  });
});
