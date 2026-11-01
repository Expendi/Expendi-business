import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { meResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import {
  addMember,
  createCompany,
  createUser,
  randomEmail,
} from "../helpers/db.js";
import {
  barrier,
  bearer,
  fakePrivyEmailLookupGates,
  fakePrivyEmails,
  makeTestRuntime,
} from "../helpers/runtime.js";
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

async function getMe(headers: Record<string, string> = {}): Promise<Response> {
  return app.request("/me", { headers });
}

async function meBody(response: Response) {
  const body = (await response.json()) as { data: unknown };
  return meResponseSchema.parse(body.data);
}

/** A Privy user who has never called the API. Privy may report mixed case. */
function newPrivyUser(): { privyUserId: string; email: string } {
  const privyUserId = `did:privy:${randomUUID()}`;
  const email = randomEmail();
  fakePrivyEmails.set(privyUserId, `  ${email.toUpperCase()} `);
  return { privyUserId, email };
}

async function usersWithPrivyId(privyUserId: string) {
  return db.select().from(users).where(eq(users.privyUserId, privyUserId));
}

async function auditEntries(entityId: string) {
  const { rows } = await owner.query<{
    action: string;
    request_id: string;
    actor_id: string;
  }>(
    "SELECT action, request_id, actor_id FROM audit_log WHERE entity_type = 'user' AND entity_id = $1",
    [entityId],
  );
  return rows;
}

describe("authentication", () => {
  it.each<[string, Record<string, string>]>([
    ["no Authorization header", {}],
    ["a non-Bearer scheme", { authorization: "Token abc" }],
    ["an empty Bearer token", { authorization: "Bearer " }],
    [
      "an invalid or expired token",
      { authorization: "Bearer eyJhbGciOi.invalid.token" },
    ],
  ])("returns 401 for %s", async (_label, headers) => {
    // #when
    const response = await getMe(headers);

    // #then
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { _tag: "Unauthorized" },
    });
  });

  it("returns 403 when the Privy account has no email", async () => {
    // #given
    const privyUserId = `did:privy:${randomUUID()}`;
    fakePrivyEmails.set(privyUserId, null);

    // #when
    const response = await getMe(bearer(privyUserId));

    // #then
    expect(response.status).toBe(403);
    expect(await usersWithPrivyId(privyUserId)).toEqual([]);
  });
});

describe("first login", () => {
  it("creates the user once, with a lowercased email, and audits it", async () => {
    // #given
    const { privyUserId, email } = newPrivyUser();

    // #when
    const first = await getMe(bearer(privyUserId));
    const second = await getMe(bearer(privyUserId));

    // #then
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await meBody(first);
    const secondBody = await meBody(second);
    expect(firstBody.user).toMatchObject({ email, phone: null });
    expect(secondBody.user.id).toBe(firstBody.user.id);
    expect(await usersWithPrivyId(privyUserId)).toHaveLength(1);
    expect(await auditEntries(firstBody.user.id)).toEqual([
      {
        action: "user.registered",
        actor_id: firstBody.user.id,
        request_id: first.headers.get("x-request-id"),
      },
    ]);
  });

  it("creates exactly one user when first logins race", async () => {
    // #given five requests that all miss the user lookup before any registers
    const { privyUserId } = newPrivyUser();
    fakePrivyEmailLookupGates.set(privyUserId, barrier(5));

    // #when
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => getMe(bearer(privyUserId))),
    );

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200,
    ]);
    expect(await usersWithPrivyId(privyUserId)).toHaveLength(1);
  });

  it("claims the user an invite created for the same email", async () => {
    // #given an invited person: a user row with their email but no Privy ID
    const { privyUserId, email } = newPrivyUser();
    const [invited] = await db
      .insert(users)
      .values({ email })
      .returning({ id: users.id });

    // #when
    const response = await getMe(bearer(privyUserId));

    // #then
    expect(response.status).toBe(200);
    const body = await meBody(response);
    expect(body.user.id).toBe(invited?.id);
    expect(await auditEntries(body.user.id)).toMatchObject([
      { action: "user.linked" },
    ]);
  });

  it("refuses an email already bound to another Privy user", async () => {
    // #given
    const existing = await createUser(db);
    const privyUserId = `did:privy:${randomUUID()}`;
    fakePrivyEmails.set(privyUserId, existing.email);

    // #when
    const response = await getMe(bearer(privyUserId));

    // #then
    expect(response.status).toBe(403);
    expect(await usersWithPrivyId(privyUserId)).toEqual([]);
  });
});

describe("GET /me", () => {
  it("lists the user's companies and roles, without removed memberships", async () => {
    // #given
    const user = await createUser(db);
    const [adminOf, employeeOf, removedFrom, unrelated] = await Promise.all([
      createCompany(db, "Alpha Ltd"),
      createCompany(db, "Beta Ltd"),
      createCompany(db, "Gamma Ltd"),
      createCompany(db, "Delta Ltd"),
    ]);
    await addMember(db, adminOf, user, { role: "admin" });
    await addMember(db, employeeOf, user, { role: "employee" });
    await addMember(db, removedFrom, user, { status: "removed" });

    // #when
    const response = await getMe(bearer(user.privyUserId));

    // #then
    expect(response.status).toBe(200);
    const body = await meBody(response);
    expect(body.user).toEqual({
      id: user.id,
      email: user.email,
      phone: null,
      fullName: null,
    });
    expect(
      body.memberships.map(
        ({ organizationId, organizationName, role, status }) => ({
          organizationId,
          organizationName,
          role,
          status,
        }),
      ),
    ).toEqual([
      {
        organizationId: adminOf.organizationId,
        organizationName: "Alpha Ltd",
        role: "admin",
        status: "active",
      },
      {
        organizationId: employeeOf.organizationId,
        organizationName: "Beta Ltd",
        role: "employee",
        status: "active",
      },
    ]);
    expect(JSON.stringify(body)).not.toContain(unrelated.organizationId);
  });
});
