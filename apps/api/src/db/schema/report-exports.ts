import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

/**
 * A month's accountant export (spec §6.11): the spreadsheet, the CSV files
 * and the receipts zip, kept privately in R2 under
 * `org/<company>/exports/<export id>/`. Its links work until `expires_at`,
 * 30 days on.
 *
 * - An admin generates one for any month, as often as they like.
 * - The monthly job makes one per company and month (`monthly`), for the
 *   accountants in `recipients` when it was made.
 */
export const reportExports = pgTable(
  "report_exports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** `YYYY-MM`, a Nairobi calendar month. */
    month: text("month").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    monthly: boolean("monthly").notNull().default(false),
    /** The admin who generated it; null for the monthly job's. */
    createdBy: uuid("created_by").references(() => users.id),
    /** The accountants' membership IDs the monthly job emails. */
    recipients: uuid("recipients").array().notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Target of report_export_links' composite foreign key.
    unique("report_exports_id_organization_id_unique").on(
      t.id,
      t.organizationId,
    ),
    uniqueIndex("report_exports_monthly_unique")
      .on(t.organizationId, t.month)
      .where(sql`${t.monthly}`),
    index("report_exports_organization_created_idx").on(
      t.organizationId,
      t.createdAt,
    ),
    check(
      "report_exports_month",
      sql`${t.month} ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'`,
    ),
    check(
      "report_exports_creator",
      sql`(${t.createdBy} IS NULL) = ${t.monthly}`,
    ),
    check(
      "report_exports_recipients",
      sql`${t.monthly} OR cardinality(${t.recipients}) = 0`,
    ),
  ],
);

export type ReportExportRow = typeof reportExports.$inferSelect;
export type NewReportExport = typeof reportExports.$inferInsert;

/**
 * A download link to an export, opened without signing in. Its token is
 * random and only its SHA-256 is stored, so the link is shown or emailed
 * once and never again.
 *
 * - An admin's export gets one link, to share.
 * - The monthly export gets one per accountant (`membership_id`), so a
 *   removed accountant's link stops working. `emailed_at` is set once the
 *   email went out, and a rerun never emails them again.
 */
export const reportExportLinks = pgTable(
  "report_export_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    exportId: uuid("export_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    membershipId: uuid("membership_id"),
    emailedAt: timestamp("emailed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    foreignKey({
      name: "report_export_links_export_organization_fk",
      columns: [t.exportId, t.organizationId],
      foreignColumns: [reportExports.id, reportExports.organizationId],
    }),
    foreignKey({
      name: "report_export_links_membership_organization_fk",
      columns: [t.membershipId, t.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    uniqueIndex("report_export_links_token_hash_unique").on(t.tokenHash),
    uniqueIndex("report_export_links_recipient_unique")
      .on(t.exportId, t.membershipId)
      .where(sql`${t.membershipId} IS NOT NULL`),
    check(
      "report_export_links_token_hash",
      sql`${t.tokenHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "report_export_links_emailed",
      sql`${t.emailedAt} IS NULL OR ${t.membershipId} IS NOT NULL`,
    ),
  ],
);

export type ReportExportLinkRow = typeof reportExportLinks.$inferSelect;
