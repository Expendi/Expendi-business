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

import { PAYROLL_RUN_STATUSES } from "@expendi-business/shared";

import { timestamps } from "./columns.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const payrollRunStatus = pgEnum(
  "payroll_run_status",
  PAYROLL_RUN_STATUSES,
);

/**
 * A payroll run (spec §6.21): everyone paid on one pay date, one bill each.
 * Drafted 5 Nairobi days before the pay date (`station/payroll-drafts.ts`),
 * at most once per company and pay date. Salaries are private: only admins
 * can see runs (spec §4), down to row-level security.
 *
 * - `salaries_kes` is the net pay of the salaries drafted into the run, and
 *   `cap_kes` that plus the company's margin (spec §7.4), fixed when they
 *   were drafted. The payout engine refuses anything over the cap.
 * - `total_kes` is what the run pays: its bills, less anyone left out, with
 *   the admin's adjustments and one-off payments.
 * - Runs written by hand before drafting existed have `salaries_kes` 0.
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
    /** The net pay of the salaries drafted into the run, KES cents. */
    salariesKes: bigint("salaries_kes", { mode: "bigint" })
      .notNull()
      .default(sql`0`),
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
    // One run per pay date: what makes drafting idempotent.
    unique("payroll_runs_organization_pay_date_unique").on(
      table.organizationId,
      table.payDate,
    ),
    check(
      "payroll_runs_amounts",
      sql`${table.totalKes} >= 0 AND ${table.capKes} > 0`,
    ),
    check(
      "payroll_runs_cap_covers_salaries",
      sql`${table.salariesKes} >= 0 AND ${table.capKes} >= ${table.salariesKes}`,
    ),
  ],
);

export type PayrollRun = typeof payrollRuns.$inferSelect;
