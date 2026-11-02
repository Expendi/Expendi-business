import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { PaidFromAccountKind } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { PaidFromAccountRow } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { paidFromAccounts } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";

/**
 * Each company's own list of the accounts it pays from outside Expendi
 * (spec §6.23), which company spending names and the accountant maps to
 * Zoho Paid Through accounts (spec §6.17, T44). Admins only, from the
 * routes. Changes are settings changes, so each is audited.
 */

/** `PaidFromAccount` before serialisation turns dates into strings. */
export interface PaidFromAccountView {
  readonly id: string;
  readonly name: string;
  readonly kind: PaidFromAccountKind;
  readonly archived: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const accountNotFound = new NotFound({
  message: "That account wasn't found.",
});
const archivedAccount = new Conflict({ message: "This account is archived." });
const unknownAccount = new BadRequest({
  message: "Pick one of the company's paid-from accounts.",
});

const ACTIVE_NAME_UNIQUE = "paid_from_accounts_active_name_unique";

const accountColumns = {
  id: paidFromAccounts.id,
  name: paidFromAccounts.name,
  kind: paidFromAccounts.kind,
  archived: paidFromAccounts.archived,
  createdAt: paidFromAccounts.createdAt,
  updatedAt: paidFromAccounts.updatedAt,
};

/** A name already in use among the company's accounts, ignoring case. */
function nameTaken(
  name: string,
): (error: DatabaseError) => Effect.Effect<never, Conflict | DatabaseError> {
  return (error) =>
    Effect.fail(
      violatedUniqueConstraint(error.cause) === ACTIVE_NAME_UNIQUE
        ? new Conflict({
            message: `There's already an account called ${name}.`,
          })
        : error,
    );
}

const actorOf = (tenant: Tenant) => ({
  type: "user" as const,
  id: tenant.userId,
});

/** Byte order on the lowercased name, like categories. */
export function listPaidFromAccounts(
  tenant: Tenant,
  { archived = false }: { readonly archived?: boolean | undefined },
): Effect.Effect<PaidFromAccountView[], DatabaseError, DatabaseService> {
  return withScope(tenant, (tx) =>
    query(() =>
      tx
        .select(accountColumns)
        .from(paidFromAccounts)
        .where(
          and(
            eq(paidFromAccounts.organizationId, tenant.organizationId),
            eq(paidFromAccounts.archived, archived),
          ),
        )
        .orderBy(
          sql`lower(${paidFromAccounts.name}) COLLATE "C"`,
          paidFromAccounts.id,
        ),
    ),
  );
}

function lockAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
): Effect.Effect<PaidFromAccountRow, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(paidFromAccounts)
      .where(
        and(
          eq(paidFromAccounts.organizationId, organizationId),
          eq(paidFromAccounts.id, accountId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(accountNotFound),
    ),
  );
}

const toView = (row: PaidFromAccountRow): PaidFromAccountView => ({
  id: row.id,
  name: row.name,
  kind: row.kind,
  archived: row.archived,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function createPaidFromAccount(
  tenant: Tenant,
  fields: { readonly name: string; readonly kind: PaidFromAccountKind },
): Effect.Effect<
  PaidFromAccountView,
  Conflict | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [created] = yield* query(() =>
        tx
          .insert(paidFromAccounts)
          .values({ organizationId, name: fields.name, kind: fields.kind })
          .returning(),
      );
      if (!created) {
        return yield* Effect.dieMessage(
          "paid-from account insert wrote no row",
        );
      }
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: "paid_from_account.created",
        entity: { type: "paid_from_account", id: created.id },
        after: { name: created.name, kind: created.kind },
      });
      return toView(created);
    }),
  ).pipe(Effect.catchTag("DatabaseError", nameTaken(fields.name)));
}

/** Renames an account still in use, or corrects its kind. */
export function updatePaidFromAccount(
  tenant: Tenant,
  accountId: string,
  changes: {
    readonly name?: string | undefined;
    readonly kind?: PaidFromAccountKind | undefined;
  },
): Effect.Effect<
  PaidFromAccountView,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  const name = changes.name;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const row = yield* lockAccount(tx, organizationId, accountId);
      if (row.archived) return yield* Effect.fail(archivedAccount);
      const next = { name: name ?? row.name, kind: changes.kind ?? row.kind };
      if (next.name === row.name && next.kind === row.kind) return toView(row);
      const [updated] = yield* query(() =>
        tx
          .update(paidFromAccounts)
          .set(next)
          .where(eq(paidFromAccounts.id, row.id))
          .returning(),
      );
      if (!updated) {
        return yield* Effect.dieMessage(
          "paid-from account update wrote no row",
        );
      }
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: "paid_from_account.updated",
        entity: { type: "paid_from_account", id: row.id },
        before: { name: row.name, kind: row.kind },
        after: next,
      });
      return toView(updated);
    }),
  ).pipe(Effect.catchTag("DatabaseError", nameTaken(name ?? "that")));
}

/**
 * Hides an account from new spending; spending already recorded keeps it.
 * Archiving an archived account changes nothing.
 */
export function archivePaidFromAccount(
  tenant: Tenant,
  accountId: string,
): Effect.Effect<
  PaidFromAccountView,
  NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const row = yield* lockAccount(tx, organizationId, accountId);
      if (row.archived) return toView(row);
      const [updated] = yield* query(() =>
        tx
          .update(paidFromAccounts)
          .set({ archived: true })
          .where(eq(paidFromAccounts.id, row.id))
          .returning(),
      );
      if (!updated) {
        return yield* Effect.dieMessage(
          "paid-from account archive wrote no row",
        );
      }
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: "paid_from_account.archived",
        entity: { type: "paid_from_account", id: row.id },
        before: { archived: false },
        after: { archived: true },
      });
      return toView(updated);
    }),
  );
}

/**
 * The company's account, for spending to name. An archived one can stay on
 * spending that already has it, but can't be picked anew.
 */
export function findPaidFromAccount(
  tx: Transaction,
  organizationId: string,
  accountId: string,
  { allowArchived }: { readonly allowArchived: boolean },
): Effect.Effect<void, BadRequest | DatabaseError> {
  return query(() =>
    tx
      .select({ archived: paidFromAccounts.archived })
      .from(paidFromAccounts)
      .where(
        and(
          eq(paidFromAccounts.organizationId, organizationId),
          eq(paidFromAccounts.id, accountId),
        ),
      )
      .limit(1),
  ).pipe(
    Effect.flatMap(([account]) =>
      account && (allowArchived || !account.archived)
        ? Effect.void
        : Effect.fail(unknownAccount),
    ),
  );
}
