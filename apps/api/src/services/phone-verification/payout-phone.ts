import { and, eq, gt, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import type { DatabaseService } from "../../db/client.js";
import type { PhoneVerificationChallenge } from "../../db/schema/index.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { AuditActor } from "../audit/audit-log.js";
import type { EmailMessage } from "../email/email-sender.js";
import type { OtpProviderError } from "./otp-provider.js";
import { phoneVerificationChallenges, users } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import {
  BadRequest,
  Conflict,
  Gone,
  NotFound,
  ServiceUnavailable,
  TooManyRequests,
} from "../../errors.js";
import { AuditLog } from "../audit/audit-log.js";
import { toKenyanMobile } from "../auth/phone.js";
import { EmailSender } from "../email/email-sender.js";
import {
  payoutPhoneRemovedEmail,
  payoutPhoneSetEmail,
} from "../email/payout-phone-email.js";
import { OtpProvider } from "./otp-provider.js";

/**
 * The M-Pesa number claims are paid to (spec §6.18), confirmed with a
 * Telnyx Verify SMS code. Ported from the consumer backend's
 * `phone-verification-service.ts`: the same expiry, attempt, cooldown and
 * resend limits, an approved state that lets a failed commit be retried,
 * and the latest confirmation of a number winning it. Each step locks the
 * user's row, so concurrent requests can't race past a limit.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

export const PAYOUT_PHONE_LIMITS = {
  codeTtlMs: 5 * MINUTE_MS,
  maxAttempts: 5,
  resendCooldownMs: MINUTE_MS,
  maxSendsPerChallenge: 3,
  maxStartsPerDay: 5,
  /** Not in the consumer backend: SMS costs money and can be abused. */
  maxSendsPerHour: 5,
} as const;

export interface PayoutPhoneChallenge {
  readonly challengeId: string;
  readonly phone: string;
  readonly expiresAt: Date;
  readonly resendAvailableAt: Date;
}

export interface ConfirmedPayoutPhone {
  readonly phone: string;
  readonly phoneVerifiedAt: Date;
}

const notKenyan = new BadRequest({
  message: "Enter a Kenyan M-Pesa number, like 0712 345 678.",
});
const alreadyYours = new Conflict({
  message: "That's already your payout number.",
});
const notSetUp = new ServiceUnavailable({
  message: "Payout phone verification isn't set up yet.",
});
const challengeNotFound = new NotFound({
  message: "That code wasn't found. Enter your number again.",
});
const codeExpired = new Gone({
  message: "This code has expired. Enter your number again for a new one.",
});
const codeUsed = new Gone({
  message: "This code can't be used any more. Enter your number again.",
});
const tooManyAttempts = new TooManyRequests({
  message: "Too many wrong codes. Enter your number again for a new one.",
});
const cooldown = new TooManyRequests({
  message: "Wait a minute before asking for another code.",
});
const maxSends = new TooManyRequests({
  message:
    "You've asked for the most codes allowed. Enter your number again later.",
});
const hourlyCap = new TooManyRequests({
  message: "Too many codes sent in the last hour. Try again later.",
});
const dailyCap = new TooManyRequests({
  message: "Too many tries today. Try again tomorrow.",
});

const wrongCode = (triesLeft: number) =>
  new BadRequest({
    message:
      triesLeft > 0
        ? "That code isn't right. Try again."
        : "That code isn't right, and no tries are left. Enter your number again for a new code.",
  });

function sendFailure(
  error: OtpProviderError,
): ServiceUnavailable | TooManyRequests {
  switch (error.code) {
    case "NOT_CONFIGURED":
      return notSetUp;
    case "MAX_SEND_ATTEMPTS":
    case "RATE_LIMITED":
      return new TooManyRequests({
        message: "Too many codes were sent to this number. Try again later.",
      });
    case "API_ERROR":
    case "NETWORK_ERROR":
      return new ServiceUnavailable({
        message: "We couldn't send the code. Try again in a moment.",
      });
  }
}

function checkFailure(
  error: OtpProviderError,
): ServiceUnavailable | TooManyRequests {
  switch (error.code) {
    case "NOT_CONFIGURED":
      return notSetUp;
    case "RATE_LIMITED":
      return new TooManyRequests({
        message: "Too many tries. Wait a moment and try again.",
      });
    case "MAX_SEND_ATTEMPTS":
    case "API_ERROR":
    case "NETWORK_ERROR":
      return new ServiceUnavailable({
        message: "We couldn't check the code. Try again in a moment.",
      });
  }
}

const challenges = phoneVerificationChallenges;

/** Holds the user's row until the transaction ends. */
function lockUser(
  tx: Transaction,
  userId: string,
): Effect.Effect<{ readonly phone: string | null }, DatabaseError> {
  return query(() =>
    tx
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, userId))
      .for("no key update"),
  ).pipe(
    Effect.flatMap(([user]) =>
      user
        ? Effect.succeed(user)
        : Effect.dieMessage(`authenticated user ${userId} has no row`),
    ),
  );
}

function findChallenge(
  tx: Transaction,
  userId: string,
  challengeId: string,
): Effect.Effect<PhoneVerificationChallenge, NotFound | DatabaseError> {
  return query(() =>
    tx
      .select()
      .from(challenges)
      .where(and(eq(challenges.id, challengeId), eq(challenges.userId, userId)))
      .limit(1),
  ).pipe(
    Effect.flatMap(([challenge]) =>
      challenge ? Effect.succeed(challenge) : Effect.fail(challengeNotFound),
    ),
  );
}

/**
 * Counts every send of a challenge last sent within the hour, so near the
 * window's edge it errs towards refusing.
 */
function refuseOverHourlyCap(
  tx: Transaction,
  userId: string,
  now: number,
): Effect.Effect<void, TooManyRequests | DatabaseError> {
  return query(() =>
    tx
      .select({
        sends: sql<number>`coalesce(sum(${challenges.sendCount}), 0)::int`,
      })
      .from(challenges)
      .where(
        and(
          eq(challenges.userId, userId),
          gt(challenges.lastSentAt, new Date(now - HOUR_MS)),
        ),
      ),
  ).pipe(
    Effect.flatMap(([recent]) =>
      (recent?.sends ?? 0) >= PAYOUT_PHONE_LIMITS.maxSendsPerHour
        ? Effect.fail(hourlyCap)
        : Effect.void,
    ),
  );
}

const toChallenge = (
  challenge: PhoneVerificationChallenge,
): PayoutPhoneChallenge => ({
  challengeId: challenge.id,
  phone: challenge.phone,
  expiresAt: challenge.expiresAt,
  resendAvailableAt: new Date(
    challenge.lastSentAt.getTime() + PAYOUT_PHONE_LIMITS.resendCooldownMs,
  ),
});

/**
 * Sends a code to a Kenyan number, superseding the user's pending
 * challenge. The code is sent before anything is saved, so a failed send
 * leaves no challenge and uses up no limit.
 */
export function startPayoutPhoneVerification(
  userId: string,
  rawPhone: string,
): Effect.Effect<
  PayoutPhoneChallenge,
  BadRequest | Conflict | TooManyRequests | ServiceUnavailable | DatabaseError,
  DatabaseService | OtpProvider
> {
  const phone = toKenyanMobile(rawPhone);
  if (phone === null) return Effect.fail(notKenyan);
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const otp = yield* OtpProvider;
      const user = yield* lockUser(tx, userId);
      if (user.phone === phone) return yield* Effect.fail(alreadyYours);

      const now = Date.now();
      yield* refuseOverHourlyCap(tx, userId, now);
      const startsToday = yield* query(() =>
        tx.$count(
          challenges,
          and(
            eq(challenges.userId, userId),
            gt(challenges.createdAt, new Date(now - 24 * HOUR_MS)),
          ),
        ),
      );
      if (startsToday >= PAYOUT_PHONE_LIMITS.maxStartsPerDay) {
        return yield* Effect.fail(dailyCap);
      }
      const [pending] = yield* query(() =>
        tx
          .select({ lastSentAt: challenges.lastSentAt })
          .from(challenges)
          .where(
            and(
              eq(challenges.userId, userId),
              eq(challenges.status, "pending"),
            ),
          )
          .limit(1),
      );
      if (
        pending &&
        now <
          pending.lastSentAt.getTime() + PAYOUT_PHONE_LIMITS.resendCooldownMs
      ) {
        return yield* Effect.fail(cooldown);
      }

      const { providerRef } = yield* otp
        .startVerification({ to: phone })
        .pipe(Effect.mapError(sendFailure));
      const sentAt = new Date();
      yield* query(() =>
        tx
          .update(challenges)
          .set({ status: "expired" })
          .where(
            and(
              eq(challenges.userId, userId),
              eq(challenges.status, "pending"),
            ),
          ),
      );
      const [challenge] = yield* query(() =>
        tx
          .insert(challenges)
          .values({
            userId,
            phone,
            providerRef,
            expiresAt: new Date(
              sentAt.getTime() + PAYOUT_PHONE_LIMITS.codeTtlMs,
            ),
            lastSentAt: sentAt,
          })
          .returning(),
      );
      if (!challenge) {
        return yield* Effect.dieMessage("challenge insert returned no row");
      }
      return toChallenge(challenge);
    }),
  );
}

/** Sends the pending challenge's code again, with a fresh expiry. */
export function resendPayoutPhoneCode(
  userId: string,
  challengeId: string,
): Effect.Effect<
  PayoutPhoneChallenge,
  NotFound | Gone | TooManyRequests | ServiceUnavailable | DatabaseError,
  DatabaseService | OtpProvider
> {
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const otp = yield* OtpProvider;
      yield* lockUser(tx, userId);
      const challenge = yield* findChallenge(tx, userId, challengeId);
      const now = Date.now();
      if (
        challenge.status !== "pending" ||
        challenge.expiresAt.getTime() <= now
      ) {
        return yield* Effect.fail(codeUsed);
      }
      if (
        now <
        challenge.lastSentAt.getTime() + PAYOUT_PHONE_LIMITS.resendCooldownMs
      ) {
        return yield* Effect.fail(cooldown);
      }
      if (challenge.sendCount >= PAYOUT_PHONE_LIMITS.maxSendsPerChallenge) {
        return yield* Effect.fail(maxSends);
      }
      yield* refuseOverHourlyCap(tx, userId, now);

      const { providerRef } = yield* otp
        .startVerification({ to: challenge.phone })
        .pipe(Effect.mapError(sendFailure));
      const sentAt = new Date();
      const [resent] = yield* query(() =>
        tx
          .update(challenges)
          .set({
            providerRef: providerRef ?? challenge.providerRef,
            sendCount: challenge.sendCount + 1,
            lastSentAt: sentAt,
            expiresAt: new Date(
              sentAt.getTime() + PAYOUT_PHONE_LIMITS.codeTtlMs,
            ),
          })
          .where(eq(challenges.id, challenge.id))
          .returning(),
      );
      if (!resent) return yield* Effect.dieMessage("challenge vanished");
      return toChallenge(resent);
    }),
  );
}

type CheckOutcome =
  | {
      readonly kind: "approved" | "verified";
      readonly challenge: PhoneVerificationChallenge;
    }
  | {
      readonly kind: "refused";
      readonly error: BadRequest | Gone | TooManyRequests;
    };

/**
 * Asks Telnyx about the code and records what it said. Refusals are
 * returned rather than failed, so the counted attempt commits with them.
 */
function checkCode(
  userId: string,
  challengeId: string,
  code: string,
): Effect.Effect<
  CheckOutcome,
  NotFound | Gone | TooManyRequests | ServiceUnavailable | DatabaseError,
  DatabaseService | OtpProvider
> {
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const otp = yield* OtpProvider;
      yield* lockUser(tx, userId);
      const challenge = yield* findChallenge(tx, userId, challengeId);
      if (challenge.attempts >= PAYOUT_PHONE_LIMITS.maxAttempts) {
        return yield* Effect.fail(tooManyAttempts);
      }
      if (challenge.status === "approved" || challenge.status === "verified") {
        return { kind: challenge.status, challenge };
      }
      if (challenge.status === "expired") return yield* Effect.fail(codeUsed);
      if (challenge.expiresAt.getTime() <= Date.now()) {
        return yield* Effect.fail(codeExpired);
      }

      const check = yield* otp
        .checkVerification({ to: challenge.phone, code })
        .pipe(Effect.mapError(checkFailure));
      const record = (
        changes: Partial<
          Pick<PhoneVerificationChallenge, "status" | "attempts">
        >,
      ) =>
        query(() =>
          tx
            .update(challenges)
            .set(changes)
            .where(eq(challenges.id, challenge.id)),
        );

      if (check.approved) {
        yield* record({ status: "approved" });
        return { kind: "approved", challenge };
      }
      if (check.reason === "expired") {
        yield* record({ status: "expired" });
        return { kind: "refused", error: codeExpired };
      }
      if (check.reason === "max_attempts") {
        yield* record({
          status: "expired",
          attempts: PAYOUT_PHONE_LIMITS.maxAttempts,
        });
        return { kind: "refused", error: tooManyAttempts };
      }
      const attempts = challenge.attempts + 1;
      const triesLeft = PAYOUT_PHONE_LIMITS.maxAttempts - attempts;
      yield* record({
        attempts,
        ...(triesLeft === 0 && { status: "expired" }),
      });
      return { kind: "refused", error: wrongCode(triesLeft) };
    }),
  );
}

interface EmailNotice {
  readonly userId: string;
  readonly message: EmailMessage;
}

interface CommittedPayoutPhone extends ConfirmedPayoutPhone {
  /** Emails to send once committed; none when nothing changed. */
  readonly notices: readonly EmailNotice[];
}

/**
 * Moves the number onto the user in one transaction: off whoever held it
 * (numbers get recycled, so the latest confirmation wins), then onto this
 * user, each change audited. Both rows are locked in ID order, so two people
 * taking each other's numbers can't deadlock.
 */
function commitPayoutPhone(
  userId: string,
  challenge: PhoneVerificationChallenge,
): Effect.Effect<
  CommittedPayoutPhone,
  Gone | DatabaseError,
  DatabaseService | AuditLog
> {
  const { phone } = challenge;
  return withScope({ userId }, (tx) =>
    Effect.gen(function* () {
      const audit = yield* AuditLog;
      const people = yield* query(() =>
        tx
          .select({
            id: users.id,
            email: users.email,
            phone: users.phone,
            phoneVerifiedAt: users.phoneVerifiedAt,
          })
          .from(users)
          .where(or(eq(users.id, userId), eq(users.phone, phone)))
          .orderBy(users.id)
          .for("update"),
      );
      const user = people.find((person) => person.id === userId);
      if (!user) {
        return yield* Effect.dieMessage(
          `authenticated user ${userId} has no row`,
        );
      }

      const [committing] = yield* query(() =>
        tx
          .update(challenges)
          .set({ status: "verified" })
          .where(
            and(
              eq(challenges.id, challenge.id),
              eq(challenges.status, "approved"),
            ),
          )
          .returning({ id: challenges.id }),
      );
      if (user.phone === phone && user.phoneVerifiedAt) {
        return { phone, phoneVerifiedAt: user.phoneVerifiedAt, notices: [] };
      }
      if (!committing) return yield* Effect.fail(codeUsed);

      const actor: AuditActor = { type: "user", id: userId };
      const notices: EmailNotice[] = [];
      const previousHolder = people.find((person) => person.id !== userId);
      if (previousHolder) {
        yield* query(() =>
          tx
            .update(users)
            .set({ phone: null, phoneVerifiedAt: null })
            .where(eq(users.id, previousHolder.id)),
        );
        yield* audit.record(tx, {
          actor,
          organizationId: null,
          action: "user.payout_phone_removed",
          entity: { type: "user", id: previousHolder.id },
          before: { phone },
          after: { phone: null, reason: "confirmed by another user" },
        });
        notices.push({
          userId: previousHolder.id,
          message: payoutPhoneRemovedEmail({ to: previousHolder.email, phone }),
        });
      }

      const phoneVerifiedAt = new Date();
      yield* query(() =>
        tx
          .update(users)
          .set({ phone, phoneVerifiedAt })
          .where(eq(users.id, userId)),
      );
      const changed = user.phone !== null;
      yield* audit.record(tx, {
        actor,
        organizationId: null,
        action: changed ? "user.payout_phone_changed" : "user.payout_phone_set",
        entity: { type: "user", id: userId },
        before: { phone: user.phone },
        after: { phone },
      });
      notices.push({
        userId,
        message: payoutPhoneSetEmail({ to: user.email, phone, changed }),
      });
      return { phone, phoneVerifiedAt, notices };
    }),
  );
}

/**
 * Best effort, after the commit: a failed email never undoes the change and
 * is logged with the user's ID only.
 */
function sendNotices(
  notices: readonly EmailNotice[],
): Effect.Effect<void, never, EmailSender> {
  return Effect.forEach(
    notices,
    ({ userId, message }) =>
      Effect.flatMap(EmailSender, (sender) => sender.send(message)).pipe(
        Effect.catchTag("EmailSendError", (error) =>
          Effect.sync(() => {
            console.error(
              `[payout-phone] email to user ${userId} not sent: ${error.message}`,
            );
          }),
        ),
      ),
    { discard: true },
  );
}

/**
 * Checks the code and, once Telnyx approves it, puts the number on the
 * user. If the commit fails after approval, retrying commits it without
 * asking Telnyx again (Telnyx's check is one-time).
 */
export function confirmPayoutPhone(
  userId: string,
  challengeId: string,
  code: string,
): Effect.Effect<
  ConfirmedPayoutPhone,
  | BadRequest
  | NotFound
  | Gone
  | TooManyRequests
  | ServiceUnavailable
  | DatabaseError,
  DatabaseService | AuditLog | OtpProvider | EmailSender
> {
  return Effect.gen(function* () {
    const outcome = yield* checkCode(userId, challengeId, code);
    if (outcome.kind === "refused") return yield* Effect.fail(outcome.error);
    const { notices, ...confirmed } = yield* commitPayoutPhone(
      userId,
      outcome.challenge,
    );
    yield* sendNotices(notices);
    return confirmed;
  });
}

/** Approve & pay is refused for someone without a confirmed payout number. */
export class PayoutPhoneNotConfirmed extends Data.TaggedError(
  "PayoutPhoneNotConfirmed",
)<{
  readonly userId: string;
  readonly message: string;
}> {}

/**
 * The user's confirmed M-Pesa number, read in the caller's transaction.
 * Approve & pay (T19) must call it and pay only to the number it returns
 * (spec §6.18).
 */
export function requireConfirmedPayoutPhone(
  tx: Transaction,
  userId: string,
): Effect.Effect<string, PayoutPhoneNotConfirmed | DatabaseError> {
  return query(() =>
    tx
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1),
  ).pipe(
    Effect.flatMap(([user]) =>
      user?.phone
        ? Effect.succeed(user.phone)
        : Effect.fail(
            new PayoutPhoneNotConfirmed({
              userId,
              message:
                "This person hasn't confirmed their M-Pesa number yet, so they can't be paid.",
            }),
          ),
    ),
  );
}
