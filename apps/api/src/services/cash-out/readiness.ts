import { Effect } from "effect";

import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { CashOutProvider } from "./provider.js";
import { Pretium } from "../pretium/pretium-client.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../pretium/settlement.js";
import { cashOutRate } from "./quote.js";

export interface CashOutReadiness {
  readonly ready: boolean;
  /** Plain sentences for staff, one per problem. */
  readonly problems: readonly string[];
}

const answers = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const readiness = (problems: readonly string[]): CashOutReadiness => ({
  ready: problems.length === 0,
  problems,
});

/** Whether cash-outs can go through `provider` now. Never fails. */
export function cashOutProviderReadiness(
  provider: CashOutProvider,
): Effect.Effect<CashOutReadiness, never, Paycrest | Pretium> {
  switch (provider) {
    case "paycrest":
      return answers(cashOutRate("paycrest")).pipe(
        Effect.map((rateAnswers) =>
          readiness(
            rateAnswers
              ? []
              : ["Paycrest didn't answer a request for its rate."],
          ),
        ),
      );
    case "pretium":
      return pretiumReadiness();
  }
}

function pretiumReadiness(): Effect.Effect<CashOutReadiness, never, Pretium> {
  return Effect.gen(function* () {
    const pretium = yield* Pretium;
    const problems: string[] = [];
    if (!pretium.configured) {
      problems.push("Pretium's API key (PRETIUM_API_KEY) isn't set.");
    }
    if (!pretium.signingKeyConfigured) {
      problems.push(
        "Pretium's webhook signing key (PRETIUM_WEBHOOK_SIGNING_KEY) isn't set, so its callbacks can't be trusted.",
      );
    }
    if (pretium.callbackUrl === null) {
      problems.push(
        "Pretium's callback URL (PRETIUM_CALLBACK_URL) isn't set, so Pretium can't report back when a cash-out finishes.",
      );
    }
    // Without a key every call fails the same way; one sentence says it.
    if (!pretium.configured) return readiness(problems);

    const [rateAnswers, address] = yield* Effect.all(
      [
        answers(pretium.rate()),
        pretium.baseSettlementAddress().pipe(Effect.orElseSucceed(() => null)),
      ],
      { concurrency: "unbounded" },
    );
    if (!rateAnswers) {
      problems.push("Pretium didn't answer a request for its rate.");
    }
    const pinned = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();
    if (address === null) {
      problems.push("Pretium didn't give its Base USDC settlement address.");
    } else if (address.toLowerCase() !== pinned) {
      problems.push(
        `Pretium's Base USDC settlement address is ${address}, not ${pinned} where Expendi sends cash-out USDC. Don't send cash-outs through Pretium until someone checks this.`,
      );
    }
    return readiness(problems);
  });
}
