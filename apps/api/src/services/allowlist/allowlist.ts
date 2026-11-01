import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { WithdrawalAddress } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type {
  ApprovalChallenge,
  ApprovalSettings,
} from "../approval/passkeys.js";
import { memberships, withdrawalAddresses } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Forbidden } from "../../errors.js";
import {
  canonicalJson,
  sha256Hex,
  startApproval,
  verifyApproval,
} from "../approval/passkeys.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * The company's address allowlist (spec §6.9, §6.19, §7): USDC payees and
 * withdrawals can only be paid to these addresses. Every change needs a
 * fresh confirmation with an admin's passkey, bound to exactly that change,
 * and is audited.
 */

export type AllowlistChange =
  | {
      readonly action: "add";
      readonly address: string;
      readonly label: string;
    }
  | { readonly action: "remove"; readonly addressId: string };

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const MAX_LABEL_LENGTH = 60;

type AllowlistDeps = DatabaseService | AuditLog | ApprovalSettings;

/** Whether `address` is on the company's allowlist right now. */
export function isAllowlisted(
  tx: Transaction,
  organizationId: string,
  address: string,
): Effect.Effect<boolean, DatabaseError> {
  return query(() =>
    tx
      .select({ id: withdrawalAddresses.id })
      .from(withdrawalAddresses)
      .where(
        and(
          eq(withdrawalAddresses.organizationId, organizationId),
          eq(withdrawalAddresses.address, address.toLowerCase()),
          isNull(withdrawalAddresses.removedAt),
        ),
      )
      .limit(1),
  ).pipe(Effect.map((rows) => rows.length > 0));
}

function requireAdmin(
  tx: Transaction,
  organizationId: string,
  userId: string,
): Effect.Effect<void, Forbidden | DatabaseError> {
  return query(() =>
    tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, organizationId),
          eq(memberships.userId, userId),
          eq(memberships.role, "admin"),
          eq(memberships.status, "active"),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap((rows) =>
      rows.length > 0
        ? Effect.void
        : Effect.fail(
            new Forbidden({
              message: "Only an admin can change the allowlist.",
            }),
          ),
    ),
  );
}

function normaliseChange(
  change: AllowlistChange,
): Effect.Effect<AllowlistChange, BadRequest> {
  if (change.action === "remove") return Effect.succeed(change);
  const label = change.label.trim();
  if (!EVM_ADDRESS.test(change.address)) {
    return Effect.fail(
      new BadRequest({ message: "That isn't a Base address." }),
    );
  }
  if (label.length === 0 || label.length > MAX_LABEL_LENGTH) {
    return Effect.fail(
      new BadRequest({
        message: `Give the address a name of up to ${MAX_LABEL_LENGTH} characters.`,
      }),
    );
  }
  return Effect.succeed({
    action: "add",
    address: change.address.toLowerCase(),
    label,
  });
}

/** What the passkey signs for a change: the company and the exact change. */
export function allowlistIntentHash(
  organizationId: string,
  change: AllowlistChange,
): string {
  return sha256Hex(
    canonicalJson({ version: 1, kind: "allowlist", organizationId, change }),
  );
}

export function listAllowlist(
  organizationId: string,
): Effect.Effect<WithdrawalAddress[], DatabaseError, DatabaseService> {
  return withScope({ organizationId }, (tx) =>
    query(() =>
      tx
        .select()
        .from(withdrawalAddresses)
        .where(
          and(
            eq(withdrawalAddresses.organizationId, organizationId),
            isNull(withdrawalAddresses.removedAt),
          ),
        )
        .orderBy(asc(withdrawalAddresses.createdAt)),
    ),
  );
}

/** A passkey challenge for exactly this change. */
export function requestAllowlistChange(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly change: AllowlistChange;
}): Effect.Effect<
  ApprovalChallenge,
  BadRequest | Forbidden | DatabaseError,
  AllowlistDeps
> {
  const { organizationId, userId } = input;
  return Effect.gen(function* () {
    const change = yield* normaliseChange(input.change);
    yield* withScope({ organizationId, userId }, (tx) =>
      Effect.gen(function* () {
        yield* requireAdmin(tx, organizationId, userId);
        if (change.action === "add") {
          if (yield* isAllowlisted(tx, organizationId, change.address)) {
            return yield* Effect.fail(
              new BadRequest({ message: "That address is already allowed." }),
            );
          }
          return;
        }
        const [listed] = yield* query(() =>
          tx
            .select({ id: withdrawalAddresses.id })
            .from(withdrawalAddresses)
            .where(
              and(
                eq(withdrawalAddresses.id, change.addressId),
                isNull(withdrawalAddresses.removedAt),
              ),
            ),
        );
        if (!listed) {
          return yield* Effect.fail(
            new BadRequest({ message: "That address isn't on the allowlist." }),
          );
        }
      }),
    );
    return yield* startApproval({
      organizationId,
      userId,
      purpose: "change_allowlist",
      intentHash: allowlistIntentHash(organizationId, change),
    });
  });
}

/**
 * Applies `change` once the admin's passkey confirmed exactly this change.
 * The change is sent again with the signature; if it differs from what
 * was challenged, nothing happens.
 */
export function confirmAllowlistChange(input: {
  readonly organizationId: string;
  readonly userId: string;
  readonly challengeId: string;
  readonly response: AuthenticationResponseJSON;
  readonly change: AllowlistChange;
}): Effect.Effect<
  WithdrawalAddress,
  BadRequest | Forbidden | DatabaseError,
  AllowlistDeps
> {
  const { organizationId, userId } = input;
  return Effect.gen(function* () {
    const change = yield* normaliseChange(input.change);
    const approval = yield* verifyApproval({
      organizationId,
      userId,
      purpose: "change_allowlist",
      challengeId: input.challengeId,
      response: input.response,
    });
    if (allowlistIntentHash(organizationId, change) !== approval.intentHash) {
      return yield* Effect.fail(
        new Forbidden({
          message: "That isn't the change you confirmed. Confirm again.",
        }),
      );
    }
    const audit = yield* AuditLog;

    return yield* withScope({ organizationId, userId, role: "admin" }, (tx) =>
      Effect.gen(function* () {
        yield* requireAdmin(tx, organizationId, userId);
        const now = new Date();
        const [row] =
          change.action === "add"
            ? yield* query(() =>
                tx
                  .insert(withdrawalAddresses)
                  .values({
                    organizationId,
                    address: change.address,
                    label: change.label,
                    addedBy: userId,
                    confirmedAt: now,
                  })
                  .onConflictDoNothing()
                  .returning(),
              )
            : yield* query(() =>
                tx
                  .update(withdrawalAddresses)
                  .set({ removedAt: now, removedBy: userId })
                  .where(
                    and(
                      eq(withdrawalAddresses.id, change.addressId),
                      isNull(withdrawalAddresses.removedAt),
                    ),
                  )
                  .returning(),
              );
        if (!row) {
          return yield* Effect.fail(
            new BadRequest({
              message:
                change.action === "add"
                  ? "That address is already allowed."
                  : "That address isn't on the allowlist.",
            }),
          );
        }
        yield* audit.record(tx, {
          actor: { type: "user", id: userId },
          organizationId,
          action:
            change.action === "add"
              ? "withdrawal_address.added"
              : "withdrawal_address.removed",
          entity: { type: "withdrawal_address", id: row.id },
          after: {
            address: row.address,
            label: row.label,
            approvalId: approval.approvalId,
          },
        });
        return row;
      }),
    );
  });
}

/** For tests and ops: how many addresses are allowed. */
export const activeAllowlistCount = (tx: Transaction, organizationId: string) =>
  query(() =>
    tx
      .select({ count: sql<number>`count(*)::int` })
      .from(withdrawalAddresses)
      .where(
        and(
          eq(withdrawalAddresses.organizationId, organizationId),
          isNull(withdrawalAddresses.removedAt),
        ),
      ),
  ).pipe(Effect.map(([row]) => row?.count ?? 0));
