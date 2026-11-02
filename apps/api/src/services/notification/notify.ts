import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { ClaimNotificationEvent } from "./claim-notifications.js";
import type { NotificationChannel, OutgoingNotification } from "./outgoing.js";
import type { SpendingNotificationEvent } from "./spending-notifications.js";
import { notificationOutbox } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { claimNotifications } from "./claim-notifications.js";
import {
  billReminderNotifications,
  floatPaidNotifications,
  payrollReadyNotifications,
  salaryPaidNotifications,
  walletShortNotifications,
} from "./spending-notifications.js";

/**
 * Everything that notifies someone (spec §6.10). A new event adds itself to
 * this union and a case to `compose`; the compiler then refuses a kind
 * that sends nothing.
 */
export type NotificationEvent =
  ClaimNotificationEvent | SpendingNotificationEvent;

function compose(
  tx: Transaction,
  event: NotificationEvent,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  switch (event.kind) {
    case "claim_submitted":
    case "claim_rejected":
    case "claim_paid":
    case "claim_payout_failed":
      return claimNotifications(tx, event);
    case "bill_due_soon":
    case "bill_due_today":
    case "bill_overdue":
      return billReminderNotifications(tx, event);
    case "payroll_ready":
      return payrollReadyNotifications(tx, event);
    case "wallet_short":
      return Effect.succeed(walletShortNotifications(event));
    case "salary_paid":
      return salaryPaidNotifications(tx, event);
    case "float_issued":
    case "float_topped_up":
      return floatPaidNotifications(tx, event);
  }
}

const channelsOf = (
  notification: OutgoingNotification,
): readonly NotificationChannel[] =>
  notification.alsoByEmail ? ["push", "email"] : ["push"];

/**
 * Queues `event`'s notifications inside `tx`, the transaction making the
 * change, so they go out only if it commits, and never hold up the request:
 * the push-notifications station job sends them afterwards. A message with
 * a `dedupeKey` already queued is skipped, by the outbox's unique index.
 */
export function notify(
  tx: Transaction,
  event: NotificationEvent,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const notifications = yield* compose(tx, event);
    if (notifications.length === 0) return;
    yield* query(() =>
      tx
        .insert(notificationOutbox)
        .values(
          notifications.flatMap((notification) =>
            channelsOf(notification).map((channel) => ({
              organizationId: event.organizationId,
              kind: event.kind,
              channel,
              dedupeKey: notification.dedupeKey ?? null,
              audience: notification.audience.to,
              recipientMembershipId:
                notification.audience.to === "member"
                  ? notification.audience.membershipId
                  : null,
              exceptMembershipId:
                notification.audience.to === "admins"
                  ? notification.audience.exceptMembershipId
                  : null,
              title: notification.title,
              body: notification.body,
              data: notification.data,
            })),
          ),
        )
        .onConflictDoNothing({
          target: [
            notificationOutbox.organizationId,
            notificationOutbox.dedupeKey,
            notificationOutbox.channel,
          ],
        }),
    );
  });
}
