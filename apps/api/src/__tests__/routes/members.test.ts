import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
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

import type { InviteMemberResponse, Member } from "@expendi-business/shared";
import {
  inviteMemberResponseSchema,
  memberSchema,
  membersResponseSchema,
  WEB_DASHBOARD_URL,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { memberships, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  addMember,
  createCompany,
  createUser,
  randomEmail,
} from "../helpers/db.js";
import { makeFakeEmailSender } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import {
  bearer,
  fakePrivyEmails,
  makeTestRuntime,
} from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";
import { TEST_APP_INSTALL_URL } from "../setup/test-env.js";

const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;
let company: TestCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ emailSender: email.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  fixture = await createIsolationFixture(db);
});

beforeEach(async () => {
  email.state.reset();
  company = await createCompany(db, "Acme Logistics");
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const membersPath = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/members`;

function send(
  path: string,
  init: RequestInit & { body?: string },
  user: TestUser,
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...bearer(user.privyUserId),
      },
    }),
  );
}

const invite = (body: unknown, user: TestUser = company.admin) =>
  send(membersPath(), { method: "POST", body: JSON.stringify(body) }, user);

const changeRole = (
  membershipId: string,
  role: string,
  user: TestUser = company.admin,
) =>
  send(
    `${membersPath()}/${membershipId}`,
    { method: "PATCH", body: JSON.stringify({ role }) },
    user,
  );

const remove = (membershipId: string, user: TestUser = company.admin) =>
  send(`${membersPath()}/${membershipId}`, { method: "DELETE" }, user);

const getCompany = (
  user: Pick<TestUser, "privyUserId">,
  target: TestCompany = company,
) =>
  app.request(`/organizations/${target.organizationId}`, {
    headers: bearer(user.privyUserId),
  });

async function invited(response: Response): Promise<InviteMemberResponse> {
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: unknown };
  return inviteMemberResponseSchema.parse(body.data);
}

async function member(response: Response): Promise<Member> {
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return memberSchema.parse(body.data);
}

async function listed(user: TestUser = company.admin): Promise<Member[]> {
  const response = await app.request(membersPath(), {
    headers: bearer(user.privyUserId),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return membersResponseSchema.parse(body.data);
}

async function membershipAudit(membershipId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT action, actor_id, before, after FROM audit_log
     WHERE entity_type = 'membership' AND entity_id = $1
     ORDER BY occurred_at, action`,
    [membershipId],
  );
  return rows;
}

const userByEmail = (address: string) =>
  db.query.users.findFirst({ where: eq(users.email, address) });

/** Someone who has never signed in, with the email Privy will report for them. */
function newPrivyLogin(address: string): Pick<TestUser, "privyUserId"> {
  const privyUserId = `did:privy:${randomUUID()}`;
  fakePrivyEmails.set(privyUserId, address.toUpperCase());
  return { privyUserId };
}

async function activeAdmins(target: TestCompany = company): Promise<number> {
  const rows = await runInScope(
    db,
    { organizationId: target.organizationId },
    (tx) => tx.select().from(memberships),
  );
  return rows.filter((row) => row.role === "admin" && row.status === "active")
    .length;
}

describe("POST /organizations/:organizationId/members", () => {
  it("invites an employee by email and emails them the install link", async () => {
    // #given
    const address = randomEmail();

    // #when
    const result = await invited(
      await invite({
        email: `  ${address.toUpperCase()} `,
        fullName: " Jane Wanjiru ",
        role: "employee",
      }),
    );

    // #then
    expect(result).toMatchObject({
      emailSent: true,
      installUrl: TEST_APP_INSTALL_URL,
      inviteLink: TEST_APP_INSTALL_URL,
      member: {
        name: "Jane Wanjiru",
        email: address,
        role: "employee",
        status: "invited",
        payoutPhoneConfirmed: false,
      },
    });
    expect(result.member.invitedAt).not.toBeNull();
    expect(await userByEmail(address)).toMatchObject({
      privyUserId: null,
      fullName: "Jane Wanjiru",
    });
    expect(email.state.sent).toHaveLength(1);
    const [message] = email.state.sent;
    expect(message?.to).toBe(address);
    expect(message?.subject).toBe(
      `${company.admin.email} invited you to Acme Logistics on Expendi Business`,
    );
    expect(message?.text).toContain(TEST_APP_INSTALL_URL);
  });

  it("audits the invite", async () => {
    // #given
    const address = randomEmail();

    // #when
    const result = await invited(
      await invite({ email: address, fullName: "Jane", role: "admin" }),
    );

    // #then
    const user = await userByEmail(address);
    expect(await membershipAudit(result.member.id)).toEqual([
      {
        action: "membership.invited",
        actor_id: company.admin.id,
        before: null,
        after: {
          userId: user?.id,
          email: address,
          fullName: "Jane",
          role: "admin",
          status: "invited",
        },
      },
    ]);
  });

  it("never overwrites the name an existing user already has", async () => {
    // #given
    const existing = await createUser(db);
    await db
      .update(users)
      .set({ fullName: "Jane Wanjiru" })
      .where(eq(users.id, existing.id));

    // #when
    const result = await invited(
      await invite({
        email: existing.email,
        fullName: "J. W.",
        role: "employee",
      }),
    );

    // #then
    expect(result.member.name).toBe("Jane Wanjiru");
    expect((await userByEmail(existing.email))?.fullName).toBe("Jane Wanjiru");
  });

  it("gives an existing user with no name the invited name", async () => {
    // #given
    const existing = await createUser(db);

    // #when
    const result = await invited(
      await invite({
        email: existing.email,
        fullName: "Otieno",
        role: "employee",
      }),
    );

    // #then
    expect(result.member.name).toBe("Otieno");
  });

  it("sends the email again when the person is already invited", async () => {
    // #given
    const address = randomEmail();
    const first = await invited(
      await invite({ email: address, fullName: "Jane", role: "employee" }),
    );

    // #when
    const again = await invited(
      await invite({ email: address, fullName: "Jane", role: "employee" }),
    );

    // #then
    expect(again).toEqual(first);
    expect(email.state.sent.map(({ to }) => to)).toEqual([address, address]);
    expect(await membershipAudit(first.member.id)).toHaveLength(1);
  });

  it("returns 409 for someone who is already an active member", async () => {
    // #given
    const colleague = await createUser(db);
    await addMember(db, company, colleague);

    // #when
    const response = await invite({
      email: colleague.email,
      fullName: "Colleague",
      role: "admin",
    });

    // #then
    expect(response.status).toBe(409);
    expect(email.state.sent).toEqual([]);
  });

  it("invites a removed member again, audited from removed", async () => {
    // #given
    const former = await createUser(db);
    const membershipId = await addMember(db, company, former, {
      role: "admin",
      status: "removed",
    });

    // #when
    const result = await invited(
      await invite({
        email: former.email,
        fullName: "Former",
        role: "employee",
      }),
    );

    // #then
    expect(result.member).toMatchObject({
      id: membershipId,
      role: "employee",
      status: "invited",
    });
    expect(await membershipAudit(membershipId)).toMatchObject([
      {
        action: "membership.invited",
        before: { role: "admin", status: "removed" },
        after: { role: "employee", status: "invited" },
      },
    ]);
  });

  it("invites an accountant like anyone else, emailing them the web dashboard instead of the app", async () => {
    // #given
    const address = randomEmail();

    // #when
    const result = await invited(
      await invite({
        email: address,
        fullName: "Grace CPA",
        role: "accountant",
      }),
    );

    // #then
    expect(result).toMatchObject({
      emailSent: true,
      inviteLink: WEB_DASHBOARD_URL,
      member: {
        name: "Grace CPA",
        email: address,
        role: "accountant",
        status: "invited",
        payoutPhoneConfirmed: false,
      },
    });
    const user = await userByEmail(address);
    expect(user).toMatchObject({ privyUserId: null, fullName: "Grace CPA" });
    expect(email.state.sent).toHaveLength(1);
    const [message] = email.state.sent;
    expect(message?.to).toBe(address);
    expect(message?.subject).toBe(
      "View-only access to Acme Logistics on Expendi Business",
    );
    expect(message?.text).toContain(
      `${company.admin.email} has given you view-only access to Acme Logistics on the Expendi Business web dashboard.`,
    );
    expect(message?.text).toContain(WEB_DASHBOARD_URL);
    expect(message?.text).not.toContain(TEST_APP_INSTALL_URL);
    expect(await membershipAudit(result.member.id)).toMatchObject([
      {
        action: "membership.invited",
        after: { userId: user?.id, role: "accountant", status: "invited" },
      },
    ]);
  });

  it("activates an accountant's invite when they first sign in", async () => {
    // #given
    const address = randomEmail();
    const { member: accountant } = await invited(
      await invite({ email: address, fullName: "Grace", role: "accountant" }),
    );
    const login = newPrivyLogin(address);

    // #when
    const response = await getCompany(login);

    // #then
    expect(response.status).toBe(200);
    expect(await userByEmail(address)).toMatchObject({
      privyUserId: login.privyUserId,
    });
    expect(
      (await listed()).find(({ id }) => id === accountant.id),
    ).toMatchObject({ role: "accountant", status: "active" });
  });

  it("resends an accountant's invite with the dashboard link", async () => {
    // #given
    const address = randomEmail();
    const first = await invited(
      await invite({ email: address, fullName: "Grace", role: "accountant" }),
    );
    email.state.reset();

    // #when
    const again = await invited(
      await invite({ email: address, fullName: "Grace", role: "accountant" }),
    );

    // #then
    expect(again.member).toEqual(first.member);
    expect(email.state.sent.map(({ text }) => text)).toEqual([
      expect.stringContaining(WEB_DASHBOARD_URL),
    ]);
    expect(await membershipAudit(first.member.id)).toHaveLength(1);
  });

  it("returns 409 when the email already belongs to someone in the company in another role", async () => {
    // #given
    const accountantEmail = randomEmail();
    await invited(
      await invite({
        email: accountantEmail,
        fullName: "Grace",
        role: "accountant",
      }),
    );
    const employeeEmail = randomEmail();
    await invited(
      await invite({
        email: employeeEmail,
        fullName: "Jane",
        role: "employee",
      }),
    );

    // #when
    const accountantAsEmployee = await invite({
      email: accountantEmail,
      fullName: "Grace",
      role: "employee",
    });
    const employeeAsAccountant = await invite({
      email: employeeEmail,
      fullName: "Jane",
      role: "accountant",
    });

    // #then
    expect([accountantAsEmployee.status, employeeAsAccountant.status]).toEqual([
      409, 409,
    ]);
  });

  it("returns 409 for an accountant who has already signed in", async () => {
    // #given
    const address = randomEmail();
    await invited(
      await invite({ email: address, fullName: "Grace", role: "accountant" }),
    );
    expect((await getCompany(newPrivyLogin(address))).status).toBe(200);

    // #when
    const response = await invite({
      email: address,
      fullName: "Grace",
      role: "accountant",
    });

    // #then
    expect(response.status).toBe(409);
  });

  it.each([
    [
      "an invalid email",
      { email: "jane@", fullName: "Jane", role: "employee" },
    ],
    [
      "a blank name",
      { email: randomEmail(), fullName: "  ", role: "employee" },
    ],
    ["an unknown role", { email: randomEmail(), fullName: "J", role: "owner" }],
    ["no email", { fullName: "Jane", role: "employee" }],
  ])("returns 400 for %s", async (_label, body) => {
    // #when
    const response = await invite(body);

    // #then
    expect(response.status).toBe(400);
  });

  it("gives the admin an accountant's dashboard link to copy when their email fails", async () => {
    // #given
    email.state.failNext();
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // #when
    const result = await invited(
      await invite({
        email: randomEmail(),
        fullName: "Grace CPA",
        role: "accountant",
      }),
    );

    // #then
    expect(result).toMatchObject({
      emailSent: false,
      inviteLink: WEB_DASHBOARD_URL,
      member: { role: "accountant", status: "invited" },
    });
  });

  it("keeps the invite when the email fails, says so, and logs only the membership ID", async () => {
    // #given
    const address = randomEmail();
    email.state.failNext();
    const logged = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    // #when
    const result = await invited(
      await invite({
        email: address,
        fullName: "Jane Wanjiru",
        role: "employee",
      }),
    );

    // #then
    expect(result).toMatchObject({
      emailSent: false,
      installUrl: TEST_APP_INSTALL_URL,
      inviteLink: TEST_APP_INSTALL_URL,
      member: { status: "invited" },
    });
    expect(await listed()).toContainEqual(result.member);
    const output = JSON.stringify(logged.mock.calls);
    expect(output).toContain(result.member.id);
    expect(output).not.toContain(address);
    expect(output).not.toContain("Jane Wanjiru");
  });
});

describe("inviting without APP_INSTALL_URL", () => {
  const unsetEmail = makeFakeEmailSender();
  let unsetRuntime: AppRuntime;
  let unsetApp: App;

  beforeAll(() => {
    unsetRuntime = makeTestRuntime(
      { emailSender: unsetEmail.layer },
      { APP_INSTALL_URL: undefined },
    );
    unsetApp = createApp({ runtime: unsetRuntime });
  });

  afterAll(async () => {
    await unsetRuntime.dispose();
  });

  it("creates the invite but sends nothing, and gives the admin no link to share", async () => {
    // #given
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    // #when
    const response = await unsetApp.request(membersPath(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...bearer(company.admin.privyUserId),
      },
      body: JSON.stringify({
        email: randomEmail(),
        fullName: "Jane",
        role: "employee",
      }),
    });

    // #then
    const result = await invited(response);
    expect(result).toMatchObject({
      emailSent: false,
      installUrl: null,
      inviteLink: null,
      member: { status: "invited" },
    });
    expect(unsetEmail.state.sent).toEqual([]);
    expect(await listed()).toContainEqual(result.member);
  });
});

describe("activating an invite", () => {
  it("activates it with the invited role when that email first signs in", async () => {
    // #given
    const address = randomEmail();
    const result = await invited(
      await invite({ email: address, fullName: "Jane", role: "admin" }),
    );
    const login = newPrivyLogin(address);

    // #when
    const response = await getCompany(login);

    // #then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { role: "admin" } });
    const user = await userByEmail(address);
    expect(user?.privyUserId).toBe(login.privyUserId);
    expect(await membershipAudit(result.member.id)).toMatchObject([
      { action: "membership.invited" },
      {
        action: "membership.activated",
        actor_id: user?.id,
        before: { status: "invited" },
        after: { status: "active", role: "admin" },
      },
    ]);
  });

  it("activates every company's invite on that first sign-in", async () => {
    // #given
    const address = randomEmail();
    const other = await createCompany(db);
    await invited(
      await invite({ email: address, fullName: "Jane", role: "employee" }),
    );
    await send(
      membersPath(other),
      {
        method: "POST",
        body: JSON.stringify({
          email: address,
          fullName: "Jane",
          role: "admin",
        }),
      },
      other.admin,
    );
    const login = newPrivyLogin(address);

    // #when the first request names one company, the second the other
    const roles = [];
    for (const target of [company, other]) {
      const response = await getCompany(login, target);
      const body = (await response.json()) as { data?: { role: string } };
      roles.push([response.status, body.data?.role]);
    }

    // #then
    expect(roles).toEqual([
      [200, "employee"],
      [200, "admin"],
    ]);
  });

  it("activates it on GET /me for someone who already had a login", async () => {
    // #given
    const existing = await createUser(db);
    await invited(
      await invite({
        email: existing.email,
        fullName: "Jane",
        role: "employee",
      }),
    );
    const beforeMe = await getCompany(existing);

    // #when
    const me = await app.request("/me", {
      headers: bearer(existing.privyUserId),
    });

    // #then
    expect(beforeMe.status).toBe(403);
    expect(await me.json()).toMatchObject({
      data: {
        memberships: [
          { organizationId: company.organizationId, status: "active" },
        ],
      },
    });
    expect((await getCompany(existing)).status).toBe(200);
  });

  it("doesn't activate an invite that was withdrawn", async () => {
    // #given
    const address = randomEmail();
    const result = await invited(
      await invite({ email: address, fullName: "Jane", role: "employee" }),
    );
    await member(await remove(result.member.id));
    const login = newPrivyLogin(address);

    // #when
    const response = await getCompany(login);

    // #then
    expect(response.status).toBe(403);
  });
});

describe("GET /organizations/:organizationId/members", () => {
  it("lists active and invited people with whether their payout phone is confirmed, never the number", async () => {
    // #given
    const withPhone = await createUser(db);
    const phone = "+254712345678";
    await db
      .update(users)
      .set({ fullName: "Aisha", phone, phoneVerifiedAt: new Date() })
      .where(eq(users.id, withPhone.id));
    await addMember(db, company, withPhone);
    const gone = await createUser(db);
    await addMember(db, company, gone, { status: "removed" });
    const pending = await invited(
      await invite({
        email: randomEmail(),
        fullName: "Brian",
        role: "employee",
      }),
    );

    // #when
    const response = await app.request(membersPath(), {
      headers: bearer(company.admin.privyUserId),
    });

    // #then
    const raw = await response.clone().text();
    const people = membersResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(
      people.map(
        ({ email: address, name, role, status, payoutPhoneConfirmed }) => ({
          email: address,
          name,
          role,
          status,
          payoutPhoneConfirmed,
        }),
      ),
    ).toEqual([
      {
        email: withPhone.email,
        name: "Aisha",
        role: "employee",
        status: "active",
        payoutPhoneConfirmed: true,
      },
      {
        email: pending.member.email,
        name: "Brian",
        role: "employee",
        status: "invited",
        payoutPhoneConfirmed: false,
      },
      {
        email: company.admin.email,
        name: null,
        role: "admin",
        status: "active",
        payoutPhoneConfirmed: false,
      },
    ]);
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(gone.email);
  });
});

describe("PATCH /organizations/:organizationId/members/:membershipId", () => {
  it("promotes an employee to admin, audited with before and after", async () => {
    // #given
    const employee = await createUser(db);
    const membershipId = await addMember(db, company, employee);

    // #when
    const updated = await member(await changeRole(membershipId, "admin"));

    // #then
    expect(updated).toMatchObject({ id: membershipId, role: "admin" });
    expect(await membershipAudit(membershipId)).toEqual([
      {
        action: "membership.role_changed",
        actor_id: company.admin.id,
        before: { role: "employee" },
        after: { role: "admin" },
      },
    ]);
    expect((await getCompany(employee)).status).toBe(200);
  });

  it("demotes an admin while another active admin remains", async () => {
    // #given
    const second = await createUser(db);
    const membershipId = await addMember(db, company, second, {
      role: "admin",
    });

    // #when
    const updated = await member(await changeRole(membershipId, "employee"));

    // #then
    expect(updated.role).toBe("employee");
  });

  it("refuses to demote the last active admin", async () => {
    // #given an invited admin doesn't count: they can't act yet
    const pending = await createUser(db);
    await addMember(db, company, pending, { role: "admin", status: "invited" });

    // #when
    const response = await changeRole(company.adminMembershipId, "employee");

    // #then
    expect(response.status).toBe(409);
    expect(await activeAdmins()).toBe(1);
    expect(await membershipAudit(company.adminMembershipId)).toEqual([]);
  });

  it("refuses to change an accountant's role", async () => {
    // #given
    const accountant = await invited(
      await invite({
        email: randomEmail(),
        fullName: "Grace",
        role: "accountant",
      }),
    );

    // #when
    const response = await changeRole(accountant.member.id, "employee");

    // #then
    expect(response.status).toBe(409);
  });

  it("returns 400 for a role other than admin or employee", async () => {
    // #given
    const employee = await createUser(db);
    const membershipId = await addMember(db, company, employee);

    // #when
    const response = await changeRole(membershipId, "accountant");

    // #then
    expect(response.status).toBe(400);
  });

  it.each([
    ["another company's membership", () => fixture.companyB.adminMembershipId],
    ["an unknown membership", () => randomUUID()],
    ["a malformed ID", () => "not-a-uuid"],
  ])("returns 404 for %s", async (_label, membershipId) => {
    // #when
    const response = await changeRole(membershipId(), "employee");

    // #then
    expect(response.status).toBe(404);
  });
});

describe("DELETE /organizations/:organizationId/members/:membershipId", () => {
  it("removes a member, audited, and their very next request is refused", async () => {
    // #given
    const employee = await createUser(db);
    const membershipId = await addMember(db, company, employee);
    const beforeRemoval = await getCompany(employee);

    // #when
    const removed = await member(await remove(membershipId));

    // #then
    expect(beforeRemoval.status).toBe(200);
    expect(removed).toMatchObject({ id: membershipId, status: "removed" });
    expect((await getCompany(employee)).status).toBe(403);
    expect(await membershipAudit(membershipId)).toEqual([
      {
        action: "membership.removed",
        actor_id: company.admin.id,
        before: { role: "employee", status: "active" },
        after: { status: "removed" },
      },
    ]);
  });

  it("refuses to remove the last active admin", async () => {
    // #when
    const response = await remove(company.adminMembershipId);

    // #then
    expect(response.status).toBe(409);
    expect((await getCompany(company.admin)).status).toBe(200);
  });

  it("lets an admin leave while another active admin remains", async () => {
    // #given
    const second = await createUser(db);
    await addMember(db, company, second, { role: "admin" });

    // #when
    const response = await remove(company.adminMembershipId);

    // #then
    expect(response.status).toBe(200);
    expect((await getCompany(company.admin)).status).toBe(403);
  });

  it("keeps an admin when two admins remove each other at the same time", async () => {
    // #given
    const second = await createUser(db);
    const secondMembershipId = await addMember(db, company, second, {
      role: "admin",
    });

    // #when
    const responses = await Promise.all([
      remove(secondMembershipId, company.admin),
      remove(company.adminMembershipId, second),
    ]);

    // #then
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 403,
    ]);
    expect(await activeAdmins()).toBe(1);
  });

  it("returns 404 for someone already removed", async () => {
    // #given
    const former = await createUser(db);
    const membershipId = await addMember(db, company, former, {
      status: "removed",
    });

    // #when
    const response = await remove(membershipId);

    // #then
    expect(response.status).toBe(404);
  });
});

describe("members routes for anyone but an admin", () => {
  it.each([
    ["GET", "", undefined],
    ["POST", "", { email: "x@example.com", fullName: "X", role: "employee" }],
    ["PATCH", "/:id", { role: "admin" }],
    ["DELETE", "/:id", undefined],
  ] as const)("refuses an employee %s", async (method, suffix, body) => {
    // #given
    const employee = await createUser(db);
    const membershipId = await addMember(db, company, employee);

    // #when
    const response = await send(
      `${membersPath()}${suffix.replace(":id", membershipId)}`,
      { method, ...(body && { body: JSON.stringify(body) }) },
      employee,
    );

    // #then
    expect(response.status).toBe(403);
    expect(await listed()).toContainEqual(
      expect.objectContaining({ id: membershipId, role: "employee" }),
    );
  });
});

describe("members routes between companies", () => {
  it.each([
    [
      "GET",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/members`,
      }),
    ],
    [
      "POST",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/members`,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email: randomEmail(),
            fullName: "Isolated",
            role: "employee",
          }),
        },
      }),
    ],
    [
      "PATCH",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/members/${randomUUID()}`,
        init: {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: "admin" }),
        },
      }),
    ],
    [
      "DELETE",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/members/${randomUUID()}`,
        init: { method: "DELETE" },
      }),
    ],
  ])("isolates %s", async (_method, request) => {
    await expectRouteIsolation(app, fixture, request);
  });
});
