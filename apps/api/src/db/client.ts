import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Context, Effect, Layer, Redacted } from "effect";
import pg from "pg";

import { ConfigService } from "../config.js";
import { DatabaseError, toDatabaseError } from "../errors.js";
import * as schema from "./schema/index.js";

export type Database = NodePgDatabase<typeof schema>;

export class DatabaseService extends Context.Tag("DatabaseService")<
  DatabaseService,
  { readonly db: Database; readonly pool: pg.Pool }
>() {}

interface RoleRow {
  readonly role: string;
  readonly is_superuser: boolean;
  readonly bypasses_rls: boolean;
  readonly owns_tables: boolean;
}

/**
 * Table owners, superusers and BYPASSRLS roles skip row-level security, so
 * the API refuses to start as any of them.
 */
export const assertRestrictedRole = (
  pool: pg.Pool,
): Effect.Effect<void, DatabaseError> =>
  Effect.tryPromise({
    try: () =>
      pool.query<RoleRow>(`
        SELECT
          r.rolname AS role,
          r.rolsuper AS is_superuser,
          r.rolbypassrls AS bypasses_rls,
          EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public'
              AND c.relkind IN ('r', 'p')
              AND pg_has_role(current_user, c.relowner, 'USAGE')
          ) AS owns_tables
        FROM pg_roles r
        WHERE r.rolname = current_user
      `),
    catch: toDatabaseError,
  }).pipe(
    Effect.flatMap(({ rows: [row] }) =>
      row && !row.is_superuser && !row.bypasses_rls && !row.owns_tables
        ? Effect.void
        : Effect.fail(
            new DatabaseError({
              message: `DATABASE_URL must use the non-owner app role; "${row?.role ?? "unknown"}" would bypass row-level security`,
              cause: row,
            }),
          ),
    ),
  );

export const DatabaseLive: Layer.Layer<
  DatabaseService,
  DatabaseError,
  ConfigService
> = Layer.scoped(
  DatabaseService,
  Effect.gen(function* () {
    const config = yield* ConfigService;
    const pool = new pg.Pool({
      connectionString: Redacted.value(config.databaseUrl),
      // Fail fast instead of hanging when the database is saturated or down.
      connectionTimeoutMillis: 10_000,
      // Stop managed Postgres proxies from silently dropping idle connections.
      keepAlive: true,
    });
    // An idle client can error when its backend drops; without a listener
    // Node treats it as unhandled and crashes. The pool evicts the client.
    pool.on("error", (error) => {
      console.error("[db] idle pool client error", error);
    });
    yield* Effect.addFinalizer(() => Effect.promise(() => pool.end()));

    yield* assertRestrictedRole(pool);

    return { db: drizzle(pool, { schema }), pool };
  }),
);
