import { and, asc, eq } from "drizzle-orm";
import { Effect } from "effect";

import type {
  StaffTreasuryAction,
  StaffTreasuryConfirmed,
  StaffTreasuryPrepared,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { StaffConfirmationPurpose } from "../../db/schema/index.js";
import type { DatabaseError } from "../../errors.js";
import type { MoveRows } from "../treasury/return-eligibility.js";
import type { ConfirmationRefused } from "./confirmations.js";
import type { StaffMember } from "./staff-auth.js";
import {
  intentQuotes,
  treasuryEarnActions,
  treasuryMoves,
  treasuryReturnApprovals,
  wallets,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import {
  assessResume,
  assessStranded,
} from "../treasury/return-eligibility.js";
import {
  issueConfirmation,
  peekConfirmation,
  spendConfirmation,
} from "./confirmations.js";
import { UUID } from "./paging.js";
import { withStaffReadScope } from "./staff-scope.js";

/**
 * The two Treasury actions staff may approve on a move under review, behind
 * the same two-step confirmation as resolving a payout (spec §6.15): prepare
 * checks the move against the rules and returns a token bound to this staff
 * member, this move, this company and this amount; confirm spends the token,
 * records the approval on the move and reopens it, in one transaction.
 *
 * Staff never send. Nothing here takes a quote or touches Privy: the
 * `treasury-moves` job sees the open move with its approval, judges it again
 * as it is then, and sends from the Treasury wallet to the company's own
 * wallet only what is still owed, never more than approved.
 */

const PURPOSES: Readonly<
  Record<StaffTreasuryAction, StaffConfirmationPurpose>
> = {
  return_stranded_deposit: "return_stranded_deposit",
  resume_return: "resume_treasury_return",
};

const DIRECTIONS = {
  return_stranded_deposit: "to_treasury",
  resume_return: "to_wallet",
} as const;

const noSuchMove = new NotFound({ message: "No such move." });
const somethingElse = new BadRequest({
  message: "This confirmation is for something else. Start again.",
});

type ActionError =
  NotFound | Conflict | BadRequest | ConfirmationRefused | DatabaseError;

/** The move's saved rows, read in its company's scope. */
function readRows(
  organizationId: string,
  moveId: string,
): Effect.Effect<MoveRows | null, DatabaseError, DatabaseService> {
  return withStaffReadScope({ organizationId }, (tx) =>
    Effect.gen(function* () {
      const [move] = yield* query(() =>
        tx.select().from(treasuryMoves).where(eq(treasuryMoves.id, moveId)),
      );
      if (!move) return null;
      const quotes = yield* query(() =>
        tx
          .select()
          .from(intentQuotes)
          .where(eq(intentQuotes.treasuryMoveId, moveId))
          .orderBy(asc(intentQuotes.createdAt), asc(intentQuotes.id)),
      );
      const actions = yield* query(() =>
        tx
          .select()
          .from(treasuryEarnActions)
          .where(eq(treasuryEarnActions.treasuryMoveId, moveId))
          .orderBy(
            asc(treasuryEarnActions.createdAt),
            asc(treasuryEarnActions.attempt),
          ),
      );
      return {
        move,
        quotes: quotes.filter((quote) => quote.purpose === "to_treasury"),
        returns: quotes.filter((quote) => quote.purpose === "from_treasury"),
        actions,
      };
    }),
  );
}

/** Checks the move against the action's rules, returning the USDC it would send back. */
function assess(
  action: StaffTreasuryAction,
  organizationId: string,
  moveId: string,
) {
  return Effect.gen(function* () {
    if (!UUID.test(organizationId) || !UUID.test(moveId)) {
      return yield* Effect.fail(noSuchMove);
    }
    const rows = yield* readRows(organizationId, moveId);
    if (rows === null) return yield* Effect.fail(noSuchMove);
    if (rows.move.direction !== DIRECTIONS[action]) {
      return yield* Effect.fail(
        new BadRequest({
          message:
            action === "return_stranded_deposit"
              ? "Only a move to Treasury can have a stranded deposit."
              : "Only a move to the wallet can resume its return.",
        }),
      );
    }
    const assessed =
      action === "return_stranded_deposit"
        ? assessStranded(rows)
        : assessResume(rows);
    if (!assessed.ok) {
      return yield* Effect.fail(new Conflict({ message: assessed.message }));
    }
    return assessed.amountUsdc;
  });
}

const consequencesOf = (
  action: StaffTreasuryAction,
  amountUsdc: bigint,
): string[] => [
  action === "return_stranded_deposit"
    ? `Approve sending the ${amountUsdc} USDC base units of this move that Privy never deposited from the Treasury wallet back to the company's own wallet.`
    : `Approve sending the ${amountUsdc} USDC base units this move's withdrawal delivered and the return has not yet sent from the Treasury wallet to the company's own wallet.`,
  "Put the move back to open. Nothing is sent by you: the Treasury job checks the move again and sends only what is still owed then, never more than this amount, in parts within the wallet's cap. If the move no longer fits, it goes back to review without sending.",
  "The approval is audited under your name, with your reason.",
];

/** Step one: checks the move and returns a token with what confirming will do. */
export function prepareTreasuryAction(
  staff: StaffMember,
  input: {
    readonly action: StaffTreasuryAction;
    readonly organizationId: string;
    readonly moveId: string;
    readonly reason: string;
  },
): Effect.Effect<
  StaffTreasuryPrepared,
  NotFound | Conflict | BadRequest | DatabaseError,
  DatabaseService
> {
  const { action, organizationId, moveId } = input;
  return Effect.gen(function* () {
    const amountUsdc = yield* assess(action, organizationId, moveId);
    const issued = yield* withScope({}, (tx) =>
      issueConfirmation(tx, staff, {
        purpose: PURPOSES[action],
        target: moveId,
        params: {
          organizationId,
          amountUsdc: amountUsdc.toString(),
          reason: input.reason,
        },
      }),
    );
    return {
      token: issued.token,
      expiresAt: issued.expiresAt.toISOString(),
      action,
      reason: input.reason,
      amountUsdc: amountUsdc.toString(),
      consequences: consequencesOf(action, amountUsdc),
    };
  });
}

/**
 * Step two: approves exactly what was prepared. The token is checked, the
 * move is judged again and must still owe what was prepared, and then, in
 * one transaction, the token is spent, the approval recorded, the move
 * reopened and the approval audited.
 */
export function confirmTreasuryAction(
  staff: StaffMember,
  input: {
    readonly action: StaffTreasuryAction;
    readonly organizationId: string;
    readonly moveId: string;
    readonly token: string;
  },
): Effect.Effect<
  StaffTreasuryConfirmed,
  ActionError,
  DatabaseService | AuditLog
> {
  const { action, organizationId, moveId, token } = input;
  const expected = { purposes: [PURPOSES[action]], target: moveId } as const;
  return Effect.gen(function* () {
    const prepared = yield* withScope({}, (tx) =>
      peekConfirmation(tx, staff, token, expected),
    );
    const { reason } = prepared.params;
    if (prepared.params.organizationId !== organizationId || !reason) {
      return yield* Effect.fail(somethingElse);
    }
    const owed = yield* assess(action, organizationId, moveId);
    if (owed.toString() !== prepared.params.amountUsdc) {
      return yield* Effect.fail(
        new Conflict({
          message:
            "What this move would send back changed since you prepared it. Nothing was approved; start again.",
        }),
      );
    }

    const audit = yield* AuditLog;
    yield* withScope({ organizationId }, (tx) =>
      Effect.gen(function* () {
        const confirmation = yield* spendConfirmation(
          tx,
          staff,
          token,
          expected,
        );
        // The same lock a payout approval and a move take, so the move's
        // state can't change between the check and the reopening.
        const [move] = yield* query(() =>
          tx
            .select({ walletId: treasuryMoves.walletId })
            .from(treasuryMoves)
            .where(eq(treasuryMoves.id, moveId)),
        );
        if (move) {
          yield* query(() =>
            tx
              .select({ id: wallets.id })
              .from(wallets)
              .where(eq(wallets.id, move.walletId))
              .for("update"),
          );
        }
        const [reopened] = yield* query(() =>
          tx
            .update(treasuryMoves)
            .set({ status: "open" })
            .where(
              and(
                eq(treasuryMoves.id, moveId),
                eq(treasuryMoves.status, "needs_review"),
              ),
            )
            .returning({ id: treasuryMoves.id }),
        );
        if (!reopened) {
          return yield* Effect.fail(
            new Conflict({
              message:
                "The move changed while this was being confirmed. Nothing was approved; start again.",
            }),
          );
        }
        yield* query(() =>
          tx.insert(treasuryReturnApprovals).values({
            organizationId,
            treasuryMoveId: moveId,
            kind: action,
            approvedUsdc: owed,
            approvedBy: staff.staffUserId,
            reason,
            confirmationId: confirmation.id,
          }),
        );
        yield* audit.record(tx, {
          actor: { type: "staff", id: staff.staffUserId },
          organizationId,
          action: "treasury_move.return_started",
          entity: { type: "treasury_move", id: moveId },
          before: { status: "needs_review" },
          after: {
            status: "open",
            action,
            approvedUsdc: owed,
            via: "admin-app",
            note: reason,
            confirmationId: confirmation.id,
          },
        });
      }),
    );
    return { moveId, action, amountUsdc: owed.toString() };
  });
}
