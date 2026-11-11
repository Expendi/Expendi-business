import { Effect, Layer } from "effect";

import type {
  FastNearShape,
  FastNearTransfer,
} from "../../services/chain/fast-near.js";
import type { NearTransactionOutcome } from "../../services/chain/near.js";
import { FastNear, FastNearError } from "../../services/chain/fast-near.js";
import { nearUsdcReceiptTransfersIn } from "../../services/chain/near.js";
import { TEST_USDC_CONTRACT } from "./near.js";

/**
 * The transfers indexer in memory. Each account has a list of rows, oldest
 * first; a resume token is the number of rows already handed out, so a page
 * always comes with one, as the real API's does.
 */
export function makeFakeFastNear() {
  const rows = new Map<string, FastNearTransfer[]>();
  const requests: {
    readonly accountId: string;
    readonly resumeToken: string | null;
  }[] = [];
  let failures = 0;

  const state = {
    /** Every page request, in order. */
    requests,
    /** The next `times` page requests fail. */
    failNext(times = 1) {
      failures = times;
    },
    /** Lists a row exactly as given, true or not. */
    report(accountId: string, row: FastNearTransfer) {
      rows.set(accountId, [...(rows.get(accountId) ?? []), row]);
    },
    /** Lists every USDC transfer to `accountId` that `outcome` really made. */
    index(accountId: string, outcome: NearTransactionOutcome) {
      for (const transfer of nearUsdcReceiptTransfersIn(
        outcome,
        TEST_USDC_CONTRACT,
      )) {
        if (transfer.to !== accountId) continue;
        state.report(accountId, {
          blockHeight: outcome.blockHeight + 1n,
          transactionId: outcome.txHash,
          receiptId: transfer.receiptId,
          logIndex: transfer.receiptLogIndex,
          signerId: outcome.signerId,
          otherAccountId: transfer.from,
          amount: transfer.amount,
        });
      }
    },
  };

  const service: FastNearShape = {
    usdcTransfersTo: ({ accountId, limit, resumeToken }) => {
      requests.push({ accountId, resumeToken });
      if (failures > 0) {
        failures -= 1;
        return Effect.fail(
          new FastNearError({ message: "fake FastNEAR failure" }),
        );
      }
      const start = resumeToken === null ? 0 : Number(resumeToken);
      const transfers = (rows.get(accountId) ?? []).slice(start, start + limit);
      return Effect.succeed({
        transfers,
        resumeToken: String(start + transfers.length),
      });
    },
  };

  return { layer: Layer.succeed(FastNear, service), state };
}
