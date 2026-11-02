import {
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { AUDIT_ACTOR_TYPES } from "@expendi-business/shared";

import { organizations } from "./organizations.js";

export const auditActorType = pgEnum("audit_actor_type", AUDIT_ACTOR_TYPES);

/**
 * Append-only (spec §6.13): the app role may only INSERT, and a trigger
 * rejects UPDATE, DELETE and TRUNCATE for every role. Kept for 5 years.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    actorType: auditActorType("actor_type").notNull(),
    // users.id or staff_users.id, or the component name for system actors.
    actorId: text("actor_id").notNull(),
    // Null for platform-wide actions.
    organizationId: uuid("organization_id").references(() => organizations.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    requestId: text("request_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("audit_log_organization_occurred_at_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    index("audit_log_entity_idx").on(table.entityType, table.entityId),
    // The staff viewer's keyset pages (newest first) and actor search.
    index("audit_log_occurred_at_id_idx").on(table.occurredAt, table.id),
    index("audit_log_actor_idx").on(
      table.actorType,
      table.actorId,
      table.occurredAt,
    ),
  ],
);

export type AuditLogRow = typeof auditLog.$inferSelect;
