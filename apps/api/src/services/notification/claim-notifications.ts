import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { ClaimNotificationType } from "@expendi-business/shared";
import { formatKesAmount } from "@expendi-business/shared";

import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { OutgoingNotification } from "./outgoing.js";
import { expenses, memberships, users } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";

/** A claim was submitted (or resubmitted), rejected, paid, or its payout failed. */
export interface ClaimNotificationEvent {
  readonly kind: ClaimNotificationType;
  readonly organizationId: string;
  readonly claimId: string;
}

const MERCHANT_MAX_LENGTH = 40;

interface ClaimFacts {
  readonly membershipId: string;
  readonly claimantName: string;
  readonly amountKes: bigint;
  readonly merchant: string;
  readonly rejectedReason: string | null;
}

/** "KES 1,500" for whole shillings, "KES 1,500.50" otherwise. */
function kes(cents: bigint): string {
  return formatKesAmount(cents).replace(/\.00$/, "");
}

function shortMerchant(merchant: string): string {
  const trimmed = merchant.trim();
  return trimmed.length <= MERCHANT_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MERCHANT_MAX_LENGTH - 1).trimEnd()}…`;
}

function factsOf(
  tx: Transaction,
  { organizationId, claimId }: ClaimNotificationEvent,
): Effect.Effect<ClaimFacts | null, DatabaseError> {
  return query(() =>
    tx
      .select({
        membershipId: expenses.membershipId,
        claimantName: sql<string>`coalesce(${users.fullName}, ${users.email})`,
        amountKes: expenses.amountKes,
        merchant: expenses.merchant,
        rejectedReason: expenses.rejectedReason,
      })
      .from(expenses)
      .innerJoin(memberships, eq(memberships.id, expenses.membershipId))
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(expenses.id, claimId),
          eq(expenses.organizationId, organizationId),
          eq(expenses.kind, "claim"),
        ),
      )
      .limit(1),
  ).pipe(Effect.map(([facts]) => facts ?? null));
}

/**
 * spec §6.10: admins hear of a new claim; the employee hears it was
 * rejected (with the reason) or paid; both hear a payout failed. A claimant
 * who is also an admin gets only the employee's message.
 */
export function claimNotifications(
  tx: Transaction,
  event: ClaimNotificationEvent,
): Effect.Effect<readonly OutgoingNotification[], DatabaseError> {
  return factsOf(tx, event).pipe(
    Effect.map((claim): readonly OutgoingNotification[] => {
      if (!claim) return [];
      const what = `${kes(claim.amountKes)} at ${shortMerchant(claim.merchant)}`;
      const data = {
        type: event.kind,
        organizationId: event.organizationId,
        claimId: event.claimId,
      };
      const employee = {
        to: "member",
        membershipId: claim.membershipId,
      } as const;
      const otherAdmins = {
        to: "admins",
        exceptMembershipId: claim.membershipId,
      } as const;

      switch (event.kind) {
        case "claim_submitted":
          return [
            {
              audience: otherAdmins,
              title: "New claim to approve",
              body: `${claim.claimantName} claimed ${what}.`,
              data,
            },
          ];
        case "claim_rejected":
          return [
            {
              audience: employee,
              title: "Claim rejected",
              body: `Your claim for ${what} was rejected: ${claim.rejectedReason ?? "no reason given"}`,
              data,
            },
          ];
        case "claim_paid":
          return [
            {
              audience: employee,
              title: "Claim paid",
              body: `Your claim for ${what} was paid.`,
              data,
            },
          ];
        case "claim_payout_failed":
          return [
            {
              audience: employee,
              title: "Claim payment failed",
              body: `Your claim for ${what} couldn't be paid. An admin will look into it.`,
              data,
            },
            {
              audience: otherAdmins,
              title: "Payment failed",
              body: `${claim.claimantName}'s claim for ${what} couldn't be paid. Open it to try again.`,
              data,
            },
          ];
      }
    }),
  );
}
