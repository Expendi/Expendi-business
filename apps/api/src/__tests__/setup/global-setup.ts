import pg from "pg";

import { runMigrations } from "../../db/migrate.js";
import { TEST_DATABASE_URL_MIGRATE } from "./test-database.js";

/** Rebuilds the test schema from the migrations, so every run starts empty. */
export default async function setup(): Promise<void> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL_MIGRATE });
  try {
    await client.connect();
  } catch (error) {
    throw new Error(
      `Cannot reach the test database at ${TEST_DATABASE_URL_MIGRATE}. Run \`pnpm --filter @expendi-business/api db:setup-local\` once, or set TEST_DATABASE_URL and TEST_DATABASE_URL_MIGRATE.`,
      { cause: error },
    );
  }
  try {
    await client.query(`
      DROP SCHEMA IF EXISTS drizzle CASCADE;
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
    `);
  } finally {
    await client.end();
  }
  await runMigrations(TEST_DATABASE_URL_MIGRATE);
}
