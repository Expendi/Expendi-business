import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

/**
 * Walk up from `start` to the folder holding `drizzle/meta/_journal.json`.
 * This module sits at `src/db/` under tsx and `dist/db/` after `tsc`.
 */
function findMigrationsFolder(start: string): string | null {
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "drizzle", "meta", "_journal.json");
    if (fs.existsSync(candidate)) return path.join(dir, "drizzle");
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Apply pending migrations as the owner role. Idempotent: applied
 * migrations are tracked in `drizzle.__drizzle_migrations`. A session
 * advisory lock serialises concurrent deploys.
 */
export async function runMigrations(ownerDatabaseUrl: string): Promise<void> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const migrationsFolder = findMigrationsFolder(here);
  if (!migrationsFolder) {
    throw new Error(
      `[migrate] could not locate drizzle/ folder (searched up from ${here})`,
    );
  }

  const pool = new pg.Pool({ connectionString: ownerDatabaseUrl, max: 1 });
  try {
    const client = await pool.connect();
    try {
      await client.query(
        "SELECT pg_advisory_lock(hashtext('expendi-business:drizzle:migrations'))",
      );
      await migrate(drizzle(client), { migrationsFolder });
    } finally {
      // Destroy the session so the lock is released even if migrating failed.
      client.release(true);
    }
  } finally {
    await pool.end();
  }
}
