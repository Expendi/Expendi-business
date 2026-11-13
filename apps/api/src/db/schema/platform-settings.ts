import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

import { CASH_OUT_PROVIDERS } from "@expendi-business/shared";

export const cashOutProvider = pgEnum("cash_out_provider", CASH_OUT_PROVIDERS);

/**
 * Settings for the whole platform: one row. The Expendi team's pause stops
 * every company's payouts (spec §7.6); the internal admin app sets it (T24).
 * The active cash-out provider takes every company's new cash-outs. Only
 * `set_platform_payouts_paused` and `set_active_cash_out_provider` write it.
 */
export const platformSettings = pgTable(
  "platform_settings",
  {
    id: smallint("id").primaryKey().default(1),
    payoutsPaused: boolean("payouts_paused").notNull().default(false),
    activeCashOutProvider: cashOutProvider("active_cash_out_provider")
      .notNull()
      .default("paycrest"),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("platform_settings_single_row", sql`${table.id} = 1`)],
);
