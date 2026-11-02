import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { PUSH_PLATFORMS } from "@expendi-business/shared";

import { memberships } from "./memberships.js";
import { organizations } from "./organizations.js";
import { users } from "./users.js";

export const pushPlatform = pgEnum("push_platform", PUSH_PLATFORMS);

/**
 * Expo push tokens, one per app install (spec §6.10), ported from the
 * consumer backend's `user_push_tokens`. A token belongs to whoever signed
 * in on that device last: registering it again moves it to them. Rows are
 * never deleted; signing out, or Expo reporting the app gone, disables one.
 */
export const pushTokens = pgTable(
  "push_tokens",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    /** `ExponentPushToken[…]`. Anyone holding it can message the device, so logs show only its start. */
    token: text("token").notNull(),
    platform: pushPlatform("platform").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    /** The app registers again at every sign-in. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("push_tokens_token_unique").on(table.token),
    index("push_tokens_user_id_idx").on(table.userId),
  ],
);

export type PushToken = typeof pushTokens.$inferSelect;

/**
 * `member`: one person. `admins`: the company's admins at send time, less
 * `except_membership_id` (someone with their own message about the event).
 */
export const notificationAudience = pgEnum("notification_audience", [
  "member",
  "admins",
]);

/** An Expo ticket to check the receipt of, and the token it was for. */
export interface PushTicketRef {
  readonly ticketId: string;
  readonly pushTokenId: string;
}

/**
 * Notifications waiting to go out, written in the same transaction as the
 * event they report so neither exists without the other (spec §6.10). The
 * push-notifications station job sends them after commit; who receives one
 * is decided then, so someone removed in between gets nothing. Rows stay as
 * the record of what was sent.
 */
export const notificationOutbox = pgTable(
  "notification_outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: uuid("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** `NotificationEvent["kind"]`, e.g. `claim_paid`. */
    kind: text("kind").notNull(),
    /** One row per channel: an email row goes to each recipient's address. */
    channel: text("channel")
      .$type<"push" | "email">()
      .notNull()
      .default("push"),
    /**
     * Set for messages sent once ever, e.g. `bill_due_today:<bill id>`: the
     * unique index below is the sent-marker, so a re-run or a second
     * instance queues nothing more. Null for events that may recur, like a
     * claim submitted again after a rejection.
     */
    dedupeKey: text("dedupe_key"),
    /** Users an email row already reached, so a retry skips them. */
    emailRecipientsSent: jsonb("email_recipients_sent")
      .$type<readonly string[]>()
      .notNull()
      .default([]),
    audience: notificationAudience("audience").notNull(),
    recipientMembershipId: uuid("recipient_membership_id"),
    exceptMembershipId: uuid("except_membership_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** What the app opens when the notification is tapped. */
    data: jsonb("data").$type<Readonly<Record<string, string>>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
    /** Why the latest attempt failed; never names a token. */
    lastError: text("last_error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    /** Devices it went to; 0 when no recipient had one. */
    deviceCount: integer("device_count"),
    tickets: jsonb("tickets").$type<readonly PushTicketRef[]>(),
    receiptsCheckedAt: timestamp("receipts_checked_at", {
      withTimezone: true,
    }),
    /** Too old to be worth sending any more. */
    abandonedAt: timestamp("abandoned_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("notification_outbox_event_channel_unique").on(
      table.organizationId,
      table.dedupeKey,
      table.channel,
    ),
    check(
      "notification_outbox_channel_check",
      sql`${table.channel} IN ('push', 'email')`,
    ),
    foreignKey({
      name: "notification_outbox_recipient_organization_fk",
      columns: [table.recipientMembershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    foreignKey({
      name: "notification_outbox_except_organization_fk",
      columns: [table.exceptMembershipId, table.organizationId],
      foreignColumns: [memberships.id, memberships.organizationId],
    }),
    index("notification_outbox_pending_idx")
      .on(table.lastAttemptAt, table.createdAt)
      .where(sql`${table.sentAt} IS NULL AND ${table.abandonedAt} IS NULL`),
    index("notification_outbox_unchecked_idx")
      .on(table.sentAt)
      .where(
        sql`${table.receiptsCheckedAt} IS NULL AND ${table.tickets} IS NOT NULL`,
      ),
    check(
      "notification_outbox_audience_check",
      sql`(${table.audience} = 'member' AND ${table.recipientMembershipId} IS NOT NULL AND ${table.exceptMembershipId} IS NULL) OR (${table.audience} = 'admins' AND ${table.recipientMembershipId} IS NULL)`,
    ),
    check("notification_outbox_attempts_check", sql`${table.attempts} >= 0`),
  ],
);

export type NotificationOutboxRow = typeof notificationOutbox.$inferSelect;
