import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  smallint,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Settings for the whole platform: one row. The Expendi team's pause stops
 * every company's payouts (spec §7.6); the internal admin app sets it (T24).
 */
export const platformSettings = pgTable(
  "platform_settings",
  {
    id: smallint("id").primaryKey().default(1),
    payoutsPaused: boolean("payouts_paused").notNull().default(false),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("platform_settings_single_row", sql`${table.id} = 1`)],
);
