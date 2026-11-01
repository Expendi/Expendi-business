import "../secrets/bootstrap.js";

import { Config, Effect, Redacted } from "effect";

import { runMigrations } from "./migrate.js";

const ownerDatabaseUrl = await Effect.runPromise(
  Config.redacted("DATABASE_URL_MIGRATE"),
);
await runMigrations(Redacted.value(ownerDatabaseUrl));
console.log("[migrate] migrations applied");
