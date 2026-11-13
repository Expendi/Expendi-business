import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { advanceTreasuryMoves } from "../services/treasury/advance.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 15 seconds, move on every open move to Treasury by one part's
 * worth of steps: its quote, the company wallet's send, 1Click's status and
 * the vault deposit. It sends only what an admin confirmed and a saved row
 * says hasn't been sent, and it finishes a move whose company has since
 * been paused.
 */
export const treasuryMovesJob: StationJob = {
  name: "treasury-moves",
  everyMs: 15_000,
  lockKey: 72_049,
  run: advanceTreasuryMoves().pipe(
    Effect.map((summary) =>
      summary.moves + summary.errors === 0 ? IDLE : summary,
    ),
  ),
};
