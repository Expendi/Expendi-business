import { randomInt } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { PayoutPhoneChallenge } from "@expendi-business/shared";
import {
  confirmPayoutPhoneResponseSchema,
  meResponseSchema,
  payoutPhoneChallengeSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { phoneVerificationChallenges, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { PAYOUT_PHONE_LIMITS } from "../../services/phone-verification/payout-phone.js";
import { OtpProviderLive } from "../../services/phone-verification/telnyx-verify.js";
import { createUser } from "../helpers/db.js";
import {
  makeFakeEmailSender,
  makeFakeOtpProvider,
  TEST_OTP_CODE,
} from "../helpers/fakes.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const otp = makeFakeOtpProvider();
const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({
    otpProvider: otp.layer,
    emailSender: email.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(() => {
  otp.state.reset();
  email.state.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const WRONG_CODE = "135791";
const SECOND_MS = 1_000;

/** A Kenyan mobile number no other test uses, as typed and in E.164. */
function newNumber(): { readonly typed: string; readonly e164: string } {
  const subscriber = String(randomInt(0, 100_000_000)).padStart(8, "0");
  return { typed: `07${subscriber}`, e164: `+2547${subscriber}` };
}

function post(path: string, body: unknown, user: TestUser): Promise<Response> {
  return Promise.resolve(
    app.request(`/me/payout-phone${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(user.privyUserId),
      },
      body: JSON.stringify(body),
    }),
  );
}

const start = (user: TestUser, phone: string) => post("", { phone }, user);
const resend = (user: TestUser, challengeId: string) =>
  post("/resend", { challengeId }, user);
const confirm = (user: TestUser, challengeId: string, code = TEST_OTP_CODE) =>
  post("/confirm", { challengeId, code }, user);

async function challengeFrom(
  response: Response,
  status = 201,
): Promise<PayoutPhoneChallenge> {
  expect(response.status).toBe(status);
  const body = (await response.json()) as { data: unknown };
  return payoutPhoneChallengeSchema.parse(body.data);
}

async function started(
  user: TestUser,
  phone: string,
): Promise<PayoutPhoneChallenge> {
  return challengeFrom(await start(user, phone));
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { _tag: string; message: string };
  };
  return { status: response.status, ...body.error };
}

/** Moves the user's challenges back in time, as if `ms` had passed. */
async function passTime(user: TestUser, ms: number): Promise<void> {
  const shift = sql`${ms} * interval '1 millisecond'`;
  await runInScope(db, { userId: user.id }, (tx) =>
    tx
      .update(phoneVerificationChallenges)
      .set({
        lastSentAt: sql`${phoneVerificationChallenges.lastSentAt} - ${shift}`,
        expiresAt: sql`${phoneVerificationChallenges.expiresAt} - ${shift}`,
        createdAt: sql`${phoneVerificationChallenges.createdAt} - ${shift}`,
      })
      .where(eq(phoneVerificationChallenges.userId, user.id)),
  );
}

const afterCooldown = (user: TestUser) =>
  passTime(user, PAYOUT_PHONE_LIMITS.resendCooldownMs + SECOND_MS);

/** Two starts and three resends a minute apart: the hourly cap of five sends. */
async function sendHourlyCap(user: TestUser): Promise<void> {
  const first = await started(user, newNumber().typed);
  await afterCooldown(user);
  await challengeFrom(await resend(user, first.challengeId), 200);
  await afterCooldown(user);
  await challengeFrom(await resend(user, first.challengeId), 200);
  await afterCooldown(user);
  const second = await started(user, newNumber().typed);
  await afterCooldown(user);
  await challengeFrom(await resend(user, second.challengeId), 200);
  await afterCooldown(user);
}

async function challengeRow(user: TestUser, challengeId: string) {
  const [row] = await runInScope(db, { userId: user.id }, (tx) =>
    tx
      .select()
      .from(phoneVerificationChallenges)
      .where(eq(phoneVerificationChallenges.id, challengeId)),
  );
  return row;
}

async function payoutPhoneOf(user: TestUser) {
  const [row] = await db
    .select({ phone: users.phone, phoneVerifiedAt: users.phoneVerifiedAt })
    .from(users)
    .where(eq(users.id, user.id));
  return row;
}

async function withConfirmedPhone(phone: string): Promise<TestUser> {
  const user = await createUser(db);
  await db
    .update(users)
    .set({ phone, phoneVerifiedAt: new Date() })
    .where(eq(users.id, user.id));
  return user;
}

async function payoutPhoneAudit(userId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    organization_id: string | null;
    before: unknown;
    after: unknown;
  }>(
    `SELECT action, actor_id, organization_id, before, after FROM audit_log
     WHERE entity_type = 'user' AND entity_id = $1 AND action LIKE 'user.payout_phone%'
     ORDER BY occurred_at, action`,
    [userId],
  );
  return rows;
}

describe("authentication", () => {
  it.each(["", "/resend", "/confirm"])(
    "POST /me/payout-phone%s returns 401 without a token",
    async (path) => {
      // #when
      const response = await app.request(`/me/payout-phone${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });

      // #then
      expect(response.status).toBe(401);
    },
  );
});

describe("POST /me/payout-phone", () => {
  it("normalises a Kenyan number and sends it a code", async () => {
    // #given
    const user = await createUser(db);
    const { e164 } = newNumber();
    const typed = `${e164.slice(4, 7)} ${e164.slice(7, 10)} ${e164.slice(10)}`;

    // #when
    const challenge = await started(user, `0${typed}`);

    // #then
    expect(challenge.phone).toBe(e164);
    expect(otp.state.sends).toEqual([e164]);
    expect(
      Date.parse(challenge.resendAvailableAt) - Date.now(),
    ).toBeGreaterThan(PAYOUT_PHONE_LIMITS.resendCooldownMs - 5 * SECOND_MS);
    expect(Date.parse(challenge.expiresAt) - Date.now()).toBeGreaterThan(
      PAYOUT_PHONE_LIMITS.codeTtlMs - 5 * SECOND_MS,
    );
  });

  it.each([
    ["a US number", "+1 415 555 2671"],
    ["a UK number", "+44 7700 900123"],
    ["a Kenyan landline", "020 2222222"],
    ["something that isn't a number", "call me"],
  ])("refuses %s with a 400 and sends nothing", async (_label, phone) => {
    // #given
    const user = await createUser(db);

    // #when
    const error = await errorOf(await start(user, phone));

    // #then
    expect(error).toMatchObject({
      status: 400,
      message: "Enter a Kenyan M-Pesa number, like 0712 345 678.",
    });
    expect(otp.state.sends).toEqual([]);
  });

  it("refuses the number the user already has", async () => {
    // #given
    const { typed, e164 } = newNumber();
    const user = await withConfirmedPhone(e164);

    // #when
    const error = await errorOf(await start(user, typed));

    // #then
    expect(error.status).toBe(409);
    expect(otp.state.sends).toEqual([]);
  });

  it("refuses to start again inside the cooldown", async () => {
    // #given
    const user = await createUser(db);
    await started(user, newNumber().typed);

    // #when
    const error = await errorOf(await start(user, newNumber().typed));

    // #then
    expect(error).toMatchObject({ status: 429, _tag: "TooManyRequests" });
    expect(otp.state.sends).toHaveLength(1);
  });

  it("sends one code when starts race", async () => {
    // #given
    const user = await createUser(db);

    // #when
    const responses = await Promise.all(
      [newNumber(), newNumber(), newNumber()].map(({ typed }) =>
        start(user, typed),
      ),
    );

    // #then
    expect(responses.map((response) => response.status).sort()).toEqual([
      201, 429, 429,
    ]);
    expect(otp.state.sends).toHaveLength(1);
  });

  it("supersedes the pending challenge, so its code no longer works", async () => {
    // #given
    const user = await createUser(db);
    const first = await started(user, newNumber().typed);
    await afterCooldown(user);
    const second = await started(user, newNumber().typed);

    // #when
    const error = await errorOf(await confirm(user, first.challengeId));

    // #then
    expect(error.status).toBe(410);
    expect((await challengeRow(user, first.challengeId))?.status).toBe(
      "expired",
    );
    expect((await challengeRow(user, second.challengeId))?.status).toBe(
      "pending",
    );
  });

  it("caps the codes sent to a user in an hour, resends included", async () => {
    // #given
    const user = await createUser(db);
    await sendHourlyCap(user);

    // #when
    const error = await errorOf(await start(user, newNumber().typed));

    // #then
    expect(error).toMatchObject({
      status: 429,
      message: "Too many codes sent in the last hour. Try again later.",
    });
    expect(otp.state.sends).toHaveLength(PAYOUT_PHONE_LIMITS.maxSendsPerHour);
  });

  it("allows sends again once the hour has passed", async () => {
    // #given
    const user = await createUser(db);
    await sendHourlyCap(user);

    // #when
    await passTime(user, 60 * 60 * SECOND_MS);
    const response = await start(user, newNumber().typed);

    // #then
    expect(response.status).toBe(201);
  });

  it("caps the starts a user makes in a day", async () => {
    // #given starts spread out, so the hourly cap never applies
    const user = await createUser(db);
    for (let day = 0; day < PAYOUT_PHONE_LIMITS.maxStartsPerDay; day++) {
      await started(user, newNumber().typed);
      await passTime(user, 61 * 60 * SECOND_MS);
    }

    // #when
    const error = await errorOf(await start(user, newNumber().typed));

    // #then
    expect(error).toMatchObject({
      status: 429,
      message: "Too many tries today. Try again tomorrow.",
    });
  });

  it("answers 503 and saves nothing when Telnyx refuses to send", async () => {
    // #given
    const user = await createUser(db);
    otp.state.failNextSend("NETWORK_ERROR");

    // #when
    const error = await errorOf(await start(user, newNumber().typed));

    // #then
    expect(error.status).toBe(503);
    const rows = await runInScope(db, { userId: user.id }, (tx) =>
      tx
        .select()
        .from(phoneVerificationChallenges)
        .where(eq(phoneVerificationChallenges.userId, user.id)),
    );
    expect(rows).toEqual([]);
  });
});

describe("POST /me/payout-phone without Telnyx settings", () => {
  it("answers 503 that verification isn't set up yet", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const unconfigured = makeTestRuntime(
      { otpProvider: OtpProviderLive },
      { TELNYX_API_KEY: undefined, TELNYX_VERIFY_PROFILE_ID: undefined },
    );
    const user = await createUser(db);

    // #when
    const response = await createApp({ runtime: unconfigured }).request(
      "/me/payout-phone",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(user.privyUserId),
        },
        body: JSON.stringify({ phone: newNumber().typed }),
      },
    );
    await unconfigured.dispose();

    // #then
    expect(await errorOf(response)).toMatchObject({
      status: 503,
      _tag: "ServiceUnavailable",
      message: "Payout phone verification isn't set up yet.",
    });
  });
});

describe("POST /me/payout-phone/resend", () => {
  it("sends the code again after the cooldown, with a fresh expiry", async () => {
    // #given
    const user = await createUser(db);
    const { typed, e164 } = newNumber();
    const challenge = await started(user, typed);
    await afterCooldown(user);
    const before = await challengeRow(user, challenge.challengeId);

    // #when
    const resent = await challengeFrom(
      await resend(user, challenge.challengeId),
      200,
    );

    // #then
    expect(resent.challengeId).toBe(challenge.challengeId);
    expect(otp.state.sends).toEqual([e164, e164]);
    expect(Date.parse(resent.expiresAt)).toBeGreaterThan(
      before?.expiresAt.getTime() ?? Infinity,
    );
    expect((await challengeRow(user, challenge.challengeId))?.sendCount).toBe(
      2,
    );
  });

  it("refuses a resend inside the cooldown", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);

    // #when
    const error = await errorOf(await resend(user, challenge.challengeId));

    // #then
    expect(error).toMatchObject({
      status: 429,
      message: "Wait a minute before asking for another code.",
    });
    expect(otp.state.sends).toHaveLength(1);
  });

  it("refuses a resend past the most sends for one challenge", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    for (
      let send = 1;
      send < PAYOUT_PHONE_LIMITS.maxSendsPerChallenge;
      send++
    ) {
      await afterCooldown(user);
      await challengeFrom(await resend(user, challenge.challengeId), 200);
    }
    await afterCooldown(user);

    // #when
    const error = await errorOf(await resend(user, challenge.challengeId));

    // #then
    expect(error).toMatchObject({
      status: 429,
      message:
        "You've asked for the most codes allowed. Enter your number again later.",
    });
    expect(otp.state.sends).toHaveLength(
      PAYOUT_PHONE_LIMITS.maxSendsPerChallenge,
    );
  });

  it("refuses to resend an expired challenge", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    await passTime(user, PAYOUT_PHONE_LIMITS.codeTtlMs + SECOND_MS);

    // #when
    const error = await errorOf(await resend(user, challenge.challengeId));

    // #then
    expect(error.status).toBe(410);
    expect(otp.state.sends).toHaveLength(1);
  });
});

describe("POST /me/payout-phone/confirm", () => {
  it("puts the confirmed number on the user, audits it and emails them", async () => {
    // #given
    const user = await createUser(db);
    const { typed, e164 } = newNumber();
    const challenge = await started(user, typed);

    // #when
    const response = await confirm(user, challenge.challengeId);

    // #then
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: unknown };
    expect(confirmPayoutPhoneResponseSchema.parse(body.data).phone).toBe(e164);
    const me = await app.request("/me", { headers: bearer(user.privyUserId) });
    const meBody = (await me.json()) as { data: unknown };
    expect(meResponseSchema.parse(meBody.data).user.phone).toBe(e164);
    expect((await payoutPhoneOf(user))?.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(await payoutPhoneAudit(user.id)).toEqual([
      {
        action: "user.payout_phone_set",
        actor_id: user.id,
        organization_id: null,
        before: { phone: null },
        after: { phone: e164 },
      },
    ]);
    expect(email.state.sent).toHaveLength(1);
    expect(email.state.sent[0]).toMatchObject({
      to: user.email,
      subject: "Your payout number was set",
    });
    expect(email.state.sent[0]?.text).toContain(e164.slice(-4));
    expect(email.state.sent[0]?.text).not.toContain(e164);
  });

  it("audits a change of the user's own number with before and after", async () => {
    // #given
    const old = newNumber();
    const next = newNumber();
    const user = await withConfirmedPhone(old.e164);
    const challenge = await started(user, next.typed);

    // #when
    const response = await confirm(user, challenge.challengeId);

    // #then
    expect(response.status).toBe(200);
    expect((await payoutPhoneOf(user))?.phone).toBe(next.e164);
    expect(await payoutPhoneAudit(user.id)).toEqual([
      {
        action: "user.payout_phone_changed",
        actor_id: user.id,
        organization_id: null,
        before: { phone: old.e164 },
        after: { phone: next.e164 },
      },
    ]);
    expect(email.state.sent.map((message) => message.subject)).toEqual([
      "Your payout number was changed",
    ]);
  });

  it("moves a number confirmed by a second user to them, auditing both", async () => {
    // #given
    const { typed, e164 } = newNumber();
    const previous = await withConfirmedPhone(e164);
    const user = await createUser(db);
    const challenge = await started(user, typed);

    // #when
    const response = await confirm(user, challenge.challengeId);

    // #then
    expect(response.status).toBe(200);
    expect(await payoutPhoneOf(user)).toMatchObject({ phone: e164 });
    expect(await payoutPhoneOf(previous)).toEqual({
      phone: null,
      phoneVerifiedAt: null,
    });
    expect(await payoutPhoneAudit(previous.id)).toEqual([
      {
        action: "user.payout_phone_removed",
        actor_id: user.id,
        organization_id: null,
        before: { phone: e164 },
        after: { phone: null, reason: "confirmed by another user" },
      },
    ]);
    expect(await payoutPhoneAudit(user.id)).toMatchObject([
      { action: "user.payout_phone_set", after: { phone: e164 } },
    ]);
    expect(
      email.state.sent.map(({ to, subject }) => ({ to, subject })),
    ).toEqual(
      expect.arrayContaining([
        { to: previous.email, subject: "Your payout number was removed" },
        { to: user.email, subject: "Your payout number was set" },
      ]),
    );
  });

  it("keeps the confirmation when the email fails, logging no number or address", async () => {
    // #given
    const user = await createUser(db);
    const { typed, e164 } = newNumber();
    const challenge = await started(user, typed);
    email.state.failNext();
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // #when
    const response = await confirm(user, challenge.challengeId);

    // #then
    expect(response.status).toBe(200);
    expect((await payoutPhoneOf(user))?.phone).toBe(e164);
    expect(email.state.sent).toEqual([]);
    const lines = logged.mock.calls.flat().map(String).join("\n");
    expect(lines).toContain(user.id);
    expect(lines).not.toContain(e164.slice(4));
    expect(lines).not.toContain(user.email);
  });

  it("refuses a wrong code and counts the attempt", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);

    // #when
    const error = await errorOf(
      await confirm(user, challenge.challengeId, WRONG_CODE),
    );

    // #then
    expect(error).toMatchObject({
      status: 400,
      message: "That code isn't right. Try again.",
    });
    expect((await challengeRow(user, challenge.challengeId))?.attempts).toBe(1);
    expect((await payoutPhoneOf(user))?.phone).toBeNull();
  });

  it("refuses an expired code without asking Telnyx", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    await passTime(user, PAYOUT_PHONE_LIMITS.codeTtlMs + SECOND_MS);

    // #when
    const error = await errorOf(await confirm(user, challenge.challengeId));

    // #then
    expect(error).toMatchObject({ status: 410, _tag: "Gone" });
    expect(otp.state.checks).toEqual([]);
    expect((await payoutPhoneOf(user))?.phone).toBeNull();
  });

  it("refuses a code Telnyx has expired, and ends the challenge", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    otp.state.nextCheck({ approved: false, reason: "expired" });

    // #when
    const error = await errorOf(await confirm(user, challenge.challengeId));

    // #then
    expect(error.status).toBe(410);
    expect((await challengeRow(user, challenge.challengeId))?.status).toBe(
      "expired",
    );
  });

  it("refuses even the right code after too many wrong ones", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    const wrong: { status: number; message: string }[] = [];
    for (
      let attempt = 0;
      attempt < PAYOUT_PHONE_LIMITS.maxAttempts;
      attempt++
    ) {
      wrong.push(
        await errorOf(await confirm(user, challenge.challengeId, WRONG_CODE)),
      );
    }

    // #when
    const error = await errorOf(await confirm(user, challenge.challengeId));

    // #then
    expect(wrong.at(-1)).toMatchObject({
      status: 400,
      message:
        "That code isn't right, and no tries are left. Enter your number again for a new code.",
    });
    expect(error).toMatchObject({ status: 429, _tag: "TooManyRequests" });
    expect(otp.state.checks).toHaveLength(PAYOUT_PHONE_LIMITS.maxAttempts);
    expect((await payoutPhoneOf(user))?.phone).toBeNull();
  });

  it("refuses the code once Telnyx reports too many attempts", async () => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);
    otp.state.nextCheck({ approved: false, reason: "max_attempts" });

    // #when
    const error = await errorOf(await confirm(user, challenge.challengeId));

    // #then
    expect(error.status).toBe(429);
    expect(
      await errorOf(await confirm(user, challenge.challengeId)),
    ).toMatchObject({ status: 429 });
  });

  it("finishes an approved confirmation without asking Telnyx again", async () => {
    // #given a code Telnyx approved whose commit didn't happen
    const user = await createUser(db);
    const { typed, e164 } = newNumber();
    const challenge = await started(user, typed);
    await runInScope(db, { userId: user.id }, (tx) =>
      tx
        .update(phoneVerificationChallenges)
        .set({ status: "approved" })
        .where(eq(phoneVerificationChallenges.id, challenge.challengeId)),
    );

    // #when
    const response = await confirm(user, challenge.challengeId, WRONG_CODE);

    // #then
    expect(response.status).toBe(200);
    expect(otp.state.checks).toEqual([]);
    expect((await payoutPhoneOf(user))?.phone).toBe(e164);
  });

  it("answers a repeated confirmation with the same result, changing nothing", async () => {
    // #given
    const user = await createUser(db);
    const { typed, e164 } = newNumber();
    const challenge = await started(user, typed);
    expect((await confirm(user, challenge.challengeId)).status).toBe(200);

    // #when
    const response = await confirm(user, challenge.challengeId);

    // #then
    expect(response.status).toBe(200);
    expect(otp.state.checks).toHaveLength(1);
    expect(await payoutPhoneAudit(user.id)).toHaveLength(1);
    expect(email.state.sent).toHaveLength(1);
    expect((await payoutPhoneOf(user))?.phone).toBe(e164);
  });

  it.each([
    ["a code with letters", { code: "12ab56" }],
    ["a challenge ID that isn't a UUID", { challengeId: "abc" }],
  ])("refuses %s with a 400", async (_label, override) => {
    // #given
    const user = await createUser(db);
    const challenge = await started(user, newNumber().typed);

    // #when
    const response = await post(
      "/confirm",
      { challengeId: challenge.challengeId, code: TEST_OTP_CODE, ...override },
      user,
    );

    // #then
    expect(response.status).toBe(400);
    expect(otp.state.checks).toEqual([]);
  });
});

describe("challenges belong to their user", () => {
  it("won't let another user confirm someone's challenge", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const challenge = await started(holder, newNumber().typed);

    // #when
    const response = await confirm(other, challenge.challengeId);

    // #then
    expect(response.status).toBe(404);
    expect(otp.state.checks).toEqual([]);
    expect(await payoutPhoneOf(other)).toEqual({
      phone: null,
      phoneVerifiedAt: null,
    });
    expect(await challengeRow(holder, challenge.challengeId)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });

  it("won't let another user resend someone's code", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const challenge = await started(holder, newNumber().typed);
    await afterCooldown(holder);

    // #when
    const response = await resend(other, challenge.challengeId);

    // #then
    expect(response.status).toBe(404);
    expect(otp.state.sends).toHaveLength(1);
  });

  it("hides a user's challenges from every other user in the database", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const challenge = await started(holder, newNumber().typed);
    const unfiltered = sql`SELECT id::text AS id FROM phone_verification_challenges`;

    // #when
    const asOwner = await runInScope(db, { userId: holder.id }, (tx) =>
      tx.execute<{ id: string }>(unfiltered),
    );
    const asOther = await runInScope(db, { userId: other.id }, (tx) =>
      tx.execute<{ id: string }>(unfiltered),
    );
    const withoutContext = await runInScope(db, {}, (tx) =>
      tx.execute<{ id: string }>(unfiltered),
    );

    // #then
    expect(asOwner.rows.map((row) => row.id)).toEqual([challenge.challengeId]);
    expect(asOther.rows).toEqual([]);
    expect(withoutContext.rows).toEqual([]);
  });

  it("won't let a user write a challenge for someone else", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);

    // #when
    const write = runInScope(db, { userId: other.id }, (tx) =>
      tx.insert(phoneVerificationChallenges).values({
        userId: holder.id,
        phone: newNumber().e164,
        expiresAt: new Date(),
        lastSentAt: new Date(),
      }),
    );

    // #then
    await expect(write).rejects.toThrow();
  });
});
