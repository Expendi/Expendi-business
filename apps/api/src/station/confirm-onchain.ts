import type { StationJob } from "./scheduler.js";
import { confirmOnchainPayouts } from "../services/payout/onchain.js";

/**
 * Every minute, confirm direct USDC payouts from their receipts (spec
 * §6.19). Reads the chain and updates records; never sends.
 */
export const confirmOnchainJob: StationJob = {
  name: "confirm-onchain",
  everyMs: 60_000,
  lockKey: 72_002,
  run: confirmOnchainPayouts(),
};
