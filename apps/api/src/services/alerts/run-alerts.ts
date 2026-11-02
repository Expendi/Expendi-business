import { Cause, Effect, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { DatabaseError } from "../../errors.js";
import type { EmailSender } from "../email/email-sender.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { CheckResult } from "./ops-alerts.js";
import {
  lowBalanceCheck,
  payoutChecks,
  reconciliationCheck,
  webhookCheck,
  zohoCheck,
} from "./alert-checks.js";
import { applyCheck, notifyOpenAlerts } from "./ops-alerts.js";

export interface AlertsRun {
  readonly opened: number;
  readonly resolved: number;
  /** Emailed, or logged when there's no alert list. */
  readonly notified: number;
  readonly emailFailures: number;
  /** Checks that couldn't run; their open alerts were left as they were. */
  readonly failedChecks: number;
}

type Check = Effect.Effect<
  readonly CheckResult[],
  DatabaseError,
  DatabaseService | Paycrest
>;

const CHECKS: Readonly<Record<string, Check>> = {
  payouts: payoutChecks(),
  webhooks: Effect.map(webhookCheck(), (result) => [result]),
  reconciliation: Effect.map(reconciliationCheck(), (result) => [result]),
  "low balance": Effect.suspend(() =>
    Effect.map(lowBalanceCheck(), (result) => [result]),
  ),
  zoho: Effect.map(zohoCheck(), (result) => [result]),
};

/**
 * One pass of the alerts job (spec §6.16): every check, each on its own so
 * one failing leaves the others' alerts untouched, then the emails for
 * whatever opened.
 */
export function runAlerts(): Effect.Effect<
  AlertsRun,
  DatabaseError,
  DatabaseService | Paycrest | EmailSender
> {
  return Effect.gen(function* () {
    let opened = 0;
    let resolved = 0;
    let failedChecks = 0;
    for (const [name, check] of Object.entries(CHECKS)) {
      const exit = yield* Effect.exit(
        Effect.flatMap(check, (results) => Effect.forEach(results, applyCheck)),
      );
      if (Exit.isFailure(exit)) {
        failedChecks += 1;
        console.error(
          `[alerts] ${name} check failed`,
          Cause.pretty(exit.cause),
        );
        continue;
      }
      for (const applied of exit.value) {
        opened += applied.opened;
        resolved += applied.resolved;
      }
    }
    const { notified, failed } = yield* notifyOpenAlerts();
    return {
      opened,
      resolved,
      notified,
      emailFailures: failed,
      failedChecks,
    };
  });
}
