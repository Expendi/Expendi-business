import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { DatabaseError, Forbidden } from "../../errors.js";
import type { ApprovalSettings } from "../approval/passkeys.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { Pretium } from "../pretium/pretium-client.js";
import type { PrivyWallets } from "../wallet/privy-wallets.js";
import type { FundDeps } from "./fund.js";
import type { OnchainDeps } from "./onchain.js";
import type { PayoutRejected } from "./payout-errors.js";
import { approvePayouts } from "./approve.js";
import { planBaseHops } from "./base-hop.js";
import { fundPayout } from "./fund.js";

export { requestPayoutApproval } from "./approve.js";
export { preparePayouts } from "./prepare.js";
export { retryPayout } from "./retry.js";
export type {
  KesPayoutRequest,
  PayoutRequest,
  UsdcPayoutRequest,
} from "./prepare.js";

export type PayoutEngineDeps =
  | DatabaseService
  | AuditLog
  | ApprovalSettings
  | Paycrest
  | Pretium
  | PrivyWallets
  | OnchainDeps
  | FundDeps;

export interface FundingResult {
  readonly payoutId: string;
  /** The payout after funding, or null if funding itself broke. */
  readonly payout: Payout | null;
}

/**
 * Approve & pay (spec §6.7): one passkey approval for the batch, then each
 * payout funded on its own, so one failing (even unexpectedly) never stops
 * or affects the others. A payout whose funding broke stays where it
 * stopped, which is never a state that resends money.
 */
export function approveAndPay(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
}): Effect.Effect<
  FundingResult[],
  PayoutRejected | Forbidden | DatabaseError,
  PayoutEngineDeps
> {
  return Effect.gen(function* () {
    const approved = yield* approvePayouts(input);
    // Cash-outs approved together share Base hops (a payroll run hops once
    // for its total), so they are planned as a batch before any is funded.
    const planned = yield* Effect.exit(
      planBaseHops({
        organizationId: input.organizationId,
        payoutIds: approved.map((payout) => payout.id),
      }),
    );
    if (Exit.isFailure(planned)) {
      console.error(
        "[payout] planning the batch's Base hops broke",
        Cause.pretty(planned.cause),
      );
    }
    const results: FundingResult[] = [];
    for (const payout of approved) {
      const exit = yield* Effect.exit(
        fundPayout({
          organizationId: input.organizationId,
          payoutId: payout.id,
        }),
      );
      if (Exit.isFailure(exit)) {
        console.error(
          `[payout] funding payout ${payout.id} broke`,
          Cause.pretty(exit.cause),
        );
      }
      results.push({
        payoutId: payout.id,
        payout: Exit.isSuccess(exit) ? exit.value : null,
      });
    }
    return results;
  });
}
