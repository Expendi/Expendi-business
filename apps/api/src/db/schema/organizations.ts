import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  integer,
  pgTable,
  text,
  uuid,
} from "drizzle-orm/pg-core";

import { timestamps } from "./columns.js";

/** KES 200,000 in cents (spec §7.4). */
export const DEFAULT_DAILY_PAYOUT_CAP_KES_CENTS = 20_000_000n;

/** A payroll run may total the active salaries plus this percentage (spec §7.4). */
export const DEFAULT_PAYROLL_CAP_MARGIN_PCT = 20;

export const organizations = pgTable(
  "organizations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kraPin: text("kra_pin"),
    // drizzle-kit cannot serialise a bigint literal default, so pass it as SQL.
    dailyPayoutCapKes: bigint("daily_payout_cap_kes", { mode: "bigint" })
      .notNull()
      .default(sql.raw(DEFAULT_DAILY_PAYOUT_CAP_KES_CENTS.toString())),
    payrollCapMarginPct: integer("payroll_cap_margin_pct")
      .notNull()
      .default(DEFAULT_PAYROLL_CAP_MARGIN_PCT),
    payoutsPaused: boolean("payouts_paused").notNull().default(false),
    ...timestamps,
  },
  (table) => [
    check(
      "organizations_payroll_cap_margin_pct_range",
      sql`${table.payrollCapMarginPct} BETWEEN 0 AND 100`,
    ),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type NewOrganization = typeof organizations.$inferInsert;
