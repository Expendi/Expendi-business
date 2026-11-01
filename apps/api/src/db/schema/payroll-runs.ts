import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  pgEnum,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const payrollRunStatus = pgEnum("payroll_run_status", [
  "draft",
  "paying",
  "paid",
  "partly_failed",
]);

/**
 * A payroll run (spec §6.21). Created here so the payout engine can enforce
 * the run's cap from the database (spec §7.4); T38 adds how runs are drafted
 * and how `cap_kes` is computed (active salaries plus the company's margin).
 * Salaries are private: only admins can see runs (spec §4).
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    payDate: date("pay_date").notNull(),
    status: payrollRunStatus("status").notNull().default("draft"),
    totalKes: bigint("total_kes", { mode: "bigint" }).notNull(),
    /** The most the run may pay in total, KES cents. */
    capKes: bigint("cap_kes", { mode: "bigint" }).notNull(),
    approvedBy: uuid("approved_by").references(() => users.id),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    ...timestamps,
  },
  (table) => [
    unique("payroll_runs_id_organization_id_unique").on(
      table.id,
      table.organizationId,
    ),
    check(
      "payroll_runs_amounts",
      sql`${table.totalKes} >= 0 AND ${table.capKes} > 0`,
    ),
  ],
);

export type PayrollRun = typeof payrollRuns.$inferSelect;
