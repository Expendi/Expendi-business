import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { pushTokens } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  maskPushToken,
  registerPushToken,
} from "../../services/notification/push-tokens.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { registerDevice } from "../helpers/devices.js";
import { randomPushToken } from "../helpers/push.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

interface TokenRow {
  readonly user_id: string;
  readonly platform: string;
  readonly last_seen_at: Date;
  readonly disabled_at: Date | null;
}

async function tokenRows(token: string): Promise<TokenRow[]> {
  const { rows } = await owner.query<TokenRow>(
    "SELECT user_id, platform, last_seen_at, disabled_at FROM push_tokens WHERE token = $1",
    [token],
  );
  return rows;
}

function unregister(
  user: { privyUserId: string },
  token: string,
): Promise<Response> {
  return sendJson(app, `/me/push-tokens/${encodeURIComponent(token)}`, user, {
    method: "DELETE",
  });
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

describe("POST /me/push-tokens", () => {
  it("answers 401 without a login", async () => {
    // #when
    const response = await app.request("/me/push-tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: randomPushToken(), platform: "ios" }),
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("registers the device's token for the caller", async () => {
    // #given
    const user = await createUser(db);
    const token = randomPushToken();

    // #when
    const response = await sendJson(app, "/me/push-tokens", user, {
      method: "POST",
      body: { token, platform: "ios" },
    });

    // #then
    expect({
      status: response.status,
      data: await dataOf(response),
      rows: (await tokenRows(token)).map(({ user_id, platform }) => ({
        user_id,
        platform,
      })),
    }).toEqual({
      status: 200,
      data: { registered: true },
      rows: [{ user_id: user.id, platform: "ios" }],
    });
  });

  it("keeps one row when the app registers again, and marks it seen", async () => {
    // #given
    const user = await createUser(db);
    const token = await registerDevice(app, user);
    const [first] = await tokenRows(token);

    // #when
    await registerDevice(app, user, token);

    // #then
    const rows = await tokenRows(token);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.last_seen_at.getTime()).toBeGreaterThan(
      first?.last_seen_at.getTime() ?? Infinity,
    );
  });

  it("turns a token back on when the person signs in again on that device", async () => {
    // #given
    const user = await createUser(db);
    const token = await registerDevice(app, user);
    await unregister(user, token);

    // #when
    await registerDevice(app, user, token);

    // #then
    expect((await tokenRows(token))[0]?.disabled_at).toBeNull();
  });

  it("moves a token to whoever signs in on the device next", async () => {
    // #given
    const before = await createUser(db);
    const after = await createUser(db);
    const token = await registerDevice(app, before);

    // #when
    await registerDevice(app, after, token, "ios");

    // #then
    expect(
      (await tokenRows(token)).map(({ user_id, platform }) => ({
        user_id,
        platform,
      })),
    ).toEqual([{ user_id: after.id, platform: "ios" }]);
  });

  it.each([
    ["no token", { platform: "android" }],
    ["something that isn't an Expo token", { token: "abc", platform: "ios" }],
    [
      "an Expo token with extra text",
      { token: `${randomPushToken()} x`, platform: "ios" },
    ],
    ["an unknown platform", { token: randomPushToken(), platform: "windows" }],
  ])("refuses %s with 400", async (_label, body) => {
    // #given
    const user = await createUser(db);

    // #when
    const response = await sendJson(app, "/me/push-tokens", user, {
      method: "POST",
      body,
    });

    // #then
    expect(response.status).toBe(400);
  });
});

describe("DELETE /me/push-tokens/:token", () => {
  it("answers 401 without a login", async () => {
    // #when
    const response = await app.request(
      `/me/push-tokens/${encodeURIComponent(randomPushToken())}`,
      { method: "DELETE" },
    );

    // #then
    expect(response.status).toBe(401);
  });

  it("stops the device receiving the caller's notifications", async () => {
    // #given
    const user = await createUser(db);
    const token = await registerDevice(app, user);

    // #when
    const response = await unregister(user, token);

    // #then
    expect({
      data: await dataOf(response),
      disabled: (await tokenRows(token))[0]?.disabled_at instanceof Date,
    }).toEqual({ data: { unregistered: true }, disabled: true });
  });

  it("says nothing was unregistered the second time", async () => {
    // #given
    const user = await createUser(db);
    const token = await registerDevice(app, user);
    await unregister(user, token);

    // #when
    const response = await unregister(user, token);

    // #then
    expect(await dataOf(response)).toEqual({ unregistered: false });
  });

  it("leaves someone else's token alone", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const token = await registerDevice(app, holder);

    // #when
    const response = await unregister(other, token);

    // #then
    expect({
      data: await dataOf(response),
      disabled: (await tokenRows(token))[0]?.disabled_at,
    }).toEqual({ data: { unregistered: false }, disabled: null });
  });

  it("answers 400 for something that isn't an Expo token", async () => {
    // #given
    const user = await createUser(db);

    // #when
    const response = await unregister(user, "not-a-token");

    // #then
    expect(response.status).toBe(400);
  });
});

describe("push_tokens in the database", () => {
  it("shows a person only their own tokens", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const token = await registerDevice(app, holder);
    const unfiltered = sql`SELECT token FROM push_tokens`;

    // #when
    const asHolder = await runInScope(db, { userId: holder.id }, (tx) =>
      tx.execute<{ token: string }>(unfiltered),
    );
    const asOther = await runInScope(db, { userId: other.id }, (tx) =>
      tx.execute<{ token: string }>(unfiltered),
    );
    const withoutContext = await runInScope(db, {}, (tx) =>
      tx.execute<{ token: string }>(unfiltered),
    );

    // #then
    expect({
      holder: asHolder.rows.map((row) => row.token),
      other: asOther.rows,
      none: withoutContext.rows,
    }).toEqual({ holder: [token], other: [], none: [] });
  });

  it("won't let a person write a token for someone else", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);

    // #when
    const write = runInScope(db, { userId: other.id }, (tx) =>
      tx.insert(pushTokens).values({
        userId: holder.id,
        token: randomPushToken(),
        platform: "android",
      }),
    );

    // #then
    await expect(write).rejects.toThrow();
  });

  it("won't let a person disable someone else's token directly", async () => {
    // #given
    const holder = await createUser(db);
    const other = await createUser(db);
    const token = await registerDevice(app, holder);

    // #when
    await runInScope(db, { userId: other.id }, (tx) =>
      tx
        .update(pushTokens)
        .set({ disabledAt: new Date() })
        .where(eq(pushTokens.token, token)),
    );

    // #then
    expect((await tokenRows(token))[0]?.disabled_at).toBeNull();
  });

  it("reveals tokens to the sender only for members of the company in context", async () => {
    // #given
    const company = await createCompany(db);
    const member = await createUser(db);
    const outsider = await createUser(db);
    await addMember(db, company, member);
    const memberToken = await registerDevice(app, member);
    await registerDevice(app, outsider);

    // #when
    const { rows } = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx.execute<{ token: string }>(
          sql`SELECT token FROM push_tokens_of_members(ARRAY[${member.id}, ${outsider.id}]::uuid[])`,
        ),
    );

    // #then
    expect(rows.map((row) => row.token)).toEqual([memberToken]);
  });

  it("can't register a token without a person in context", async () => {
    // #when
    const register = runInScope(db, {}, (tx) =>
      tx.execute(
        sql`SELECT register_push_token(${randomPushToken()}, 'ios'::push_platform)`,
      ),
    );

    // #then
    await expect(register).rejects.toThrow();
  });
});

describe("logging a token", () => {
  it("shows only its start", () => {
    // #when
    const masked = maskPushToken("ExponentPushToken[xKq3ZtR1pLm9vB2n]");

    // #then
    expect(masked).toBe("ExponentPushToken[xKq3…");
  });

  it("never puts the whole token in a database error", async () => {
    // #given a user ID with no user, so the write fails
    const token = randomPushToken();

    // #when
    const exit = await runtime.runPromiseExit(
      registerPushToken(randomUUID(), { token, platform: "android" }),
    );

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure?.message).toContain(maskPushToken(token));
    expect(failure?.message).not.toContain(token);
  });
});
