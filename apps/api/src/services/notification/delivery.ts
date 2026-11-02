import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Cause, Effect, Either, Exit } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type {
  NotificationOutboxRow,
  PushTicketRef,
} from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { PushSendError, PushTicket } from "./push-sender.js";
import {
  memberships,
  notificationOutbox,
  organizations,
  users,
} from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { EmailSender } from "../email/email-sender.js";
import { notificationEmail } from "../email/notification-email.js";
import { PushSender } from "./push-sender.js";

/**
 * Sends the outbox (spec §6.10), after the events' transactions committed.
 * Each notification is sent in its own transaction, in its company's scope,
 * holding its row: a second run skips a row being sent, and finds a sent
 * one marked. A crash before the mark rolls it back, so it is sent on the
 * next run; Expo accepting it just before such a crash is the one way a
 * notification arrives twice, never none. Email rows (`channel`) go to each
 * recipient's address instead, and Resend's idempotency key closes that gap.
 *
 * Recipients are worked out at send time: someone removed from the company
 * since gets nothing.
 */

/** Older than this, a notification is news nobody needs; it's dropped. */
export const NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60_000;

const DEVICE_NOT_REGISTERED = "DeviceNotRegistered";

interface OutboxRef extends Record<string, unknown> {
  readonly notification_id: string;
  readonly organization_id: string;
}

interface MemberToken extends Record<string, unknown> {
  readonly push_token_id: string;
  readonly token: string;
}

type OutboxChanges = Partial<
  Pick<
    NotificationOutboxRow,
    | "sentAt"
    | "abandonedAt"
    | "lastError"
    | "deviceCount"
    | "tickets"
    | "emailRecipientsSent"
  >
>;

export interface SendSummary {
  /** Notifications this run looked at. */
  readonly considered: number;
  readonly sent: number;
  readonly abandoned: number;
  /** Expo, Resend or the database failed; the rest wait for the next run. */
  readonly failed: number;
}

/**
 * `failed`: Expo or the database, so the run stops. `email_failed`: Resend
 * only, so the run goes on without email. `skipped`: an email row left for
 * the next run, after Resend failed in this one.
 */
type SendOutcome =
  "sent" | "abandoned" | "taken" | "failed" | "email_failed" | "skipped";

const idList = (ids: readonly string[]) =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `,
  );

/** Active members the row is for, as users. */
function recipientsOf(
  tx: Transaction,
  row: NotificationOutboxRow,
): Effect.Effect<readonly string[], DatabaseError> {
  const audience =
    row.audience === "member"
      ? row.recipientMembershipId === null
        ? null
        : eq(memberships.id, row.recipientMembershipId)
      : and(
          eq(memberships.role, "admin"),
          row.exceptMembershipId === null
            ? undefined
            : ne(memberships.id, row.exceptMembershipId),
        );
  if (audience === null) return Effect.succeed([]);
  return query(() =>
    tx
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .where(
        and(
          eq(memberships.organizationId, row.organizationId),
          eq(memberships.status, "active"),
          audience,
        ),
      ),
  ).pipe(Effect.map((members) => members.map(({ userId }) => userId)));
}

function tokensOf(
  tx: Transaction,
  userIds: readonly string[],
): Effect.Effect<readonly MemberToken[], DatabaseError> {
  if (userIds.length === 0) return Effect.succeed([]);
  return query(() =>
    tx.execute<MemberToken>(
      sql`SELECT push_token_id, token FROM push_tokens_of_members(ARRAY[${idList(userIds)}]::uuid[])`,
    ),
  ).pipe(Effect.map(({ rows }) => rows));
}

/** Expo says these installs are gone; tokens registered again since `sentAt` stay. */
function disableGoneTokens(
  tx: Transaction,
  pushTokenIds: readonly string[],
  sentAt: Date,
): Effect.Effect<void, DatabaseError> {
  if (pushTokenIds.length === 0) return Effect.void;
  return query(() =>
    tx.execute<{ disabled: number }>(
      sql`SELECT disable_push_tokens(ARRAY[${idList(pushTokenIds)}]::uuid[], ${sentAt.toISOString()}::timestamptz) AS disabled`,
    ),
  ).pipe(
    Effect.flatMap(({ rows: [result] }) =>
      Effect.sync(() => {
        console.log(
          `[push] Expo reports ${pushTokenIds.length} app(s) gone; disabled ${result?.disabled ?? 0} token(s)`,
        );
      }),
    ),
  );
}

/** Pairs each token with its ticket; Expo answers one per message, in order. */
function readTickets(
  tokens: readonly MemberToken[],
  tickets: readonly PushTicket[],
): { readonly refs: PushTicketRef[]; readonly gone: string[] } {
  const refs: PushTicketRef[] = [];
  const gone: string[] = [];
  const refused = new Map<string, number>();
  tokens.forEach((token, index) => {
    const ticket = tickets[index];
    if (ticket?.status === "ok") {
      refs.push({ ticketId: ticket.id, pushTokenId: token.push_token_id });
    } else if (ticket?.error === DEVICE_NOT_REGISTERED) {
      gone.push(token.push_token_id);
    } else {
      const code = ticket?.error ?? "unknown";
      refused.set(code, (refused.get(code) ?? 0) + 1);
    }
  });
  for (const [code, count] of refused) {
    console.warn(`[push] Expo refused ${count} message(s): ${code}`);
  }
  return { refs, gone };
}

interface EmailProgress {
  /** Users the row has reached, this attempt and earlier ones. */
  readonly sentTo: readonly string[];
  /** Why the attempt stopped short; null once everyone was emailed. */
  readonly error: string | null;
}

/**
 * Emails each recipient the row hasn't reached yet, stopping at the first
 * failure (Resend unreachable or not configured): the next attempt resumes
 * from there. Resend's idempotency key covers a crash between its accepting
 * a message and the row recording it.
 */
function sendEmails(
  tx: Transaction,
  row: NotificationOutboxRow,
  userIds: readonly string[],
): Effect.Effect<EmailProgress, DatabaseError, EmailSender> {
  return Effect.gen(function* () {
    const sentTo = [...row.emailRecipientsSent];
    const remaining = userIds.filter((id) => !sentTo.includes(id));
    if (remaining.length === 0) return { sentTo, error: null };
    const recipients = yield* query(() =>
      tx
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(inArray(users.id, remaining)),
    );
    const [company] = yield* query(() =>
      tx
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, row.organizationId)),
    );
    const sender = yield* EmailSender;
    for (const recipient of recipients) {
      const sent = yield* Effect.either(
        sender.send(
          notificationEmail({
            to: recipient.email,
            companyName: company?.name ?? "Your company",
            title: row.title,
            body: row.body,
            idempotencyKey: `notification:${row.id}:${recipient.id}`,
          }),
        ),
      );
      if (Either.isLeft(sent)) {
        console.warn(
          `[email] notification ${row.id} not sent to user ${recipient.id}: ${sent.left.message}`,
        );
        return { sentTo, error: sent.left.message };
      }
      sentTo.push(recipient.id);
    }
    return { sentTo, error: null };
  });
}

function sendOne(
  ref: OutboxRef,
  emailDown: boolean,
): Effect.Effect<
  SendOutcome,
  DatabaseError,
  DatabaseService | PushSender | EmailSender
> {
  return withScope({ organizationId: ref.organization_id }, (tx) =>
    Effect.gen(function* () {
      const [row] = yield* query(() =>
        tx
          .select()
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.id, ref.notification_id),
              isNull(notificationOutbox.sentAt),
              isNull(notificationOutbox.abandonedAt),
            ),
          )
          .for("update", { skipLocked: true }),
      );
      if (!row) return "taken";
      if (row.channel === "email" && emailDown) return "skipped";

      const attemptedAt = new Date();
      const mark = (changes: OutboxChanges) =>
        query(() =>
          tx
            .update(notificationOutbox)
            .set({
              attempts: row.attempts + 1,
              lastAttemptAt: attemptedAt,
              ...changes,
            })
            .where(eq(notificationOutbox.id, row.id)),
        );

      if (
        attemptedAt.getTime() - row.createdAt.getTime() >
        NOTIFICATION_MAX_AGE_MS
      ) {
        yield* mark({ abandonedAt: attemptedAt, lastError: "too old to send" });
        return "abandoned";
      }

      const userIds = yield* recipientsOf(tx, row);
      if (row.channel === "email") {
        const progress = yield* sendEmails(tx, row, userIds);
        yield* mark(
          progress.error === null
            ? {
                sentAt: attemptedAt,
                emailRecipientsSent: progress.sentTo,
                lastError: null,
              }
            : {
                emailRecipientsSent: progress.sentTo,
                lastError: progress.error,
              },
        );
        return progress.error === null ? "sent" : "email_failed";
      }
      const tokens = yield* tokensOf(tx, userIds);
      if (tokens.length === 0) {
        yield* mark({ sentAt: attemptedAt, deviceCount: 0, lastError: null });
        return "sent";
      }

      const sender = yield* PushSender;
      const sent = yield* Effect.either(
        sender.send(
          tokens.map(({ token }) => ({
            to: token,
            title: row.title,
            body: row.body,
            data: row.data,
          })),
        ),
      );
      if (Either.isLeft(sent)) {
        console.warn(
          `[push] notification ${row.id} not sent: ${sent.left.message}`,
        );
        yield* mark({ lastError: sent.left.message });
        return "failed";
      }

      const { refs, gone } = readTickets(tokens, sent.right);
      yield* disableGoneTokens(tx, gone, attemptedAt);
      yield* mark({
        sentAt: attemptedAt,
        deviceCount: tokens.length,
        tickets: refs.length > 0 ? refs : null,
        lastError: null,
      });
      return "sent";
    }),
  );
}

function sweep(
  sweepFunction: "notifications_to_send" | "notifications_to_check",
  maxRows: number,
): Effect.Effect<readonly OutboxRef[], DatabaseError, DatabaseService> {
  return withScope({}, (tx) =>
    query(() =>
      tx.execute<OutboxRef>(
        sql`SELECT notification_id, organization_id FROM ${sql.identifier(sweepFunction)}(${maxRows})`,
      ),
    ),
  ).pipe(Effect.map(({ rows }) => rows));
}

/**
 * Sends up to `maxRows` waiting notifications, least recently tried first.
 * Stops at the first failure (Expo unreachable, most likely): the rest wait
 * for the next run, and the failed one goes to the back of the queue. An
 * email failure stops only the email: pushes go on.
 */
export function sendPendingNotifications(
  maxRows = 50,
): Effect.Effect<
  SendSummary,
  DatabaseError,
  DatabaseService | PushSender | EmailSender
> {
  return Effect.gen(function* () {
    const refs = yield* sweep("notifications_to_send", maxRows);
    let sent = 0;
    let abandoned = 0;
    let failed = 0;
    let emailDown = false;
    for (const ref of refs) {
      const exit = yield* Effect.exit(sendOne(ref, emailDown));
      if (Exit.isFailure(exit)) {
        console.error(
          `[push] notification ${ref.notification_id} failed`,
          Cause.pretty(exit.cause),
        );
      }
      const outcome = Exit.isSuccess(exit) ? exit.value : "failed";
      if (outcome === "failed") {
        failed += 1;
        break;
      }
      if (outcome === "email_failed") {
        failed += 1;
        emailDown = true;
      }
      if (outcome === "sent") sent += 1;
      if (outcome === "abandoned") abandoned += 1;
    }
    return { considered: refs.length, sent, abandoned, failed };
  });
}

export interface ReceiptSummary {
  readonly considered: number;
  readonly checked: number;
  readonly failed: number;
}

/** Fetches one sent notification's receipts; true once all were in. */
function checkOne(
  ref: OutboxRef,
): Effect.Effect<
  boolean,
  DatabaseError | PushSendError,
  DatabaseService | PushSender
> {
  return withScope({ organizationId: ref.organization_id }, (tx) =>
    Effect.gen(function* () {
      const [row] = yield* query(() =>
        tx
          .select({
            sentAt: notificationOutbox.sentAt,
            tickets: notificationOutbox.tickets,
          })
          .from(notificationOutbox)
          .where(
            and(
              eq(notificationOutbox.id, ref.notification_id),
              isNull(notificationOutbox.receiptsCheckedAt),
            ),
          )
          .for("update", { skipLocked: true }),
      );
      if (!row?.sentAt || !row.tickets) return false;
      const tickets = row.tickets;

      const sender = yield* PushSender;
      const receipts = yield* sender.receipts(
        tickets.map(({ ticketId }) => ticketId),
      );
      if (tickets.some(({ ticketId }) => !receipts.has(ticketId))) {
        return false;
      }
      const gone = tickets.flatMap(({ ticketId, pushTokenId }) => {
        const receipt = receipts.get(ticketId);
        return receipt?.status === "error" &&
          receipt.error === DEVICE_NOT_REGISTERED
          ? [pushTokenId]
          : [];
      });
      yield* disableGoneTokens(tx, gone, row.sentAt);
      yield* query(() =>
        tx
          .update(notificationOutbox)
          .set({ receiptsCheckedAt: new Date() })
          .where(eq(notificationOutbox.id, ref.notification_id)),
      );
      return true;
    }),
  );
}

/**
 * Expo's receipts for notifications sent at least 15 minutes ago: an app
 * that has since been uninstalled shows up here as `DeviceNotRegistered`,
 * and its token is disabled so nothing more is sent to it.
 */
export function checkPushReceipts(
  maxRows = 100,
): Effect.Effect<ReceiptSummary, DatabaseError, DatabaseService | PushSender> {
  return Effect.gen(function* () {
    const refs = yield* sweep("notifications_to_check", maxRows);
    let checked = 0;
    let failed = 0;
    for (const ref of refs) {
      const exit = yield* Effect.exit(checkOne(ref));
      if (Exit.isFailure(exit)) {
        console.error(
          `[push] receipts for notification ${ref.notification_id} failed`,
          Cause.pretty(exit.cause),
        );
        failed += 1;
        break;
      }
      if (exit.value) checked += 1;
    }
    return { considered: refs.length, checked, failed };
  });
}
