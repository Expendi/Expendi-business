import { and, eq, sql } from "drizzle-orm";
import { Effect } from "effect";

import type { Category, ManagedCategory } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { CategoryRow } from "../../db/schema/index.js";
import type { DbScope, Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import { violatedUniqueConstraint } from "../../db/error.js";
import { categories } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { Conflict, NotFound } from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";

export interface StarterCategory {
  readonly name: string;
  readonly etimsNotRequired: boolean;
}

/** Every new company starts with these (spec §6.1); admins edit them later. */
export const STARTER_CATEGORIES: readonly StarterCategory[] = [
  { name: "Transport", etimsNotRequired: false },
  { name: "Fuel", etimsNotRequired: false },
  { name: "Meals & entertainment", etimsNotRequired: false },
  { name: "Accommodation", etimsNotRequired: false },
  { name: "Air travel", etimsNotRequired: true },
  { name: "Airtime & data", etimsNotRequired: false },
  { name: "Office supplies", etimsNotRequired: false },
  { name: "Repairs & maintenance", etimsNotRequired: false },
  { name: "Utilities", etimsNotRequired: false },
  { name: "Professional fees", etimsNotRequired: false },
  { name: "Bank & M-Pesa charges", etimsNotRequired: true },
  { name: "Marketing", etimsNotRequired: false },
  { name: "Other", etimsNotRequired: false },
];

export function seedStarterCategories(
  tx: Transaction,
  organizationId: string,
): Effect.Effect<Category[], DatabaseError> {
  return query(() =>
    tx
      .insert(categories)
      .values(
        STARTER_CATEGORIES.map((category) => ({ organizationId, ...category })),
      )
      .returning({
        id: categories.id,
        name: categories.name,
        etimsNotRequired: categories.etimsNotRequired,
      }),
  );
}

/**
 * Byte order on the lowercased name, so the list reads the same on every
 * database whatever its locale. The archived ones only when asked.
 */
export function listCategories(
  scope: DbScope & { readonly organizationId: string },
  { archived = false }: { readonly archived?: boolean | undefined } = {},
): Effect.Effect<Category[], DatabaseError, DatabaseService> {
  return withScope(scope, (tx) =>
    query(() =>
      tx
        .select({
          id: categories.id,
          name: categories.name,
          etimsNotRequired: categories.etimsNotRequired,
        })
        .from(categories)
        .where(
          and(
            eq(categories.organizationId, scope.organizationId),
            eq(categories.archived, archived),
          ),
        )
        .orderBy(sql`lower(${categories.name}) COLLATE "C"`, categories.id),
    ),
  );
}

/**
 * Editing the category list (spec §6.1, §6.14): admins only, from the
 * routes. Each change is a settings change, audited in its transaction.
 * Archiving keeps a category on spending that already has it; the checks
 * where spending picks a category refuse an archived one.
 */

const categoryNotFound = new NotFound({
  message: "That category wasn't found.",
});
const archivedCategory = new Conflict({
  message: "This category is archived. Restore it first.",
});

const ACTIVE_NAME_UNIQUE = "categories_active_name_unique";

/** A name already in use among the company's categories, ignoring case. */
function nameTaken(
  name: string,
): (error: DatabaseError) => Effect.Effect<never, Conflict | DatabaseError> {
  return (error) =>
    Effect.fail(
      violatedUniqueConstraint(error.cause) === ACTIVE_NAME_UNIQUE
        ? new Conflict({
            message: `There's already a category called ${name}.`,
          })
        : error,
    );
}

const actorOf = (tenant: Tenant) => ({
  type: "user" as const,
  id: tenant.userId,
});

const toManaged = (row: CategoryRow): ManagedCategory => ({
  id: row.id,
  name: row.name,
  etimsNotRequired: row.etimsNotRequired,
  archived: row.archived,
});

function lockCategory(
  tx: Transaction,
  organizationId: string,
  categoryId: string,
): Effect.Effect<CategoryRow, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(categories)
      .where(
        and(
          eq(categories.organizationId, organizationId),
          eq(categories.id, categoryId),
        ),
      )
      .for("update"),
  ).pipe(
    Effect.flatMap(([row]) =>
      row ? Effect.succeed(row) : Effect.fail(categoryNotFound),
    ),
  );
}

function writeCategory(
  tx: Transaction,
  categoryId: string,
  values: Partial<Pick<CategoryRow, "name" | "etimsNotRequired" | "archived">>,
): Effect.Effect<CategoryRow, DatabaseError> {
  return query(() =>
    tx
      .update(categories)
      .set(values)
      .where(eq(categories.id, categoryId))
      .returning(),
  ).pipe(
    Effect.flatMap(([row]) =>
      row
        ? Effect.succeed(row)
        : Effect.dieMessage("category update wrote no row"),
    ),
  );
}

export function createCategory(
  tenant: Tenant,
  fields: { readonly name: string; readonly etimsNotRequired: boolean },
): Effect.Effect<
  ManagedCategory,
  Conflict | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const [created] = yield* query(() =>
        tx
          .insert(categories)
          .values({
            organizationId,
            name: fields.name,
            etimsNotRequired: fields.etimsNotRequired,
          })
          .returning(),
      );
      if (!created) {
        return yield* Effect.dieMessage("category insert wrote no row");
      }
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: "category.created",
        entity: { type: "category", id: created.id },
        after: {
          name: created.name,
          etimsNotRequired: created.etimsNotRequired,
        },
      });
      return toManaged(created);
    }),
  ).pipe(Effect.catchTag("DatabaseError", nameTaken(fields.name)));
}

/**
 * Renames a category or changes whether it needs an eTIMS invoice. Spending
 * already recorded keeps the eTIMS status it was given.
 */
export function updateCategory(
  tenant: Tenant,
  categoryId: string,
  changes: {
    readonly name?: string | undefined;
    readonly etimsNotRequired?: boolean | undefined;
  },
): Effect.Effect<
  ManagedCategory,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const row = yield* lockCategory(tx, organizationId, categoryId);
      if (row.archived) return yield* Effect.fail(archivedCategory);
      const next = {
        name: changes.name ?? row.name,
        etimsNotRequired: changes.etimsNotRequired ?? row.etimsNotRequired,
      };
      if (
        next.name === row.name &&
        next.etimsNotRequired === row.etimsNotRequired
      ) {
        return toManaged(row);
      }
      const updated = yield* writeCategory(tx, row.id, next).pipe(
        Effect.catchTag("DatabaseError", nameTaken(next.name)),
      );
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: "category.updated",
        entity: { type: "category", id: row.id },
        before: { name: row.name, etimsNotRequired: row.etimsNotRequired },
        after: next,
      });
      return toManaged(updated);
    }),
  );
}

/**
 * Archives a category, or restores an archived one to the pickers. Doing
 * either to a category already in that state changes nothing. Restoring
 * fails if another category has taken the name meanwhile.
 */
export function setCategoryArchived(
  tenant: Tenant,
  categoryId: string,
  archived: boolean,
): Effect.Effect<
  ManagedCategory,
  Conflict | NotFound | DatabaseError,
  DatabaseService | AuditLog
> {
  const { organizationId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const row = yield* lockCategory(tx, organizationId, categoryId);
      if (row.archived === archived) return toManaged(row);
      const updated = yield* writeCategory(tx, row.id, { archived }).pipe(
        Effect.catchTag("DatabaseError", nameTaken(row.name)),
      );
      yield* audit.record(tx, {
        actor: actorOf(tenant),
        organizationId,
        action: archived ? "category.archived" : "category.restored",
        entity: { type: "category", id: row.id },
        before: { name: row.name, archived: row.archived },
        after: { name: row.name, archived },
      });
      return toManaged(updated);
    }),
  );
}
