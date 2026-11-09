import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { closeRequestedCards } from "../services/cards/leavers.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, close at Lithic the cards of people who have left (spec
 * §6.25). A card that fails stays marked and is tried again next time.
 */
export const closeCardsJob: StationJob = {
  name: "close-cards",
  everyMs: 30_000,
  lockKey: 72_044,
  run: closeRequestedCards().pipe(
    Effect.map((run) => (run.attempted === 0 ? IDLE : run)),
  ),
};
