import { Effect } from "effect";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { ClaimNotificationEvent } from "./claim-notifications.js";
import type { OutgoingNotification } from "./outgoing.js";
import { notificationOutbox } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { claimNotifications } from "./claim-notifications.js";

/**
 * Everything that notifies someone (spec §6.10). Bills, payroll and floats
 * (T43) add their events to this union and a case to `compose`; the
 * compiler then refuses a kind that sends nothing.
 */
export type NotificationEvent = ClaimNotificationEvent;

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
  }
}

/**
 * Queues `event`'s notifications inside `tx`, the transaction making the
 * change, so they go out only if it commits, and never hold up the request:
 * the push-notifications station job sends them afterwards.
 */
export function notify(
  tx: Transaction,
  event: NotificationEvent,
): Effect.Effect<void, DatabaseError> {
  return Effect.gen(function* () {
    const notifications = yield* compose(tx, event);
    if (notifications.length === 0) return;
    yield* query(() =>
      tx.insert(notificationOutbox).values(
        notifications.map(({ audience, title, body, data }) => ({
          organizationId: event.organizationId,
          kind: event.kind,
          audience: audience.to,
          recipientMembershipId:
            audience.to === "member" ? audience.membershipId : null,
          exceptMembershipId:
            audience.to === "admins" ? audience.exceptMembershipId : null,
          title,
          body,
          data,
        })),
      ),
    );
  });
}
