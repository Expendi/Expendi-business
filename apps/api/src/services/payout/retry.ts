import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { Paycrest } from "../paycrest/paycrest-client.js";
import type { PayoutRecipient } from "../paycrest/recipient.js";
import type { PayoutRequest, PrepareError } from "./prepare.js";
import { payouts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { AuditLog } from "../audit/audit-log.js";
import { PayoutRejected } from "./payout-errors.js";
import { preparePayouts } from "./prepare.js";

/**
 * Retry after a failure (spec §6.8): a new payout for the same subject and
 * amount, with a new idempotency key, waiting for a fresh passkey approval
 * like any other. The failed payout stays as it was. Pass `recipient` when
 * the payee's details were corrected; otherwise the original is reused.
 */
export function retryPayout(input: {
  readonly organizationId: string;
  readonly failedPayoutId: string;
  readonly idempotencyKey: string;
  readonly actor: AuditActor;
  readonly recipient?: PayoutRecipient;
}): Effect.Effect<Payout, PrepareError, DatabaseService | AuditLog | Paycrest> {
  const { organizationId } = input;
  return Effect.gen(function* () {
    const [failed] = yield* withScope({ organizationId }, (tx) =>
      query(() =>
        tx
          .select()
          .from(payouts)
          .where(
            and(
              eq(payouts.id, input.failedPayoutId),
              eq(payouts.organizationId, organizationId),
            ),
          ),
      ),
    );
    if (failed?.status !== "failed") {
      return yield* Effect.fail(
        new PayoutRejected({
          reason: "not_awaiting_approval",
          message: "Only a failed payment can be retried.",
        }),
      );
    }
    const base = {
      subjectType: failed.subjectType,
      subjectId: failed.subjectId,
      ...(failed.subjectPart > 1 && { subjectPart: failed.subjectPart }),
      ...(failed.payrollRunId && { payrollRunId: failed.payrollRunId }),
      idempotencyKey: input.idempotencyKey,
    };
    const recipient = input.recipient ?? failed.recipient;
    if ((recipient.method === "usdc") !== (failed.provider === "onchain")) {
      return yield* Effect.fail(
        new PayoutRejected({
          reason: "invalid_recipient",
          message: "A retry is paid the same way as the original payment.",
        }),
      );
    }
    const request: PayoutRequest =
      recipient.method === "usdc"
        ? { ...base, recipient, amountUsdc: failed.quotedUsdc }
        : { ...base, recipient, amountKesCents: failed.requestedKesCents };
    const [retry] = yield* preparePayouts({
      organizationId,
      actor: input.actor,
      requests: [request],
    });
    if (!retry) return yield* Effect.dieMessage("retry prepared nothing");
    yield* withScope({ organizationId }, (tx) =>
      Effect.flatMap(AuditLog, (audit) =>
        audit.record(tx, {
          actor: input.actor,
          organizationId,
          action: "payout.retried",
          entity: { type: "payout", id: failed.id },
          after: { retryPayoutId: retry.id },
        }),
      ),
    );
    return retry;
  });
}
