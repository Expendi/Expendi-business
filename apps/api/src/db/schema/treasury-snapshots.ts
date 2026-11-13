import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  date,
  integer,
  pgTable,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

import { organizations } from "./organizations.js";

/**
 * What a company's Treasury position was worth on a Nairobi day
 * (docs/work/treasury/spec.md, "Ledger and data"): one row per company per
 * day, written by the `treasury-snapshots` job from Privy's live position.
 * The export's monthly figures come from these, and `GET …/treasury` falls
 * back to the latest when Privy can't be reached.
 *
 * Never changed or deleted: a day's figure is the record of what Privy said.
 */
export const treasurySnapshots = pgTable(
  "treasury_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** The Africa/Nairobi calendar day the position was read on. */
    snapshotDate: date("snapshot_date", { mode: "string" }).notNull(),
    /** USDC base units the position was worth, yield included. */
    assetsInVault: bigint("assets_in_vault", { mode: "bigint" }).notNull(),
    sharesInVault: bigint("shares_in_vault", { mode: "bigint" }).notNull(),
    /** The vault's rate after Expendi's share, in basis points; null if Privy gave none. */
    userApy: integer("user_apy"),
    /** When Privy was asked: at or after 00:00 Nairobi time of `snapshot_date`. */
    readAt: timestamp("read_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    unique("treasury_snapshots_organization_day_unique").on(
      table.organizationId,
      table.snapshotDate,
    ),
    check(
      "treasury_snapshots_amounts_not_negative",
      sql`${table.assetsInVault} >= 0 AND ${table.sharesInVault} >= 0`,
    ),
    check(
      "treasury_snapshots_apy_not_negative",
      sql`${table.userApy} IS NULL OR ${table.userApy} >= 0`,
    ),
  ],
);

export type TreasurySnapshot = typeof treasurySnapshots.$inferSelect;
export type NewTreasurySnapshot = typeof treasurySnapshots.$inferInsert;
