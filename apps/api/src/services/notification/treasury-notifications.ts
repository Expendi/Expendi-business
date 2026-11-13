import { and, eq } from "drizzle-orm";
import { Effect } from "effect";

import { formatUsdAmount } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import { memberships, treasuryMoves } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/**
 * Treasury moves (docs/work/treasury/spec.md, "Notifications"). The admin who
 * started a move hears by push when it completes; every admin hears by push
 * and email when it ends without completing.
 */
export type TreasuryNotificationEvent =
  | {
      readonly kind: "treasury_move_completed";
      readonly organizationId: string;
      readonly moveId: string;
    }
  | {
      readonly kind: "treasury_move_ended";
      readonly organizationId: string;
      readonly moveId: string;
      readonly outcome:
        "returned" | "partly_filled" | "failed" | "needs_review";
    };

const ENDED_WORDS = {
  returned: {
    title: "Move to Treasury returned",
    body: "A part of the move couldn't be completed and the USDC is back in your company wallet.",
  },
  partly_filled: {
    title: "Move to Treasury only partly done",
    body: "Part of the move reached Treasury; the rest stayed in your company wallet.",
  },
  failed: {
    title: "Move to Treasury failed",
    body: "Nothing moved. Your USDC is still in your company wallet.",
  },
  needs_review: {
    title: "Move to Treasury is under review",
    body: "We're checking where part of the move is. It stays reserved until then.",
  },
} as const;

export function treasuryNotifications(
  tx: Transaction,
  event: TreasuryNotificationEvent,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  const data = {
    type: event.kind,
    organizationId: event.organizationId,
    moveId: event.moveId,
  };
  if (event.kind === "treasury_move_ended") {
    const words = ENDED_WORDS[event.outcome];
    return Effect.succeed([
      {
        audience: { to: "admins", exceptMembershipId: null },
        title: words.title,
        body: words.body,
        data,
        alsoByEmail: true,
        dedupeKey: `${event.kind}:${event.moveId}`,
      },
    ]);
  }
  return query(() =>
    tx
      .select({
        membershipId: memberships.id,
        movedUsdc: treasuryMoves.movedUsdc,
      })
      .from(treasuryMoves)
      .innerJoin(
        memberships,
        and(
          eq(memberships.userId, treasuryMoves.confirmedBy),
          eq(memberships.organizationId, treasuryMoves.organizationId),
          eq(memberships.status, "active"),
        ),
      )
      .where(
        and(
          eq(treasuryMoves.id, event.moveId),
          eq(treasuryMoves.organizationId, event.organizationId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.map(([starter]) =>
      starter
        ? [
            {
              audience: { to: "member", membershipId: starter.membershipId },
              title: "Moved to Treasury",
              body: `${formatUsdAmount(starter.movedUsdc ?? 0n)} is now in Treasury, earning yield.`,
              data,
              dedupeKey: `${event.kind}:${event.moveId}`,
            } as const,
          ]
        : [],
    ),
  );
}
