import { randomUUID } from "node:crypto";
import { Effect, Layer } from "effect";

import type { LithicSimulatorShape } from "../../services/card-simulations/lithic-simulator.js";
import { LithicSimulator } from "../../services/card-simulations/lithic-simulator.js";
import { LithicError } from "../../services/lithic/lithic-client.js";

export type FakeAuthorization = Parameters<
  LithicSimulatorShape["authorize"]
>[0] & { readonly transactionToken: string };

/**
 * In-memory pretend merchant. Every purchase is approved unless
 * `decide` says otherwise; nothing reaches the purchase check.
 *
 * `failAuthorize: "ambiguous"` makes the purchase and then loses the
 * answer, the worst case of Lithic failing mid-call; `"refused"` makes
 * nothing. `authorizeGate`, when set, holds each authorization until it
 * resolves, so a test can line requests up.
 */
export function makeFakeLithicSimulator() {
  const authorizations: FakeAuthorization[] = [];
  const clearings: string[] = [];
  let sequence = 0;
  const state = {
    authorizations,
    clearings,
    configured: true,
    decide: (_input: FakeAuthorization): "approved" | "declined" => "approved",
    failAuthorize: null as "ambiguous" | "refused" | null,
    failReadBack: false,
    failClear: false,
    authorizeGate: null as (() => Promise<void>) | null,
    reset() {
      authorizations.length = 0;
      clearings.length = 0;
      state.configured = true;
      state.decide = () => "approved";
      state.failAuthorize = null;
      state.failReadBack = false;
      state.failClear = false;
      state.authorizeGate = null;
    },
  };
  const failure = (status: number, code: string, ambiguous = false) =>
    new LithicError({
      message: `fake Lithic sandbox: ${code}`,
      status,
      code,
      ambiguous,
    });

  const shape: LithicSimulatorShape = {
    get configured() {
      return state.configured;
    },
    authorize: (input) =>
      Effect.zipRight(
        Effect.promise(() => state.authorizeGate?.() ?? Promise.resolve()),
        Effect.suspend(() => {
          if (!state.configured) {
            return Effect.fail(failure(503, "NOT_CONFIGURED"));
          }
          if (state.failAuthorize === "refused") {
            return Effect.fail(failure(400, "HTTP_400"));
          }
          sequence += 1;
          const authorization = {
            ...input,
            transactionToken: `simulated-${sequence}-${randomUUID()}`,
          };
          authorizations.push(authorization);
          if (state.failAuthorize === "ambiguous") {
            return Effect.fail(failure(502, "HTTP_502", true));
          }
          return Effect.succeed({
            transactionToken: authorization.transactionToken,
          });
        }),
      ),
    wasApproved: ({ token }) =>
      Effect.suspend(() => {
        const authorization = authorizations.find(
          ({ transactionToken }) => transactionToken === token,
        );
        if (state.failReadBack || !authorization) {
          return Effect.fail(failure(503, "HTTP_503"));
        }
        return Effect.succeed(state.decide(authorization) === "approved");
      }),
    clear: ({ token }) =>
      Effect.suspend(() => {
        if (state.failClear) return Effect.fail(failure(500, "HTTP_500"));
        clearings.push(token);
        return Effect.void;
      }),
  };

  return { layer: Layer.succeed(LithicSimulator, shape), state };
}
