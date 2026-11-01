import type { Effect } from "effect";
import { and, eq, sql } from "drizzle-orm";

import type { Category } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { DbScope, Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import { categories } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";

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
 * database whatever its locale.
 */
export function listCategories(
  scope: DbScope & { readonly organizationId: string },
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
            eq(categories.archived, false),
          ),
        )
        .orderBy(sql`lower(${categories.name}) COLLATE "C"`, categories.id),
    ),
  );
}
