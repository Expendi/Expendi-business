import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";
import { staffUsers } from "./staff-users.js";

/** Completed imports only: previews use read-only transactions and write no rows. */
export const importRuns = pgTable(
  "import_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    staffUserId: uuid("staff_user_id")
      .notNull()
      .references(() => staffUsers.id),
    fileName: text("file_name").notNull(),
    fileHash: text("file_hash").notNull(),
    kind: text("kind").notNull(),
    columnMapping: jsonb("column_mapping").notNull(),
    rowsTotal: integer("rows_total").notNull(),
    rowsImported: integer("rows_imported").notNull(),
    rowsSkipped: integer("rows_skipped").notNull(),
    report: jsonb("report").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    unique("import_runs_id_organization_unique").on(t.id, t.organizationId),
    check(
      "import_runs_counts",
      sql`${t.rowsTotal} = ${t.rowsImported} + ${t.rowsSkipped} AND ${t.rowsImported} >= 0 AND ${t.rowsSkipped} >= 0`,
    ),
  ],
);

/** Company + normalized source row: independent of filename and row order. */
export const importRows = pgTable(
  "import_rows",
  {
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    rowHash: text("row_hash").notNull(),
    runId: uuid("run_id").notNull(),
    entityId: uuid("entity_id").notNull(),
  },
  (t) => [
    unique("import_rows_company_hash_unique").on(t.organizationId, t.rowHash),
    foreignKey({
      columns: [t.runId, t.organizationId],
      foreignColumns: [importRuns.id, importRuns.organizationId],
    }),
  ],
);
