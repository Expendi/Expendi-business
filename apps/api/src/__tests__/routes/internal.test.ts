import { randomUUID } from "node:crypto";
import { eq, or } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { StaffRole } from "@expendi-business/shared";
import {
  meResponseSchema,
  staffMeResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { createCompany } from "../helpers/db.js";
import {
  bearer,
  fakePrivyEmails,
  makeTestRuntime,
} from "../helpers/runtime.js";
import { createNonStaffLogin, createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const ADMIN_APP_ORIGIN = "https://ops.expendi.test";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({}, { ADMIN_APP_ORIGINS: ADMIN_APP_ORIGIN });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

async function getStaffMe(
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request("/internal/me", { headers });
}

async function post(
  path: string,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request(path, { method: "POST", headers });
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { _tag: string; message: string };
  };
  return body.error;
}

async function usersFor(privyUserId: string, email: string) {
  return db
    .select({ id: users.id })
    .from(users)
    .where(or(eq(users.privyUserId, privyUserId), eq(users.email, email)));
}

interface SignInRow {
  actor_type: string;
  actor_id: string;
  organization_id: string | null;
  entity_type: string;
  entity_id: string | null;
  after: unknown;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
}

async function signInEntries(email: string): Promise<SignInRow[]> {
  const { rows } = await owner.query<SignInRow>(
    `SELECT actor_type, actor_id, organization_id, entity_type, entity_id,
            after, request_id, ip, user_agent
     FROM audit_log
     WHERE action = 'staff.signed_in' AND after ->> 'email' = $1`,
    [email],
  );
  return rows;
}

describe("staff login", () => {
  it.each<[string, Record<string, string>]>([
    ["no Authorization header", {}],
    ["a non-Bearer scheme", { authorization: "Token abc" }],
    ["an invalid or expired token", { authorization: "Bearer not.a.token" }],
  ])("returns 401 for %s", async (_label, headers) => {
    // #when
    const response = await getStaffMe(headers);

    // #then
    expect(response.status).toBe(401);
  });

  it("refuses an email that isn't on the staff list, without creating a user", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const response = await getStaffMe(bearer(login.privyUserId));

    // #then
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      _tag: "Forbidden",
      message: "This email isn't on the Expendi staff list",
    });
    expect(await usersFor(login.privyUserId, login.email)).toEqual([]);
  });

  it("refuses a Privy account with no email", async () => {
    // #given
    const privyUserId = `did:privy:${randomUUID()}`;
    fakePrivyEmails.set(privyUserId, null);

    // #when
    const response = await getStaffMe(bearer(privyUserId));

    // #then
    expect(response.status).toBe(403);
  });

  it("refuses a disabled staff member", async () => {
    // #given
    const staff = await createStaff(owner, { status: "disabled" });

    // #when
    const response = await getStaffMe(bearer(staff.privyUserId));

    // #then
    expect(response.status).toBe(403);
  });

  it("refuses a staff member's next request once they are disabled", async () => {
    // #given
    const staff = await createStaff(owner);
    expect((await getStaffMe(bearer(staff.privyUserId))).status).toBe(200);

    // #when
    await owner.query(
      "UPDATE staff_users SET status = 'disabled' WHERE id = $1",
      [staff.staffUserId],
    );
    const response = await getStaffMe(bearer(staff.privyUserId));

    // #then
    expect(response.status).toBe(403);
  });

  it("matches the staff email whatever case Privy reports it in", async () => {
    // #given
    const staff = await createStaff(owner);
    fakePrivyEmails.set(staff.privyUserId, `  ${staff.email.toUpperCase()} `);

    // #when
    const response = await getStaffMe(bearer(staff.privyUserId));

    // #then
    expect(response.status).toBe(200);
  });
});

describe("GET /internal/me", () => {
  it.each<StaffRole>(["ops_admin", "ops_viewer"])(
    "returns the %s's email and role",
    async (role) => {
      // #given
      const staff = await createStaff(owner, { role });

      // #when
      const response = await getStaffMe(bearer(staff.privyUserId));

      // #then
      expect(response.status).toBe(200);
      const body = (await response.json()) as { data: unknown };
      expect(staffMeResponseSchema.parse(body.data)).toEqual({
        email: staff.email,
        role,
      });
    },
  );

  it("never creates a company user for a staff login", async () => {
    // #given
    const staff = await createStaff(owner);

    // #when
    await getStaffMe(bearer(staff.privyUserId));
    await post("/internal/session", bearer(staff.privyUserId));

    // #then
    expect(await usersFor(staff.privyUserId, staff.email)).toEqual([]);
  });
});

describe("POST /internal/session", () => {
  it("audits the sign-in as the staff member, with the request's ID, IP and device", async () => {
    // #given
    const staff = await createStaff(owner, { role: "ops_viewer" });

    // #when
    const response = await post("/internal/session", {
      ...bearer(staff.privyUserId),
      "x-forwarded-for": "198.51.100.4, 203.0.113.9",
      "user-agent": "Mozilla/5.0 (Macintosh)",
    });

    // #then
    expect(response.status).toBe(201);
    expect(await signInEntries(staff.email)).toEqual([
      {
        actor_type: "staff",
        actor_id: staff.staffUserId,
        organization_id: null,
        entity_type: "staff_user",
        entity_id: staff.staffUserId,
        after: { email: staff.email, role: "ops_viewer" },
        request_id: response.headers.get("x-request-id"),
        ip: "203.0.113.9",
        user_agent: "Mozilla/5.0 (Macintosh)",
      },
    ]);
  });

  it("audits nothing for an email that isn't on the staff list", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const response = await post("/internal/session", bearer(login.privyUserId));

    // #then
    expect(response.status).toBe(403);
    expect(await signInEntries(login.email)).toEqual([]);
  });
});

describe("an action endpoint: re-fetching a payout", () => {
  let viewer: TestStaff;
  let admin: TestStaff;
  const refetch = () => `/internal/payouts/${randomUUID()}/refetch`;

  beforeAll(async () => {
    [viewer, admin] = await Promise.all([
      createStaff(owner, { role: "ops_viewer" }),
      createStaff(owner, { role: "ops_admin" }),
    ]);
  });

  it("refuses an ops viewer", async () => {
    // #when
    const response = await post(refetch(), bearer(viewer.privyUserId));

    // #then
    expect(response.status).toBe(403);
    expect(await errorOf(response)).toEqual({
      _tag: "Forbidden",
      message: "Your staff role can't do this",
    });
  });

  it("lets an ops admin past the role check", async () => {
    // #when
    const response = await post(refetch(), bearer(admin.privyUserId));

    // #then
    expect(response.status).toBe(404);
    expect((await errorOf(response))._tag).toBe("NotFound");
  });
});

interface UserRow {
  id: string;
  privy_user_id: string | null;
  email: string;
  updated_at: Date;
}

async function userRowsFor(email: string): Promise<UserRow[]> {
  const { rows } = await owner.query<UserRow>(
    "SELECT id, privy_user_id, email, updated_at FROM users WHERE email = $1",
    [email],
  );
  return rows;
}

interface StaffRow {
  id: string;
  role: string;
  status: string;
  updated_at: Date;
}

async function staffRowsFor(email: string): Promise<StaffRow[]> {
  const { rows } = await owner.query<StaffRow>(
    "SELECT id, role, status, updated_at FROM staff_users WHERE email = $1",
    [email],
  );
  return rows;
}

describe("one login that is both staff and a company admin", () => {
  let company: TestCompany;
  let otherCompany: TestCompany;
  let headers: { authorization: string };

  beforeEach(async () => {
    [company, otherCompany] = await Promise.all([
      createCompany(db),
      createCompany(db),
    ]);
    await createStaff(owner, {
      role: "ops_admin",
      email: company.admin.email,
      privyUserId: company.admin.privyUserId,
    });
    headers = bearer(company.admin.privyUserId);
  });

  async function getCompany(organizationId: string): Promise<Response> {
    return app.request(`/organizations/${organizationId}`, { headers });
  }

  it("gets staff access on /internal and company access on customer routes", async () => {
    // #when
    const staffMe = await getStaffMe(headers);
    const ownCompany = await getCompany(company.organizationId);

    // #then
    expect(staffMe.status).toBe(200);
    expect(await staffMe.json()).toMatchObject({
      data: { email: company.admin.email, role: "ops_admin" },
    });
    expect(ownCompany.status).toBe(200);
    expect(await ownCompany.json()).toMatchObject({
      data: { id: company.organizationId, role: "admin" },
    });
  });

  it("gets nothing from staff status on another company's customer routes", async () => {
    // #when
    const responses = await Promise.all([
      getCompany(otherCompany.organizationId),
      app.request(`/organizations/${otherCompany.organizationId}/members`, {
        headers,
      }),
      app.request(`/organizations/${otherCompany.organizationId}/wallet`, {
        headers,
      }),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
  });

  it("keeps customer access once the staff row is disabled", async () => {
    // #given
    await owner.query(
      "UPDATE staff_users SET status = 'disabled' WHERE email = $1",
      [company.admin.email],
    );

    // #when
    const staffMe = await getStaffMe(headers);
    const ownCompany = await getCompany(company.organizationId);

    // #then
    expect(staffMe.status).toBe(403);
    expect(ownCompany.status).toBe(200);
  });

  it("leaves the users row untouched when signing in as staff", async () => {
    // #given
    const before = await userRowsFor(company.admin.email);

    // #when
    await post("/internal/session", headers);
    await getStaffMe(headers);

    // #then
    expect(await userRowsFor(company.admin.email)).toEqual(before);
  });

  it("leaves the staff row untouched when signing in as a customer", async () => {
    // #given
    const before = await staffRowsFor(company.admin.email);

    // #when
    await app.request("/me", { headers });
    await getCompany(company.organizationId);

    // #then
    expect(await staffRowsFor(company.admin.email)).toEqual(before);
  });
});

describe("a company membership without a staff row", () => {
  it("gets nothing on /internal", async () => {
    // #given
    const company = await createCompany(db);
    fakePrivyEmails.set(company.admin.privyUserId, company.admin.email);
    const headers = bearer(company.admin.privyUserId);

    // #when
    const responses = await Promise.all([
      getStaffMe(headers),
      post("/internal/session", headers),
      post(`/internal/payouts/${randomUUID()}/refetch`, headers),
    ]);

    // #then
    expect(responses.map((response) => response.status)).toEqual([
      403, 403, 403,
    ]);
  });

  it("never gets a staff row from a customer's first sign-in", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const response = await app.request("/me", {
      headers: bearer(login.privyUserId),
    });

    // #then
    expect(response.status).toBe(200);
    expect(await staffRowsFor(login.email)).toEqual([]);
  });
});

describe("staff logins on customer routes", () => {
  it("get the ordinary customer behaviour and no company's data", async () => {
    // #given a staff member with no company user yet
    const staff = await createStaff(owner);
    const company = await createCompany(db);

    // #when
    const me = await app.request("/me", { headers: bearer(staff.privyUserId) });
    const companyResponse = await app.request(
      `/organizations/${company.organizationId}`,
      { headers: bearer(staff.privyUserId) },
    );
    const members = await app.request(
      `/organizations/${company.organizationId}/members`,
      { headers: bearer(staff.privyUserId) },
    );

    // #then
    expect(me.status).toBe(200);
    const body = (await me.json()) as { data: unknown };
    expect(meResponseSchema.parse(body.data).memberships).toEqual([]);
    expect(companyResponse.status).toBe(403);
    expect(members.status).toBe(403);
  });
});

describe("CORS for the admin app", () => {
  async function preflight(path: string, origin: string): Promise<Response> {
    return app.request(path, {
      method: "OPTIONS",
      headers: {
        origin,
        "access-control-request-method": "POST",
        "access-control-request-headers": "authorization,content-type",
      },
    });
  }

  it("answers a preflight from the admin app's origin", async () => {
    // #when
    const response = await preflight("/internal/session", ADMIN_APP_ORIGIN);

    // #then
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      ADMIN_APP_ORIGIN,
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "Authorization,Content-Type",
    );
  });

  it("gives any other origin no CORS access", async () => {
    // #when
    const response = await preflight(
      "/internal/session",
      "https://evil.example",
    );

    // #then
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("lets the admin app read a refusal", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const response = await app.request("/internal/me", {
      headers: { ...bearer(login.privyUserId), origin: ADMIN_APP_ORIGIN },
    });

    // #then
    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBe(
      ADMIN_APP_ORIGIN,
    );
  });

  it("leaves customer routes without CORS", async () => {
    // #when
    const response = await preflight("/me", ADMIN_APP_ORIGIN);

    // #then
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
