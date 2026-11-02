import { createHash, randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Either } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ZohoMapping } from "@expendi-business/shared";
import {
  zohoAccountsResponseSchema,
  zohoConnectLinkResponseSchema,
  zohoOrganizationsResponseSchema,
  zohoStatusResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TokenKey } from "../../services/zoho/token-crypto.js";
import type { TestCompany } from "../helpers/db.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingConnections,
  accountingSyncs,
  categories,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  openToken,
  parseTokenKey,
  signState,
} from "../../services/zoho/token-crypto.js";
import { createCompany } from "../helpers/db.js";
import {
  FAKE_ZOHO_ACCOUNTS_SERVER,
  FAKE_ZOHO_API_DOMAIN,
  makeFakeZoho,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`no ${what}`);
  return value;
}

const TOKEN_KEY_BASE64 = randomBytes(32).toString("base64");
const TOKEN_KEY: TokenKey = must(parseTokenKey(TOKEN_KEY_BASE64), "token key");
const KES_ORG = "60001";
const USD_ORG = "60002";

let runtime: AppRuntime;
let app: App;
let db: Database;
let owner: pg.Pool;
let fakeZoho: ReturnType<typeof makeFakeZoho>;
let opsAdmin: TestStaff;
let viewer: TestStaff;
/** Every `/internal` response body this file has seen. */
const internalBodies: string[] = [];

beforeAll(async () => {
  fakeZoho = makeFakeZoho();
  runtime = makeTestRuntime(
    { zoho: fakeZoho.layer },
    { ACCOUNTING_TOKEN_KEY: TOKEN_KEY_BASE64 },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [opsAdmin, viewer] = await Promise.all([
    createStaff(owner),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  fakeZoho.state.reset();
});

interface Reply {
  readonly status: number;
  readonly text: string;
  readonly data: unknown;
  readonly error: { readonly _tag: string; readonly message: string } | null;
}

async function staffCall(
  staff: TestStaff | { readonly privyUserId: string },
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<Reply> {
  const response = await app.request(path, {
    method,
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  internalBodies.push(text);
  const parsed = JSON.parse(text) as {
    data?: unknown;
    error?: { _tag: string; message: string };
  };
  return {
    status: response.status,
    text,
    data: parsed.data ?? null,
    error: parsed.error ?? null,
  };
}

const zohoPath = (company: TestCompany, suffix = "") =>
  `/internal/companies/${company.organizationId}/zoho${suffix}`;

async function status(company: TestCompany) {
  const reply = await staffCall(opsAdmin, "GET", zohoPath(company));
  expect(reply.status).toBe(200);
  return zohoStatusResponseSchema.parse(reply.data);
}

async function createLink(company: TestCompany) {
  const reply = await staffCall(
    opsAdmin,
    "POST",
    zohoPath(company, "/connect-link"),
  );
  expect(reply.status).toBe(201);
  const { url, expiresAt } = zohoConnectLinkResponseSchema.parse(reply.data);
  return {
    url,
    expiresAt,
    token: must(new URL(url).searchParams.get("token"), "token in the URL"),
  };
}

function openLink(token: string): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/integrations/zoho/connect?token=${encodeURIComponent(token)}`,
    ),
  );
}

async function stateFor(token: string): Promise<string> {
  const response = await openLink(token);
  expect(response.status).toBe(302);
  const location = new URL(must(response.headers.get("location"), "location"));
  return must(location.searchParams.get("state"), "state");
}

function callback(params: Record<string, string>): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/integrations/zoho/callback?${new URLSearchParams(params).toString()}`,
    ),
  );
}

const signedInParams = (state: string, code = `1000.${randomUUID()}`) => ({
  code,
  state,
  location: "eu",
  "accounts-server": FAKE_ZOHO_ACCOUNTS_SERVER,
});

async function connect(company: TestCompany) {
  const { token } = await createLink(company);
  const state = await stateFor(token);
  const response = await callback(signedInParams(state));
  expect(response.status).toBe(200);
  return { token, state };
}

async function connectWithOrganization(company: TestCompany) {
  const link = await connect(company);
  const chosen = await staffCall(
    opsAdmin,
    "POST",
    zohoPath(company, "/organization"),
    { externalOrganizationId: KES_ORG },
  );
  expect(chosen.status).toBe(200);
  return link;
}

interface ConnectionRow {
  readonly id: string;
  readonly status: string;
  readonly external_organization_id: string | null;
  readonly accounts_server: string | null;
  readonly api_domain: string | null;
  readonly refresh_token_encrypted: string | null;
  readonly paid_through_account_id: string | null;
  readonly default_account_id: string | null;
  readonly connect_token_hash: string | null;
  readonly connect_token_used_at: Date | null;
}

async function connectionRows(company: TestCompany): Promise<ConnectionRow[]> {
  const { rows } = await owner.query<ConnectionRow>(
    "SELECT * FROM accounting_connections WHERE organization_id = $1 ORDER BY created_at",
    [company.organizationId],
  );
  return rows;
}

async function latestConnection(company: TestCompany): Promise<ConnectionRow> {
  return must((await connectionRows(company)).at(-1), "connection row");
}

interface AuditRow {
  readonly action: string;
  readonly actor_type: string;
  readonly actor_id: string;
  readonly before: Record<string, unknown> | null;
  readonly after: Record<string, unknown> | null;
}

async function auditEntries(company: TestCompany): Promise<AuditRow[]> {
  const { rows } = await owner.query<AuditRow>(
    `SELECT action, actor_type, actor_id, before, after FROM audit_log
     WHERE organization_id = $1 AND entity_type = 'accounting_connection'
     ORDER BY occurred_at`,
    [company.organizationId],
  );
  return rows;
}

async function addCategories(
  company: TestCompany,
  names: readonly string[],
): Promise<string[]> {
  const rows = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .insert(categories)
        .values(
          names.map((name) => ({
            organizationId: company.organizationId,
            name,
          })),
        )
        .returning({ id: categories.id }),
  );
  return rows.map(({ id }) => id);
}

/** Read as the app role in the company's scope: categories is FORCE RLS. */
async function categoryAccounts(
  company: TestCompany,
): Promise<Record<string, string | null>> {
  const rows = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({
          name: categories.name,
          account: categories.accountingAccountId,
        })
        .from(categories),
  );
  return Object.fromEntries(rows.map(({ name, account }) => [name, account]));
}

const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/** A link token is hashed as text, so any changed character is a new token. */
const flipLastCharacter = (text: string) =>
  `${text.slice(0, -1)}${text.endsWith("A") ? "B" : "A"}`;

/** Flips one bit in the middle of the state's signature bytes. */
function tamperSignature(state: string): string {
  const [payload, mac] = state.split(".");
  const bytes = Buffer.from(mac ?? "", "base64url");
  const middle = Math.floor(bytes.length / 2);
  bytes.writeUInt8(bytes.readUInt8(middle) ^ 0x01, middle);
  return `${payload ?? ""}.${bytes.toString("base64url")}`;
}

describe("connect link", () => {
  it("shows the URL once and stores only the token's hash", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const { token, expiresAt } = await createLink(company);

    // #then
    const row = await latestConnection(company);
    expect(row.status).toBe("pending");
    expect(row.connect_token_hash).toBe(sha256(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const days = (Date.parse(expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    const shown = await staffCall(opsAdmin, "GET", zohoPath(company));
    expect(shown.text).not.toContain(token);
    expect(shown.text).not.toContain(sha256(token));
  });

  it("sends the person to Zoho's sign-in with a signed state, leaking nothing", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);

    // #when
    const response = await openLink(token);

    // #then
    expect(response.status).toBe(302);
    const location = new URL(
      must(response.headers.get("location"), "location"),
    );
    expect(location.origin).toBe("https://accounts.zoho.com");
    expect(location.searchParams.get("state")).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("connects: seals the refresh token and keeps Zoho's data centre", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    await connect(company);

    // #then
    const row = await latestConnection(company);
    const issued = must(fakeZoho.state.issuedRefreshTokens[0], "refresh token");
    const sealed = must(row.refresh_token_encrypted, "sealed token");
    expect(sealed.startsWith(`v1:${TOKEN_KEY.id}:`)).toBe(true);
    expect(sealed).not.toContain(issued);
    expect(openToken([TOKEN_KEY], sealed, row.id)).toEqual(
      Either.right(issued),
    );
    expect(row).toMatchObject({
      status: "pending",
      accounts_server: FAKE_ZOHO_ACCOUNTS_SERVER,
      api_domain: FAKE_ZOHO_API_DOMAIN,
    });
    expect(row.connect_token_used_at).not.toBeNull();
    expect(fakeZoho.state.exchanges.map((e) => e.accountsServer)).toEqual([
      FAKE_ZOHO_ACCOUNTS_SERVER,
    ]);
  });

  it("audits the link and the connection", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    await connect(company);

    // #then
    expect(
      (await auditEntries(company)).map(({ action, actor_type, actor_id }) => [
        action,
        actor_type,
        actor_id,
      ]),
    ).toEqual([
      [
        "accounting_connection.connect_link_created",
        "staff",
        opsAdmin.staffUserId,
      ],
      ["accounting_connection.connected", "system", "zoho-connect-link"],
    ]);
  });

  it("refuses a used link, on the link and on a replayed sign-in", async () => {
    // #given
    const company = await createCompany(db);
    const { token, state } = await connect(company);

    // #when
    const reopened = await openLink(token);
    const replayed = await callback(signedInParams(state));

    // #then
    expect(reopened.status).toBe(410);
    expect(await reopened.text()).toContain("already been used");
    expect(replayed.status).toBe(410);
    expect(fakeZoho.state.exchanges).toHaveLength(1);
  });

  it("refuses an expired link", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(accountingConnections)
        .set({ connectTokenExpiresAt: new Date(Date.now() - 60_000) })
        .where(
          eq(accountingConnections.organizationId, company.organizationId),
        ),
    );

    // #when
    const response = await openLink(token);

    // #then
    expect(response.status).toBe(410);
    expect(await response.text()).toContain("expired");
  });

  it("refuses a tampered, unknown or malformed link alike, without naming the company", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);

    // #when
    const responses = await Promise.all(
      [
        flipLastCharacter(token),
        randomBytes(32).toString("base64url"),
        "not-a-token",
        "",
      ].map(openLink),
    );
    const bodies = await Promise.all(responses.map((r) => r.text()));

    // #then
    expect(responses.map((r) => r.status)).toEqual([404, 404, 404, 404]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(company.name);
  });

  it("makes the previous link and its sign-ins stop working when a new one is sent", async () => {
    // #given
    const company = await createCompany(db);
    const first = await createLink(company);
    const firstState = await stateFor(first.token);

    // #when
    await createLink(company);
    const reopened = await openLink(first.token);
    const signedIn = await callback(signedInParams(firstState));

    // #then
    expect(reopened.status).toBe(404);
    expect(signedIn.status).toBe(400);
    expect(fakeZoho.state.exchanges).toEqual([]);
  });

  it("refuses a bad state without calling Zoho or naming a company", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);
    const state = await stateFor(token);
    const row = await latestConnection(company);
    const claims = {
      connectionId: row.id,
      organizationId: company.organizationId,
      linkHashPrefix: sha256(token).slice(0, 16),
    };
    const otherKey = must(
      parseTokenKey(randomBytes(32).toString("base64")),
      "other key",
    );
    const badStates = [
      tamperSignature(state),
      signState(otherKey, {
        ...claims,
        expiresAt: new Date(Date.now() + 60_000),
      }),
      signState(TOKEN_KEY, {
        ...claims,
        expiresAt: new Date(Date.now() - 1000),
      }),
      signState(TOKEN_KEY, {
        connectionId: randomUUID(),
        organizationId: randomUUID(),
        linkHashPrefix: "0123456789abcdef",
        expiresAt: new Date(Date.now() + 60_000),
      }),
    ];

    // #when
    const responses = await Promise.all([
      ...badStates.map((bad) => callback(signedInParams(bad))),
      callback({
        code: "1000.code",
        "accounts-server": FAKE_ZOHO_ACCOUNTS_SERVER,
      }),
    ]);
    const bodies = await Promise.all(responses.map((r) => r.text()));

    // #then
    expect(responses.map((r) => r.status)).toEqual([400, 400, 400, 400, 400]);
    expect(new Set(bodies).size).toBe(1);
    expect(bodies[0]).not.toContain(company.name);
    expect(fakeZoho.state.exchanges).toEqual([]);
  });

  it("never sends the code to an accounts server that isn't Zoho's", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);
    const state = await stateFor(token);

    // #when
    const response = await callback({
      ...signedInParams(state),
      "accounts-server": "https://accounts.zoho.com.evil.test",
    });

    // #then
    expect(response.status).toBe(400);
    expect(fakeZoho.state.exchanges).toEqual([]);
    expect((await openLink(token)).status).toBe(302);
  });

  it("leaves the link unspent when the person declines in Zoho", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);
    const state = await stateFor(token);

    // #when
    const response = await callback({ error: "access_denied", state });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("wasn&#39;t allowed");
    expect((await openLink(token)).status).toBe(302);
  });

  it("leaves the link unspent when Zoho refuses the code", async () => {
    // #given
    const company = await createCompany(db);
    const { token } = await createLink(company);
    const state = await stateFor(token);
    fakeZoho.state.refusedCodes.add("1000.bad");

    // #when
    const response = await callback(signedInParams(state, "1000.bad"));

    // #then
    expect(response.status).toBe(400);
    expect(
      (await latestConnection(company)).refresh_token_encrypted,
    ).toBeNull();
    expect((await openLink(token)).status).toBe(302);
  });
});

describe("when Zoho isn't set up", () => {
  let bare: AppRuntime;
  let bareApp: App;

  beforeAll(() => {
    bare = makeTestRuntime({ zoho: makeFakeZoho().layer });
    bareApp = createApp({ runtime: bare });
  });

  afterAll(async () => {
    await bare.dispose();
  });

  it("answers 503 on the connect endpoints and says so in the status", async () => {
    // #given
    const company = await createCompany(db);
    const headers = bearer(opsAdmin.privyUserId);

    // #when
    const link = await bareApp.request(zohoPath(company, "/connect-link"), {
      method: "POST",
      headers,
    });
    const page = await bareApp.request(
      `/integrations/zoho/connect?token=${randomBytes(32).toString("base64url")}`,
    );
    const shown = await bareApp.request(zohoPath(company), { headers });

    // #then
    expect(link.status).toBe(503);
    expect(await link.json()).toMatchObject({
      error: { _tag: "ServiceUnavailable", message: "Zoho isn't set up" },
    });
    expect(page.status).toBe(503);
    expect(
      zohoStatusResponseSchema.parse(
        ((await shown.json()) as { data: unknown }).data,
      ),
    ).toEqual({ configured: false, connection: null });
  });
});

describe("Zoho organization", () => {
  it("lists the organizations the connected login can see", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "GET",
      zohoPath(company, "/organizations"),
    );

    // #then
    expect(zohoOrganizationsResponseSchema.parse(reply.data)).toEqual([
      { id: USD_ORG, name: "Acme Holdings Inc", currencyCode: "USD" },
      { id: KES_ORG, name: "Acme Kenya Ltd", currencyCode: "KES" },
    ]);
  });

  it("refuses an organization whose base currency isn't KES", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/organization"),
      { externalOrganizationId: USD_ORG },
    );

    // #then
    expect(reply.status).toBe(400);
    expect(reply.error?.message).toContain("KES");
    expect(await latestConnection(company)).toMatchObject({
      status: "pending",
      external_organization_id: null,
    });
  });

  it("refuses an organization the connected login can't see", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/organization"),
      { externalOrganizationId: "99999" },
    );

    // #then
    expect(reply.status).toBe(400);
  });

  it("chooses a KES organization, activates the connection and audits it", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/organization"),
      { externalOrganizationId: KES_ORG },
    );

    // #then
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        status: "active",
        organization: { id: KES_ORG, name: "Acme Kenya Ltd" },
        apiDomain: FAKE_ZOHO_API_DOMAIN,
      },
    );
    expect((await auditEntries(company)).at(-1)).toMatchObject({
      action: "accounting_connection.organization_chosen",
      actor_type: "staff",
      actor_id: opsAdmin.staffUserId,
      after: { externalOrganizationId: KES_ORG, currencyCode: "KES" },
    });
  });

  it("needs the Zoho sign-in first", async () => {
    // #given
    const company = await createCompany(db);
    await createLink(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "GET",
      zohoPath(company, "/organizations"),
    );

    // #then
    expect(reply.status).toBe(409);
  });
});

describe("accounts and mapping", () => {
  async function mappedCompany() {
    const company = await createCompany(db);
    const [travel, meals] = await addCategories(company, ["Travel", "Meals"]);
    await connectWithOrganization(company);
    return {
      company,
      travel: must(travel, "travel category"),
      meals: must(meals, "meals category"),
    };
  }

  const putMapping = (company: TestCompany, mapping: unknown) =>
    staffCall(opsAdmin, "PUT", zohoPath(company, "/mapping"), mapping);

  it("splits the chart of accounts into expense and Paid Through accounts", async () => {
    // #given
    const { company } = await mappedCompany();

    // #when
    const reply = await staffCall(
      opsAdmin,
      "GET",
      zohoPath(company, "/accounts"),
    );

    // #then
    const chart = zohoAccountsResponseSchema.parse(reply.data);
    expect(chart.expenseAccounts.map(({ id }) => id)).toEqual([
      "acc-fees",
      "acc-cogs",
      "acc-meals",
      "acc-travel",
    ]);
    expect(chart.paidThroughAccounts.map(({ id }) => id)).toEqual([
      "acc-wallet",
      "acc-petty",
    ]);
  });

  it("saves a valid mapping and audits it", async () => {
    // #given
    const { company, travel, meals } = await mappedCompany();
    const mapping: ZohoMapping = {
      categoryAccounts: { [travel]: "acc-travel", [meals]: null },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    };

    // #when
    const reply = await putMapping(company, mapping);

    // #then
    expect(reply.status).toBe(200);
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
        categoryAccounts: [
          { categoryId: meals, categoryName: "Meals", accountId: null },
          {
            categoryId: travel,
            categoryName: "Travel",
            accountId: "acc-travel",
          },
        ],
      },
    );
    expect(await categoryAccounts(company)).toEqual({
      Travel: "acc-travel",
      Meals: null,
    });
    expect((await auditEntries(company)).at(-1)).toMatchObject({
      action: "accounting_connection.mapping_changed",
      actor_type: "staff",
      before: { paidThroughAccountId: null, defaultAccountId: null },
      after: {
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
        categoryAccounts: { [travel]: "acc-travel", [meals]: null },
      },
    });
  });

  it.each<[string, (ids: { travel: string }) => unknown]>([
    [
      "an expense account as Paid Through",
      ({ travel }) => ({
        categoryAccounts: { [travel]: "acc-travel" },
        paidThroughAccountId: "acc-meals",
        defaultAccountId: "acc-fees",
      }),
    ],
    [
      "a bank account as the default",
      () => ({
        categoryAccounts: {},
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-petty",
      }),
    ],
    [
      "a category mapped to an income account",
      ({ travel }) => ({
        categoryAccounts: { [travel]: "acc-sales" },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      }),
    ],
    [
      "an account Zoho doesn't have",
      ({ travel }) => ({
        categoryAccounts: { [travel]: "acc-missing" },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      }),
    ],
    [
      "a category that isn't the company's",
      () => ({
        categoryAccounts: { [randomUUID()]: "acc-travel" },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      }),
    ],
    [
      "a category key that isn't an ID",
      () => ({
        categoryAccounts: { travel: "acc-travel" },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      }),
    ],
    [
      "no Paid Through account",
      () => ({ categoryAccounts: {}, defaultAccountId: "acc-fees" }),
    ],
  ])("refuses %s and saves nothing", async (_label, mappingFor) => {
    // #given
    const { company, travel } = await mappedCompany();

    // #when
    const reply = await putMapping(company, mappingFor({ travel }));

    // #then
    expect(reply.status).toBe(400);
    expect(await latestConnection(company)).toMatchObject({
      paid_through_account_id: null,
      default_account_id: null,
    });
    expect(await categoryAccounts(company)).toEqual({
      Travel: null,
      Meals: null,
    });
  });

  it("clears the mapping when staff switch to another organization", async () => {
    // #given
    const { company, travel } = await mappedCompany();
    await putMapping(company, {
      categoryAccounts: { [travel]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    });
    fakeZoho.state.organizations.push({
      id: "60003",
      name: "Acme Branch Ltd",
      currencyCode: "KES",
    });

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/organization"),
      { externalOrganizationId: "60003" },
    );

    // #then
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toMatchObject(
      {
        organization: { id: "60003" },
        paidThroughAccountId: null,
        defaultAccountId: null,
      },
    );
    expect(await categoryAccounts(company)).toEqual({
      Travel: null,
      Meals: null,
    });
  });

  it("needs an organization first", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "GET",
      zohoPath(company, "/accounts"),
    );

    // #then
    expect(reply.status).toBe(409);
  });
});

describe("lost access", () => {
  function revokeEverythingAtZoho() {
    for (const token of fakeZoho.state.issuedRefreshTokens) {
      fakeZoho.state.revokedTokens.add(token);
    }
    for (const token of fakeZoho.state.issuedAccessTokens) {
      fakeZoho.state.refusedAccessTokens.add(token);
    }
  }

  it("marks the connection needs_reconnect when Zoho rejects the refresh token, and audits it", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);
    revokeEverythingAtZoho();

    // #when
    const reply = await staffCall(
      opsAdmin,
      "GET",
      zohoPath(company, "/accounts"),
    );

    // #then
    expect(reply.status).toBe(409);
    expect(await latestConnection(company)).toMatchObject({
      status: "needs_reconnect",
      refresh_token_encrypted: null,
      external_organization_id: KES_ORG,
    });
    expect((await auditEntries(company)).at(-1)).toMatchObject({
      action: "accounting_connection.needs_reconnect",
      actor_type: "system",
      actor_id: "zoho",
      after: { status: "needs_reconnect" },
    });
    expect(fakeZoho.state.refreshes).toHaveLength(1);
  });

  it("reuses the cached access token instead of refreshing every call", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);

    // #when
    await staffCall(opsAdmin, "GET", zohoPath(company, "/accounts"));
    await staffCall(opsAdmin, "GET", zohoPath(company, "/organizations"));

    // #then
    expect(fakeZoho.state.refreshes).toEqual([]);
  });

  it("reconnects through a new link and keeps the organization and mapping", async () => {
    // #given
    const company = await createCompany(db);
    const [travel] = await addCategories(company, ["Travel"]);
    await connectWithOrganization(company);
    await staffCall(opsAdmin, "PUT", zohoPath(company, "/mapping"), {
      categoryAccounts: { [must(travel, "category")]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    });
    revokeEverythingAtZoho();
    await staffCall(opsAdmin, "GET", zohoPath(company, "/accounts"));

    // #when
    await connect(company);

    // #then
    expect((await status(company)).connection).toMatchObject({
      status: "active",
      organization: { id: KES_ORG },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    });
    expect(
      (await staffCall(opsAdmin, "GET", zohoPath(company, "/accounts"))).status,
    ).toBe(200);
    expect(await connectionRows(company)).toHaveLength(1);
  });

  it("refuses a reconnect from a Zoho login that can't see the organization", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);
    const before = await latestConnection(company);
    const { token } = await createLink(company);
    const state = await stateFor(token);
    fakeZoho.state.organizations = fakeZoho.state.organizations.filter(
      ({ id }) => id !== KES_ORG,
    );

    // #when
    const response = await callback(signedInParams(state));

    // #then
    expect(response.status).toBe(409);
    const discarded = must(fakeZoho.state.issuedRefreshTokens.at(-1), "token");
    expect(fakeZoho.state.revokedTokens.has(discarded)).toBe(true);
    expect(await latestConnection(company)).toMatchObject({
      status: "active",
      refresh_token_encrypted: before.refresh_token_encrypted,
      connect_token_used_at: null,
    });
  });
});

describe("disconnect", () => {
  it("revokes at Zoho, forgets the token and the link, and audits it", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);
    const issued = must(fakeZoho.state.issuedRefreshTokens[0], "token");

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/disconnect"),
    );

    // #then
    expect(zohoStatusResponseSchema.parse(reply.data).connection).toBeNull();
    expect(fakeZoho.state.revokedTokens.has(issued)).toBe(true);
    expect(await latestConnection(company)).toMatchObject({
      status: "disconnected",
      refresh_token_encrypted: null,
      connect_token_hash: null,
    });
    expect((await auditEntries(company)).at(-1)).toMatchObject({
      action: "accounting_connection.disconnected",
      actor_type: "staff",
      actor_id: opsAdmin.staffUserId,
      before: { status: "active" },
      after: { status: "disconnected", revokedAtZoho: true },
    });
  });

  it("still disconnects when Zoho can't be reached", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);
    fakeZoho.state.failNext("revokeToken", "NETWORK_ERROR");

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/disconnect"),
    );

    // #then
    expect(reply.status).toBe(200);
    expect((await auditEntries(company)).at(-1)?.after).toMatchObject({
      revokedAtZoho: false,
    });
  });

  it("lets the company connect again afterwards, on a new connection", async () => {
    // #given
    const company = await createCompany(db);
    await connect(company);
    await staffCall(opsAdmin, "POST", zohoPath(company, "/disconnect"));

    // #when
    await connect(company);

    // #then
    expect((await connectionRows(company)).map(({ status }) => status)).toEqual(
      ["disconnected", "pending"],
    );
  });

  it("is a 404 without a connection", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const reply = await staffCall(
      opsAdmin,
      "POST",
      zohoPath(company, "/disconnect"),
    );

    // #then
    expect(reply.status).toBe(404);
  });
});

describe("tokens never leave the API", () => {
  it("no /internal response carries a token, a sealed token or a link's hash", async () => {
    // #given
    const company = await createCompany(db);
    const [travel] = await addCategories(company, ["Travel"]);
    internalBodies.length = 0;
    const { token } = await connectWithOrganization(company);
    const linkResponses = internalBodies.splice(0);
    const sealed = must(
      (await latestConnection(company)).refresh_token_encrypted,
      "sealed token",
    );

    // #when
    await status(company);
    await staffCall(opsAdmin, "GET", zohoPath(company, "/organizations"));
    await staffCall(opsAdmin, "GET", zohoPath(company, "/accounts"));
    await staffCall(opsAdmin, "PUT", zohoPath(company, "/mapping"), {
      categoryAccounts: { [must(travel, "category")]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    });
    await staffCall(opsAdmin, "POST", zohoPath(company, "/disconnect"));

    // #then
    const secrets = [
      ...fakeZoho.state.issuedRefreshTokens,
      ...fakeZoho.state.issuedAccessTokens,
      sealed,
      sealed.split(":")[4] ?? sealed,
      sha256(token),
    ];
    expect(secrets.length).toBeGreaterThan(3);
    const responses = [...linkResponses, ...internalBodies];
    expect(responses.length).toBeGreaterThan(6);
    for (const body of responses) {
      for (const secret of secrets) expect(body).not.toContain(secret);
    }
    const [linkResponse, ...afterLink] = linkResponses;
    expect(linkResponse).toContain(token);
    for (const body of [...afterLink, ...internalBodies]) {
      expect(body).not.toContain(token);
    }
  });
});

describe("staff roles", () => {
  it("lets a viewer look", async () => {
    // #given
    const company = await createCompany(db);
    await connectWithOrganization(company);

    // #when
    const replies = await Promise.all(
      ["", "/organizations", "/accounts"].map((suffix) =>
        staffCall(viewer, "GET", zohoPath(company, suffix)),
      ),
    );

    // #then
    expect(replies.map(({ status: code }) => code)).toEqual([200, 200, 200]);
  });

  it("refuses a viewer every action, changing nothing", async () => {
    // #given
    const company = await createCompany(db);
    const [travel] = await addCategories(company, ["Travel"]);
    await connectWithOrganization(company);
    const before = await latestConnection(company);
    const auditCount = (await auditEntries(company)).length;

    // #when
    const replies = await Promise.all([
      staffCall(viewer, "POST", zohoPath(company, "/connect-link")),
      staffCall(viewer, "POST", zohoPath(company, "/organization"), {
        externalOrganizationId: KES_ORG,
      }),
      staffCall(viewer, "PUT", zohoPath(company, "/mapping"), {
        categoryAccounts: { [must(travel, "category")]: "acc-travel" },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      }),
      staffCall(viewer, "POST", zohoPath(company, "/disconnect")),
    ]);

    // #then
    expect(replies.map((reply) => [reply.status, reply.error?._tag])).toEqual([
      [403, "Forbidden"],
      [403, "Forbidden"],
      [403, "Forbidden"],
      [403, "Forbidden"],
    ]);
    expect(await latestConnection(company)).toEqual(before);
    expect(await auditEntries(company)).toHaveLength(auditCount);
  });
});

describe("company isolation", () => {
  it("keeps accounting_connections and accounting_syncs to their company in the database", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    for (const company of [fixture.companyA, fixture.companyB]) {
      await runInScope(
        db,
        { organizationId: company.organizationId },
        async (tx) => {
          await tx
            .insert(accountingConnections)
            .values({ organizationId: company.organizationId });
          await tx.insert(accountingSyncs).values({
            organizationId: company.organizationId,
            subjectType: "expense",
            subjectId: randomUUID(),
          });
        },
      );
    }

    // #then
    await expectTableIsolation(fixture, "accounting_connections");
    await expectTableIsolation(fixture, "accounting_syncs");
  });

  it("allows one sync per item per company", async () => {
    // #given
    const company = await createCompany(db);
    const sync = {
      organizationId: company.organizationId,
      subjectType: "expense" as const,
      subjectId: randomUUID(),
    };
    const insert = () =>
      runInScope(db, { organizationId: company.organizationId }, (tx) =>
        tx.insert(accountingSyncs).values(sync),
      );
    await insert();

    // #then
    await expect(insert()).rejects.toThrow();
  });

  it("allows only one connection that isn't disconnected per company", async () => {
    // #given
    const company = await createCompany(db);
    const insert = () =>
      runInScope(db, { organizationId: company.organizationId }, (tx) =>
        tx
          .insert(accountingConnections)
          .values({ organizationId: company.organizationId }),
      );
    await insert();

    // #then
    await expect(insert()).rejects.toThrow();
  });

  it("refuses a company admin who isn't staff, for their own company and any other", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    const { companyA, companyB } = fixture;
    const routes: ["GET" | "POST" | "PUT", string][] = [
      ["GET", ""],
      ["POST", "/connect-link"],
      ["GET", "/organizations"],
      ["POST", "/organization"],
      ["GET", "/accounts"],
      ["PUT", "/mapping"],
      ["POST", "/disconnect"],
    ];

    // #when
    const statuses = await Promise.all(
      [companyA, companyB].flatMap((company) =>
        routes.map(async ([method, suffix]) => {
          const reply = await staffCall(
            companyA.admin,
            method,
            zohoPath(company, suffix),
            method === "GET" ? undefined : {},
          );
          return reply.status;
        }),
      ),
    );

    // #then
    expect(new Set(statuses)).toEqual(new Set([403]));
  });

  it("shows and changes only the company in the path", async () => {
    // #given
    const { companyA, companyB } = await createIsolationFixture(db);
    await addCategories(companyA, ["Fuel"]);
    const [companyBCategory] = await addCategories(companyB, [
      "Company B secret category",
    ]);
    await connectWithOrganization(companyA);
    await connectWithOrganization(companyB);
    const companyBConnection = await latestConnection(companyB);

    // #when
    const shown = await staffCall(opsAdmin, "GET", zohoPath(companyA));
    const crossMapping = await staffCall(
      opsAdmin,
      "PUT",
      zohoPath(companyA, "/mapping"),
      {
        categoryAccounts: {
          [must(companyBCategory, "category")]: "acc-travel",
        },
        paidThroughAccountId: "acc-wallet",
        defaultAccountId: "acc-fees",
      },
    );
    await staffCall(opsAdmin, "POST", zohoPath(companyA, "/disconnect"));

    // #then
    expect(shown.text).not.toContain(companyBConnection.id);
    expect(shown.text).not.toContain("Company B secret category");
    expect(crossMapping.status).toBe(400);
    expect(await latestConnection(companyB)).toEqual(companyBConnection);
  });

  it("is a 404 for an unknown or malformed company", async () => {
    // #when
    const replies = await Promise.all(
      [randomUUID(), "not-a-company"].map((id) =>
        staffCall(opsAdmin, "GET", `/internal/companies/${id}/zoho`),
      ),
    );

    // #then
    expect(replies.map(({ status: code }) => code)).toEqual([404, 404]);
  });
});
