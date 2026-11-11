import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { watchNearDeposits } from "../services/wallet/near-deposits.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 30 seconds, credit the USDC that arrived at company wallets on NEAR
 * (docs/decisions/near-main-chain.md). It reads the indexer, the RPC and
 * 1Click, writes ledger credits and alerts staff to a wallet that has waited
 * too long at a transfer; it never sends money.
 */
export const nearDepositsJob: StationJob = {
  name: "near-deposits",
  everyMs: 30_000,
  lockKey: 72_050,
  run: watchNearDeposits().pipe(
    Effect.map((run) =>
      Object.values(run).every((count) => count === 0) ? IDLE : run,
    ),
  ),
};
