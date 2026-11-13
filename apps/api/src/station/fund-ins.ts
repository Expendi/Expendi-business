import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { refreshOpenFundIns } from "../services/intents/fund-in.js";
import { creditSettledQuotes } from "../services/intents/quote-credit.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, ask 1Click about each open fund-in and settle the ones
 * that finished, then credit the ledger for every delivery into a
 * confidential account that settled, by this job or another. A delivery to a
 * company wallet is credited by the deposit watcher when the USDC arrives;
 * one into a confidential account shows on no chain, so 1Click's `SUCCESS`
 * is the credit.
 */
export const fundInsJob: StationJob = {
  name: "fund-ins",
  everyMs: 30_000,
  lockKey: 72_051,
  run: Effect.gen(function* () {
    const refreshed = yield* refreshOpenFundIns();
    const credit = yield* creditSettledQuotes();
    const idle =
      refreshed.settled + refreshed.unanswered === 0 &&
      credit.credited + credit.unusable + credit.errors === 0;
    return idle ? IDLE : { ...refreshed, ...credit };
  }),
};
