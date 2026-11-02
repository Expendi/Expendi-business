import { Effect } from "effect";

import type { Payout } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditLog } from "../audit/audit-log.js";
import type { PayoutRejected } from "./payout-errors.js";
import { claimPayoutHooks } from "../expenses/claim-payout-hooks.js";

/**
 * What a payout pays follows the payout (spec §6.7 step 6, §6.8): a claim
 * moves to `paying` when its payout is approved, then to `paid` or
 * `payout_failed` with it. The engine calls these in the same transaction
 * as the payout's own change, so the two can never disagree.
 *
 * Each subject type registers its hooks below; the record's type makes a
 * new subject type name its hooks before it compiles. Bills (T37) and
 * floats (T40) replace `NOTHING_FOLLOWS` with their own.
 */
export interface SubjectHooks {
  /**
   * Inside the approval's transaction, holding the wallet and payout locks.
   * Refusing rolls the approval back: nothing is approved or sent.
   */
  readonly approved: (
    tx: Transaction,
    payout: Payout,
  ) => Effect.Effect<void, PayoutRejected | DatabaseError, AuditLog>;
  /**
   * After every later status change of one of its payouts, in that change's
   * transaction. Never refuses: the payout's record is the truth.
   */
  readonly changed: (
    tx: Transaction,
    payout: Payout,
  ) => Effect.Effect<void, DatabaseError, AuditLog>;
}

/** A subject with no record of its own that follows the payout. */
const NOTHING_FOLLOWS: SubjectHooks = {
  approved: () => Effect.void,
  changed: () => Effect.void,
};

const SUBJECTS: Readonly<Record<Payout["subjectType"], SubjectHooks>> = {
  claim: claimPayoutHooks,
  bill: NOTHING_FOLLOWS,
  float: NOTHING_FOLLOWS,
  withdrawal: NOTHING_FOLLOWS,
};

/** Approval's hook, for each payout of the batch just approved. */
export function approveSubjects(
  tx: Transaction,
  approved: readonly Payout[],
): Effect.Effect<void, PayoutRejected | DatabaseError, AuditLog> {
  return Effect.forEach(
    approved,
    (payout) => SUBJECTS[payout.subjectType].approved(tx, payout),
    { discard: true },
  );
}

/**
 * The one hook every later payout status change calls, with the payout as
 * it now is. Status changes live in `fund.ts`, `onchain.ts`, `sync.ts`
 * (webhook and reconcile), `discard.ts` and the staff resolution.
 */
export function applyPayoutOutcome(
  tx: Transaction,
  payout: Payout,
): Effect.Effect<void, DatabaseError, AuditLog> {
  return SUBJECTS[payout.subjectType].changed(tx, payout);
}
