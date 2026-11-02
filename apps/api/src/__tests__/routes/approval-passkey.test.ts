import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { approvalPasskeys, webauthnChallenges } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { RECENT_SIGN_IN_MS } from "../../services/auth/recent-sign-in.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeEmailSender, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  bearer,
  fakePrivyLastSignInAt,
  fakePrivyTokenIssuedAt,
  makeTestRuntime,
} from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let company: TestCompany;
let admin: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({ emailSender: email.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  email.state.reset();
  company = await createCompany(db);
  admin = company.admin;
});

const longAgo = () => new Date(Date.now() - RECENT_SIGN_IN_MS - 60_000);

function call(
  method: "GET" | "POST",
  path: string,
  user: TestUser,
  body?: unknown,
) {
  return app.request(`/me/approval-passkey${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...bearer(user.privyUserId),
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

async function options(
  user: TestUser,
): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const response = await call("POST", "/options", user);
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: PublicKeyCredentialCreationOptionsJSON;
  };
  return body.data;
}

async function enrol(user: TestUser, key = SoftwarePasskey.create()) {
  return call("POST", "/verify", user, {
    response: key.register(await options(user), TEST_ORIGIN),
  });
}

async function status(user: TestUser) {
  const response = await call("GET", "", user);
  return ((await response.json()) as { data: unknown }).data;
}

async function passkeyCount(userId: string): Promise<number> {
  const rows = await runInScope(db, { userId }, (tx) =>
    tx
      .select({ id: approvalPasskeys.id })
      .from(approvalPasskeys)
      .where(eq(approvalPasskeys.userId, userId)),
  );
  return rows.length;
}

describe("enrolling the approval passkey", () => {
  it("enrols an admin's first passkey after a recent sign-in", async () => {
    // #given
    expect(await status(admin)).toEqual({ enrolled: false, enrolledAt: null });

    // #when
    const response = await enrol(admin);

    // #then
    expect(response.status).toBe(201);
    expect(await status(admin)).toMatchObject({ enrolled: true });
    expect(await passkeyCount(admin.id)).toBe(1);
  });

  it("audits the enrolment in the same transaction", async () => {
    // #when
    await enrol(admin);

    // #then
    const { rows } = await owner.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit_log WHERE action = 'approval_passkey.enrolled' AND actor_id = $1",
      [admin.id],
    );
    expect(rows).toEqual([{ actor_id: admin.id }]);
  });

  it("refuses a second passkey: a replacement goes through support", async () => {
    // #given
    await enrol(admin);

    // #when
    const response = await call("POST", "/options", admin);

    // #then
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Contact Expendi support");
    expect(await passkeyCount(admin.id)).toBe(1);
  });

  it("refuses a second passkey even with a challenge issued before the first was saved", async () => {
    // #given two enrolments started side by side
    const first = await options(admin);
    const second = await options(admin);
    await call("POST", "/verify", admin, {
      response: SoftwarePasskey.create().register(first, TEST_ORIGIN),
    });

    // #when
    await call("POST", "/verify", admin, {
      response: SoftwarePasskey.create().register(second, TEST_ORIGIN),
    });

    // #then
    expect(await passkeyCount(admin.id)).toBe(1);
  });

  describe("needs a recent sign-in", () => {
    it("refuses a session whose last sign-in is older than 10 minutes, however fresh its token", async () => {
      // #given a stolen session that refreshed its token just now
      fakePrivyLastSignInAt.set(admin.privyUserId, longAgo());

      // #when
      const response = await call("POST", "/options", admin);

      // #then
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { _tag: "RecentLoginRequired" },
      });
      expect(await passkeyCount(admin.id)).toBe(0);
    });

    it("refuses a token minted more than 10 minutes ago", async () => {
      // #given
      fakePrivyTokenIssuedAt.set(admin.privyUserId, longAgo());

      // #when
      const response = await call("POST", "/options", admin);

      // #then
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { _tag: "RecentLoginRequired" },
      });
    });

    it("refuses when Privy has no sign-in on record", async () => {
      // #given
      fakePrivyLastSignInAt.set(admin.privyUserId, null);

      // #when
      const response = await call("POST", "/options", admin);

      // #then
      expect(response.status).toBe(403);
    });

    it("issues no enrolment challenge when refused", async () => {
      // #given
      fakePrivyLastSignInAt.set(admin.privyUserId, longAgo());

      // #when
      await call("POST", "/options", admin);

      // #then
      const challenges = await runInScope(db, { userId: admin.id }, (tx) =>
        tx
          .select({ id: webauthnChallenges.id })
          .from(webauthnChallenges)
          .where(eq(webauthnChallenges.userId, admin.id)),
      );
      expect(challenges).toEqual([]);
    });
  });

  it("is for admins only", async () => {
    // #given
    const employee = await createUser(db);
    await addMember(db, company, employee, { role: "employee" });

    // #when
    const response = await call("POST", "/options", employee);

    // #then
    expect(response.status).toBe(403);
    expect(await passkeyCount(employee.id)).toBe(0);
  });

  it("refuses a registration with no challenge behind it", async () => {
    // #given a registration answering a challenge the API never issued
    const forged = SoftwarePasskey.create().register(
      {
        challenge: "Zm9yZ2VkLWNoYWxsZW5nZQ",
        rp: { name: "Expendi Business", id: "business.expendi.test" },
        user: { id: "dXNlcg", name: admin.email, displayName: admin.email },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      },
      TEST_ORIGIN,
    );

    // #when
    const response = await call("POST", "/verify", admin, {
      response: forged,
    });

    // #then
    expect(response.status).toBe(403);
    expect(await passkeyCount(admin.id)).toBe(0);
  });

  it("needs a login", async () => {
    // #when
    const response = await app.request("/me/approval-passkey/options", {
      method: "POST",
    });

    // #then
    expect(response.status).toBe(401);
  });

  describe("emails every admin who could be affected", () => {
    it("emails each admin of every company the person administers, and nobody else", async () => {
      // #given
      const coAdmin = await createUser(db);
      await addMember(db, company, coAdmin, { role: "admin" });
      const employee = await createUser(db);
      await addMember(db, company, employee, { role: "employee" });
      const other = await createCompany(db, "Other Co");
      await addMember(db, other, admin, { role: "admin" });
      const unrelated = await createCompany(db, "Unrelated Co");
      await addMember(db, unrelated, admin, { role: "employee" });

      // #when
      await enrol(admin);

      // #then
      const recipients = email.state.sent.map((message) => message.to).sort();
      expect(recipients).toEqual(
        [admin.email, coAdmin.email, other.admin.email].sort(),
      );
      const toAdmin = email.state.sent.find(
        (message) => message.to === admin.email,
      );
      expect(toAdmin?.text).toContain(company.name);
      expect(toAdmin?.text).toContain("Other Co");
      expect(toAdmin?.text).not.toContain("Unrelated Co");
    });

    it("sends the emails only once the passkey is saved", async () => {
      // #given a registration that fails verification
      const challenge = await options(admin);
      const response = SoftwarePasskey.create().register(
        challenge,
        "https://evil.example",
      );

      // #when
      await call("POST", "/verify", admin, { response });

      // #then
      expect(email.state.sent).toEqual([]);
    });

    it("keeps the passkey when an email fails", async () => {
      // #given
      email.state.failNext(5);

      // #when
      const response = await enrol(admin);

      // #then
      expect(response.status).toBe(201);
      expect(await passkeyCount(admin.id)).toBe(1);
    });
  });
});
