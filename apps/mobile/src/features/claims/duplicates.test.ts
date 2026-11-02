import { describe, expect, it } from "vitest";

import { ApiError } from "../../lib/api";
import { duplicateOfError } from "./duplicates";

const DUPLICATE_OF = {
  expenseId: "0b9f6c1e-3c2a-4d5e-8f70-1a2b3c4d5e6f",
  kind: "claim",
  spentOn: "2026-10-15",
  amountKes: "150050",
  yours: true,
} as const;

describe("duplicateOfError", () => {
  it("reads the earlier claim from a duplicate's 409", () => {
    // #given
    const error = new ApiError(409, "Conflict", "Already on your claim", {
      duplicateOf: DUPLICATE_OF,
    });

    // #when
    const duplicate = duplicateOfError(error);

    // #then
    expect(duplicate).toEqual(DUPLICATE_OF);
  });

  it.each([
    ["a 409 without details", new ApiError(409, "Conflict", "Taken")],
    [
      "another status",
      new ApiError(400, "BadRequest", "Bad", { duplicateOf: DUPLICATE_OF }),
    ],
    ["a network failure", new TypeError("Network request failed")],
  ])("is null for %s", (_case, error) => {
    // #when
    const duplicate = duplicateOfError(error);

    // #then
    expect(duplicate).toBeNull();
  });
});
