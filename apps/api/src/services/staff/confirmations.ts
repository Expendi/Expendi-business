import { createHash, randomBytes } from "node:crypto";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import type {
  StaffConfirmation,
  StaffConfirmationPurpose,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { StaffMember } from "./staff-auth.js";
import { staffConfirmations } from "../../db/schema/index.js";
import { query } from "../../db/scope.js";
import { BadRequest, Forbidden, Gone } from "../../errors.js";

/**
 * The second confirmation for resolving a payout or pausing payouts (spec
 * §6.15). Preparing stores what will happen and returns a random token;
 * only its SHA-256 is kept. Confirming with the token applies exactly what
 * was prepared, by the same staff member, once, within 5 minutes. The row
 * is spent in the transaction that applies it, so a failed apply leaves it
 * usable and a successful one can't be repeated.
 */

export const CONFIRMATION_TTL_MS = 5 * 60_000;

export interface ConfirmationIntent {
  readonly purpose: StaffConfirmationPurpose;
  /** The payout's or quote's ID, the company's ID, or `platform`. */
  readonly target: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface IssuedConfirmation {
  readonly token: string;
  readonly expiresAt: Date;
}

const sha256 = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** Binds the intent to the staff member; params are sorted so order can't matter. */
function intentHash(staffUserId: string, intent: ConfirmationIntent): string {
  const params = Object.entries(intent.params).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return sha256(
    JSON.stringify([intent.purpose, intent.target, params, staffUserId]),
  );
}

export function issueConfirmation(
  tx: Transaction,
  staff: StaffMember,
  intent: ConfirmationIntent,
): Effect.Effect<IssuedConfirmation, DatabaseError> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + CONFIRMATION_TTL_MS);
  return query(() =>
    tx.insert(staffConfirmations).values({
      staffUserId: staff.staffUserId,
      purpose: intent.purpose,
      target: intent.target,
      params: { ...intent.params },
      tokenHash: sha256(token),
      intentHash: intentHash(staff.staffUserId, intent),
      expiresAt,
    }),
  ).pipe(Effect.as({ token, expiresAt }));
}

const unknownToken = new BadRequest({
  message: "This confirmation isn't valid. Start again.",
});
const someoneElses = new Forbidden({
  message: "This confirmation was prepared by another staff member.",
});
const somethingElse = new BadRequest({
  message: "This confirmation is for something else. Start again.",
});
const alreadyUsed = new Gone({
  message: "This confirmation was already used.",
});
const expired = new Gone({
  message: "This confirmation expired. Start again.",
});

export type ConfirmationRefused = BadRequest | Forbidden | Gone;

/** What a confirmation must be for: one of these purposes, on this target. */
export interface ConfirmationExpectation {
  readonly purposes: readonly StaffConfirmationPurpose[];
  readonly target?: string;
}

function check(
  row: StaffConfirmation | undefined,
  staff: StaffMember,
  expected: ConfirmationExpectation,
): Effect.Effect<StaffConfirmation, ConfirmationRefused> {
  if (!row) return Effect.fail(unknownToken);
  if (row.staffUserId !== staff.staffUserId) return Effect.fail(someoneElses);
  if (
    !expected.purposes.includes(row.purpose) ||
    (expected.target !== undefined && row.target !== expected.target)
  ) {
    return Effect.fail(somethingElse);
  }
  const prepared: ConfirmationIntent = {
    purpose: row.purpose,
    target: expected.target ?? row.target,
    params: row.params,
  };
  if (intentHash(staff.staffUserId, prepared) !== row.intentHash) {
    return Effect.fail(somethingElse);
  }
  if (row.usedAt) return Effect.fail(alreadyUsed);
  if (row.expiresAt.getTime() <= Date.now()) return Effect.fail(expired);
  return Effect.succeed(row);
}

function find(
  tx: Transaction,
  token: string,
  lock: boolean,
): Effect.Effect<StaffConfirmation | undefined, DatabaseError> {
  const select = tx
    .select()
    .from(staffConfirmations)
    .where(eq(staffConfirmations.tokenHash, sha256(token)));
  return query(() => (lock ? select.for("update") : select)).pipe(
    Effect.map(([row]) => row),
  );
}

/** Checks a token without spending it, before the slow work of applying it. */
export function peekConfirmation(
  tx: Transaction,
  staff: StaffMember,
  token: string,
  expected: ConfirmationExpectation,
): Effect.Effect<StaffConfirmation, ConfirmationRefused | DatabaseError> {
  return find(tx, token, false).pipe(
    Effect.flatMap((row) => check(row, staff, expected)),
  );
}

/**
 * Checks the token again under its row lock and spends it, inside `tx`, the
 * transaction that applies it.
 */
export function spendConfirmation(
  tx: Transaction,
  staff: StaffMember,
  token: string,
  expected: ConfirmationExpectation,
): Effect.Effect<StaffConfirmation, ConfirmationRefused | DatabaseError> {
  return Effect.gen(function* () {
    const row = yield* check(yield* find(tx, token, true), staff, expected);
    const [spent] = yield* query(() =>
      tx
        .update(staffConfirmations)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(staffConfirmations.id, row.id),
            isNull(staffConfirmations.usedAt),
            gt(staffConfirmations.expiresAt, sql`now()`),
          ),
        )
        .returning(),
    );
    return spent ?? (yield* Effect.fail(expired));
  });
}
