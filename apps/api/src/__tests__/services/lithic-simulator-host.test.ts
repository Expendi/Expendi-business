import { Cause, Effect, Exit, Option, Redacted } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { LithicError } from "../../services/lithic/lithic-client.js";
import { makeLithicSimulator } from "../../services/card-simulations/lithic-simulator.js";

/**
 * Someone points the shared Lithic address at production: the pretend
 * merchant, which fetches card numbers, must refuse before any request.
 */
vi.mock(
  "../../services/lithic/lithic-client.js",
  async (importOriginal: () => Promise<Record<string, unknown>>) => ({
    ...(await importOriginal()),
    LITHIC_SANDBOX_URL: "https://api.lithic.com",
  }),
);

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function failureCode<A>(
  effect: Effect.Effect<A, LithicError>,
): Promise<string> {
  const exit = await Effect.runPromiseExit(effect);
  return Exit.isFailure(exit)
    ? (Option.getOrNull(Cause.failureOption(exit.cause))?.code ?? "died")
    : "succeeded";
}

describe("the sandbox merchant away from Lithic's sandbox", () => {
  it("is off and calls nothing", async () => {
    // #given
    const fetchImpl = vi.fn<typeof fetch>();
    const simulator = makeLithicSimulator(
      { apiKey: Redacted.make("sandbox_test_key") },
      { fetch: fetchImpl, writeGapMs: 0 },
    );

    // #when
    const codes = await Promise.all([
      failureCode(
        simulator.authorize({
          cardToken: "card-token-1",
          amountUsdCents: 2_000n,
          descriptor: "ANTHROPIC",
          merchantAcceptorId: "SBX0123456789AB",
        }),
      ),
      failureCode(simulator.wasApproved({ token: "tx-token-1" })),
      failureCode(simulator.clear({ token: "tx-token-1" })),
    ]);

    // #then
    expect(simulator.configured).toBe(false);
    expect(codes).toEqual(["NOT_SANDBOX", "NOT_SANDBOX", "NOT_SANDBOX"]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
