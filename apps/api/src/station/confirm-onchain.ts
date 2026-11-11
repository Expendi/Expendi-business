import type { StationJob } from "./scheduler.js";
import { confirmOnchainPayouts } from "../services/payout/onchain.js";

/**
 * Every minute, follow direct USDC payouts (spec §6.19): send the ones that
 * were waiting for their company wallet's turn, read what became of sends
 * whose outcome was unclear, and confirm the sent ones from the chain. A
 * signed send is never relayed again from here.
 */
export const confirmOnchainJob: StationJob = {
  name: "confirm-onchain",
  everyMs: 60_000,
  lockKey: 72_002,
  run: confirmOnchainPayouts(),
};
