import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreateOrganizationResponse } from "@expendi-business/shared";
import {
  categoriesResponseSchema,
  createOrganizationResponseSchema,
  meResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { categories, memberships } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { STARTER_CATEGORIES } from "../../services/organization/categories.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeAlchemyWebhook,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import { expectTableIsolation } from "../helpers/isolation.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const alchemy = makeFakeAlchemyWebhook();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let founder: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    alchemyWebhook: alchemy.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  privy.state.reset();
  alchemy.state.failNext(0);
  founder = await createUser(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const VALID_PIN = "P051234567X";

async function signUp(
  body: unknown,
  user: TestUser = founder,
): Promise<Response> {
  return app.request("/organizations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(user.privyUserId),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function signedUp(
  response: Response,
): Promise<CreateOrganizationResponse> {
  expect(response.status).toBe(201);
  const body = (await response.json()) as { data: unknown };
  return createOrganizationResponseSchema.parse(body.data);
}

const get = (path: string, user: TestUser = founder) =>
  app.request(path, { headers: bearer(user.privyUserId) });

const postWallet = (organizationId: string, user: TestUser = founder) =>
  app.request(`/organizations/${organizationId}/wallet`, {
    method: "POST",
    headers: bearer(user.privyUserId),
  });

/** A company made through the API, in the shape the test helpers take. */
const asTestCompany = (company: CreateOrganizationResponse): TestCompany => ({
  organizationId: company.id,
  name: company.name,
  admin: founder,
  adminMembershipId: "",
});

/** Every company the user belongs to, whatever the membership's status. */
const membershipsOf = (user: TestUser) =>
  runInScope(db, { userId: user.id }, (tx) =>
    tx
      .select({
        organizationId: memberships.organizationId,
        role: memberships.role,
        status: memberships.status,
      })
      .from(memberships),
  );

describe("POST /organizations", () => {
  it("creates the company with an uppercased KRA PIN and makes the creator its admin", async () => {
    // #when
    const company = await signedUp(
      await signUp({ name: "  Acme Logistics  ", kraPin: " p051234567x " }),
    );

    // #then
    expect(company).toMatchObject({
      name: "Acme Logistics",
      kraPin: VALID_PIN,
      role: "admin",
    });
    expect(await membershipsOf(founder)).toEqual([
      { organizationId: company.id, role: "admin", status: "active" },
    ]);
    const me = meResponseSchema.parse(
      ((await (await get("/me")).json()) as { data: unknown }).data,
    );
    expect(me.memberships).toMatchObject([
      { organizationId: company.id, role: "admin", status: "active" },
    ]);
  });

  it.each([
    ["8 digits", "P05123456X"],
    ["10 digits", "P0512345678X"],
    ["no final letter", "P0512345678"],
    ["a first letter other than A or P", "B051234567X"],
    ["a letter O for a zero", "PO51234567X"],
    ["a space inside", "P051 234567X"],
    ["nothing", ""],
  ])("rejects a KRA PIN with %s", async (_label, kraPin) => {
    // #when
    const response = await signUp({ name: "Bad PIN Ltd", kraPin });

    // #then
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        _tag: "BadRequest",
        message: expect.stringContaining("KRA PIN") as unknown,
      },
    });
    expect(await membershipsOf(founder)).toEqual([]);
  });

  it("accepts a personal KRA PIN starting with A", async () => {
    // #when
    const company = await signedUp(
      await signUp({ name: "Sole Trader", kraPin: "a123456789z" }),
    );

    // #then
    expect(company.kraPin).toBe("A123456789Z");
  });

  it.each([
    ["a blank name", { name: "   ", kraPin: VALID_PIN }],
    [
      "a name over 120 characters",
      { name: "x".repeat(121), kraPin: VALID_PIN },
    ],
    ["no KRA PIN", { name: "No PIN Ltd" }],
    ["a KRA PIN that isn't text", { name: "Number PIN Ltd", kraPin: 51234567 }],
  ])("returns 400 for %s", async (_label, body) => {
    // #when
    const response = await signUp(body);

    // #then
    expect(response.status).toBe(400);
  });

  it("returns 400 for a body that isn't JSON", async () => {
    // #when
    const response = await signUp("{not json");

    // #then
    expect(response.status).toBe(400);
  });

  it("returns 401 without authentication", async () => {
    // #when
    const response = await app.request("/organizations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Anon Ltd", kraPin: VALID_PIN }),
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("seeds the starter categories", async () => {
    // #given
    const company = await signedUp(
      await signUp({ name: "Seeded Ltd", kraPin: VALID_PIN }),
    );

    // #when
    const response = await get(`/organizations/${company.id}/categories`);

    // #then
    expect(response.status).toBe(200);
    const listed = categoriesResponseSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(
      listed.map(({ name, etimsNotRequired }) => ({ name, etimsNotRequired })),
    ).toEqual([
      { name: "Accommodation", etimsNotRequired: false },
      { name: "Air travel", etimsNotRequired: true },
      { name: "Airtime & data", etimsNotRequired: false },
      { name: "Bank & M-Pesa charges", etimsNotRequired: true },
      { name: "Fuel", etimsNotRequired: false },
      { name: "Marketing", etimsNotRequired: false },
      { name: "Meals & entertainment", etimsNotRequired: false },
      { name: "Office supplies", etimsNotRequired: false },
      { name: "Other", etimsNotRequired: false },
      { name: "Professional fees", etimsNotRequired: false },
      { name: "Repairs & maintenance", etimsNotRequired: false },
      { name: "Transport", etimsNotRequired: false },
      { name: "Utilities", etimsNotRequired: false },
    ]);
    expect(listed).toHaveLength(STARTER_CATEGORIES.length);
  });

  it("audits the company and the admin membership with the request", async () => {
    // #when
    const response = await signUp({ name: "Audited Ltd", kraPin: VALID_PIN });

    // #then
    const company = await signedUp(response);
    const { rows } = await owner.query<{ action: string }>(
      `SELECT action, actor_type, actor_id, entity_type, request_id, after
       FROM audit_log
       WHERE organization_id = $1 AND action IN ('organization.created', 'membership.created')
       ORDER BY action`,
      [company.id],
    );
    const requestId = response.headers.get("x-request-id");
    expect(rows).toEqual([
      {
        action: "membership.created",
        actor_type: "user",
        actor_id: founder.id,
        entity_type: "membership",
        request_id: requestId,
        after: { userId: founder.id, role: "admin", status: "active" },
      },
      {
        action: "organization.created",
        actor_type: "user",
        actor_id: founder.id,
        entity_type: "organization",
        request_id: requestId,
        after: {
          name: "Audited Ltd",
          kraPin: VALID_PIN,
          categories: STARTER_CATEGORIES.map(({ name }) => name),
        },
      },
    ]);
  });

  it("returns the KRA PIN from GET /organizations/:id", async () => {
    // #given
    const company = await signedUp(
      await signUp({ name: "PIN Card Ltd", kraPin: VALID_PIN }),
    );

    // #when
    const response = await get(`/organizations/${company.id}`);

    // #then
    expect(await response.json()).toEqual({
      success: true,
      data: {
        id: company.id,
        name: "PIN Card Ltd",
        kraPin: VALID_PIN,
        role: "admin",
      },
    });
  });
});

describe("company wallet at sign-up", () => {
  it("creates the company wallet on NEAR, watches its transit address, and shows its address and a zero balance", async () => {
    // #when
    const company = await signedUp(
      await signUp({ name: "Wallet Ltd", kraPin: VALID_PIN }),
    );

    // #then
    const [privyWallet] = [...privy.state.nearWallets.values()];
    const [transitWallet] = [...privy.state.wallets.values()];
    expect(privyWallet?.input.externalId).toBe(company.id);
    expect(company.wallet).toEqual({
      status: "active",
      address: privyWallet?.address,
    });
    expect(alchemy.state.watched).toContain(transitWallet?.address);
    const wallet = await get(`/organizations/${company.id}/wallet`);
    expect(await wallet.json()).toMatchObject({
      data: {
        status: "active",
        address: privyWallet?.address,
        chain: "near",
        usdcBalance: "0",
      },
    });
  });

  it.each([
    [
      "Privy fails to create the company wallet",
      () => privy.state.failNext("createNearWallet"),
    ],
    [
      "Privy fails to create the transit wallet",
      () => privy.state.failNext("createWallet"),
    ],
    [
      "Alchemy fails to watch the transit address",
      () => alchemy.state.failNext(1),
    ],
  ])(
    "keeps the company when %s, and POST /wallet resumes the setup",
    async (_label, breakProvider) => {
      // #given
      breakProvider();

      // #when
      const company = await signedUp(
        await signUp({ name: "Resumed Ltd", kraPin: VALID_PIN }),
      );

      // #then the company exists, but its wallet isn't ready
      expect(company.wallet).toEqual({ status: "creating", address: null });
      expect((await get(`/organizations/${company.id}`)).status).toBe(200);
      expect(
        await (await get(`/organizations/${company.id}/wallet`)).json(),
      ).toEqual({ success: true, data: { status: "creating" } });

      // #when the admin resumes it
      const resumed = await postWallet(company.id);

      // #then
      const [privyWallet, ...extra] = [...privy.state.nearWallets.values()];
      const [transitWallet, ...extraTransit] = [
        ...privy.state.wallets.values(),
      ];
      expect([...extra, ...extraTransit]).toEqual([]);
      expect(privy.state.policies.size).toBe(1);
      expect(await resumed.json()).toEqual({
        success: true,
        data: { status: "active", address: privyWallet?.address },
      });
      expect(alchemy.state.watched).toContain(transitWallet?.address);
      expect(
        await (await get(`/organizations/${company.id}/wallet`)).json(),
      ).toMatchObject({
        data: { status: "active", address: privyWallet?.address },
      });
    },
  );

  it("reports a ready wallet again when POST /wallet is repeated", async () => {
    // #given
    const company = await signedUp(
      await signUp({ name: "Repeat Ltd", kraPin: VALID_PIN }),
    );

    // #when
    const response = await postWallet(company.id);

    // #then
    expect(await response.json()).toEqual({
      success: true,
      data: company.wallet,
    });
    expect({
      companyWallets: privy.state.calls.createNearWallet,
      transitWallets: privy.state.calls.createWallet,
    }).toEqual({ companyWallets: 1, transitWallets: 1 });
  });

  it("refuses an employee", async () => {
    // #given
    const company = await signedUp(
      await signUp({ name: "Admin Only Ltd", kraPin: VALID_PIN }),
    );
    const employee = await createUser(db);
    await addMember(db, asTestCompany(company), employee, {
      role: "employee",
    });

    // #when
    const response = await postWallet(company.id, employee);

    // #then
    expect(response.status).toBe(403);
  });
});

describe("two companies created by the same user", () => {
  it("stay isolated", async () => {
    // #given
    const first = await signedUp(
      await signUp({ name: "First Co", kraPin: "P000000001A" }),
    );
    const second = await signedUp(
      await signUp({ name: "Second Co", kraPin: "P000000002B" }),
    );

    // #when
    const categoryIds = async (organizationId: string) => {
      const response = await get(`/organizations/${organizationId}/categories`);
      return categoriesResponseSchema
        .parse(((await response.json()) as { data: unknown }).data)
        .map(({ id }) => id);
    };
    const firstIds = await categoryIds(first.id);
    const secondIds = await categoryIds(second.id);

    // #then each company's routes return only its own data
    const firstRows = await runInScope(db, { organizationId: first.id }, (tx) =>
      tx.select({ id: categories.id }).from(categories),
    );
    expect([...firstIds].sort()).toEqual(firstRows.map(({ id }) => id).sort());
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
    expect(
      await (await get(`/organizations/${first.id}`)).json(),
    ).toMatchObject({ data: { name: "First Co", kraPin: "P000000001A" } });
    expect(
      await (await get(`/organizations/${second.id}`)).json(),
    ).toMatchObject({ data: { name: "Second Co", kraPin: "P000000002B" } });
    expect(first.wallet.address).not.toBe(second.wallet.address);

    // #then the database scopes each one's rows to it
    await expectTableIsolation(
      {
        db,
        companyA: asTestCompany(first),
        companyB: asTestCompany(second),
      },
      "categories",
    );
  });
});
