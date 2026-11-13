import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { coverFees } from "../services/intents/fee-cover.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, top up Expendi's float in the confidential account of
 * each company whose float has fallen low, and move on the top-ups already
 * open. The float pays what a Base hop or a USDC payout out of that account
 * costs beyond what it delivers.
 */
export const feeCoversJob: StationJob = {
  name: "fee-covers",
  everyMs: 30_000,
  lockKey: 72_056,
  run: coverFees().pipe(
    Effect.map((summary) =>
      summary.advanced + summary.started + summary.errors === 0
        ? IDLE
        : summary,
    ),
  ),
};
