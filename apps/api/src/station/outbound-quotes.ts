import { Effect } from "effect";

import type { StationJob } from "./scheduler.js";
import { sweepTransitWallets } from "../services/intents/sweep.js";
import { advanceOutboundQuotes } from "../services/payout/outbound-quotes.js";
import { IDLE } from "./scheduler.js";

/**
 * Every 15 seconds, move on the NEAR Intents quotes Expendi pays itself
 * (Base hops, USDC payouts to Base and Solana, sweeps) and apply their
 * outcomes to their payouts. A Base hop takes about half a minute, so this
 * is what a cash-out waits for; it sends only what an admin approved and a
 * saved row says hasn't been sent.
 */
export const outboundQuotesJob: StationJob = {
  name: "outbound-quotes",
  everyMs: 15_000,
  lockKey: 72_047,
  run: advanceOutboundQuotes().pipe(
    Effect.map((summary) =>
      summary.quotes + summary.caughtUp + summary.errors === 0 ? IDLE : summary,
    ),
  ),
};

/**
 * Every 5 minutes, return what sits in transit wallets with nothing in
 * flight to their company wallets (docs/decisions/near-main-chain.md).
 */
export const sweepTransitWalletsJob: StationJob = {
  name: "sweep-transit-wallets",
  everyMs: 5 * 60_000,
  lockKey: 72_048,
  run: sweepTransitWallets().pipe(
    Effect.map((summary) =>
      summary.swept + summary.errors === 0 ? IDLE : summary,
    ),
  ),
};
