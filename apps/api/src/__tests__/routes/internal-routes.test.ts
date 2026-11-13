import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { reachableModules } from "../helpers/module-graph.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createNonStaffLogin, createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

interface Endpoint {
  readonly method: string;
  readonly path: string;
  readonly handlerNames: readonly string[];
}

/** Non-GET routes an ops viewer may call: recording their own sign-in. */
const OPEN_TO_VIEWERS = new Set(["POST /internal/session"]);

const READ_METHODS = new Set(["GET", "HEAD"]);

/**
 * Every route the app registers under `/internal` (spec §6.15), so these
 * rules cover each endpoint T24, T27 and T30 add without being edited.
 */
function internalEndpoints(app: App): Endpoint[] {
  const byRoute = new Map<string, Endpoint>();
  for (const route of app.routes) {
    // `use()` middleware is registered as method ALL on a wildcard path.
    if (!route.path.startsWith("/internal/") || route.path.endsWith("*")) {
      continue;
    }
    const method = route.method === "ALL" ? "POST" : route.method;
    const key = `${method} ${route.path}`;
    const existing = byRoute.get(key);
    byRoute.set(key, {
      method,
      path: route.path,
      handlerNames: [...(existing?.handlerNames ?? []), route.handler.name],
    });
  }
  return [...byRoute.values()];
}

function concretePath(path: string): string {
  return path.replace(/:[^/]+/g, randomUUID());
}

/**
 * Staff never move a company's money (spec §6.15): no internal route may
 * create, approve, fund, send or retry a payout, or touch withdrawals.
 * Resolving, re-fetching and pausing are allowed.
 */
function movesMoney(endpoint: Endpoint): boolean {
  const words = [endpoint.path, ...endpoint.handlerNames].map((word) =>
    word.toLowerCase(),
  );
  const isWrite = !READ_METHODS.has(endpoint.method);
  return words.some(
    (word) =>
      word.includes("withdraw") ||
      word.includes("approv") ||
      (word.includes("payout") && word.includes("create")) ||
      (isWrite && /\/payouts?$/.test(word)) ||
      /(^|[^a-z])(pay|fund|send|transfer|retry)([^a-z]|$)/.test(word),
  );
}

let runtime: AppRuntime;
let app: App;
let owner: pg.Pool;
let viewer: TestStaff;
let endpoints: Endpoint[];

beforeAll(async () => {
  runtime = makeTestRuntime();
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  viewer = await createStaff(owner, { role: "ops_viewer" });
  endpoints = internalEndpoints(app);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

async function call(
  endpoint: Endpoint,
  headers: Record<string, string>,
): Promise<Response> {
  return app.request(concretePath(endpoint.path), {
    method: endpoint.method,
    headers: { ...headers, "content-type": "application/json" },
    body: READ_METHODS.has(endpoint.method) ? undefined : "{}",
  });
}

describe("internal routes", () => {
  it("finds the routes, actions included", () => {
    // #then
    expect(endpoints.map(({ method, path }) => `${method} ${path}`)).toEqual(
      expect.arrayContaining([
        "GET /internal/me",
        "POST /internal/session",
        "GET /internal/audit",
        "GET /internal/alerts",
        "GET /internal/health",
        "GET /internal/companies",
        "GET /internal/companies/:organizationId",
        "GET /internal/payouts",
        "GET /internal/payouts/:payoutId",
        "POST /internal/payouts/:payoutId/refetch",
        "POST /internal/payouts/:payoutId/resolve/prepare",
        "POST /internal/payouts/:payoutId/resolve/confirm",
        "GET /internal/intent-quotes",
        "GET /internal/intent-quotes/:quoteId",
        "GET /internal/intent-quotes/:quoteId/evidence",
        "POST /internal/intent-quotes/:quoteId/resolve/prepare",
        "POST /internal/intent-quotes/:quoteId/resolve/confirm",
        "GET /internal/controls",
        "POST /internal/controls/pause/prepare",
        "POST /internal/controls/pause/confirm",
        "POST /internal/controls/unpause/prepare",
        "POST /internal/controls/unpause/confirm",
        "GET /internal/companies/:organizationId/zoho/syncs",
        "POST /internal/companies/:organizationId/zoho/syncs/:syncId/requeue",
        "GET /internal/companies/:organizationId/card-simulations",
        "POST /internal/companies/:organizationId/card-simulations",
      ]),
    );
  });

  it("refuses every route without a token", async () => {
    // #when
    const statuses = await Promise.all(
      endpoints.map(async (endpoint) => [
        `${endpoint.method} ${endpoint.path}`,
        (await call(endpoint, {})).status,
      ]),
    );

    // #then
    expect(statuses).toEqual(
      endpoints.map(({ method, path }) => [`${method} ${path}`, 401]),
    );
  });

  it("refuses every route to an email that isn't on the staff list", async () => {
    // #given
    const login = createNonStaffLogin();

    // #when
    const statuses = await Promise.all(
      endpoints.map(async (endpoint) => [
        `${endpoint.method} ${endpoint.path}`,
        (await call(endpoint, bearer(login.privyUserId))).status,
      ]),
    );

    // #then
    expect(statuses).toEqual(
      endpoints.map(({ method, path }) => [`${method} ${path}`, 403]),
    );
  });

  it("refuses an ops viewer on every action", async () => {
    // #given
    const actions = endpoints.filter(
      ({ method, path }) =>
        !READ_METHODS.has(method) && !OPEN_TO_VIEWERS.has(`${method} ${path}`),
    );
    expect(actions.length).toBeGreaterThan(0);

    // #when
    const refusals = await Promise.all(
      actions.map(async (endpoint) => {
        const response = await call(endpoint, bearer(viewer.privyUserId));
        const body = (await response.json()) as { error?: { _tag: string } };
        return [
          `${endpoint.method} ${endpoint.path}`,
          response.status,
          body.error?._tag,
        ];
      }),
    );

    // #then
    expect(refusals).toEqual(
      actions.map(({ method, path }) => [
        `${method} ${path}`,
        403,
        "Forbidden",
      ]),
    );
  });

  it("has no route that writes to the audit log", () => {
    // #when
    const auditWrites = endpoints
      .filter(
        ({ method, path }) =>
          path.startsWith("/internal/audit") && !READ_METHODS.has(method),
      )
      .map(({ method, path }) => `${method} ${path}`);

    // #then
    expect(auditWrites).toEqual([]);
  });

  it("has no route that creates, approves or sends a payout or withdrawal", () => {
    // #when
    const moneyMoving = endpoints
      .filter(movesMoney)
      .map(({ method, path }) => `${method} ${path}`);

    // #then
    expect(moneyMoving).toEqual([]);
  });
});

/** Modules that create, approve, fund, send or retry a payout or withdrawal. */
const MONEY_MOVING_MODULES = [
  /^services\/payout\/(approve|fund|prepare|retry|onchain|payout-service|pretium-fund)\.ts$/,
  /^services\/withdrawal\//,
  /^services\/wallet\/privy-wallets\.ts$/,
];

/**
 * Privy's send, Paycrest's order creation, and Pretium's pay and refund
 * (Pretium is told to pay, or to refund, after the USDC is already sent).
 */
const MONEY_MOVING_CALL = /\.(sendUsdc|createOrder|pay|refund)\s*\(/;

/**
 * Whether `source` calls money-moving code. Comment lines are left out,
 * since they may name a call (e.g. the Gateway's `refund()`) without
 * making it.
 */
const callsMoneyMovingCode = (source: string): boolean =>
  source
    .split("\n")
    .some(
      (line) =>
        !/^\s*(\/\/|\/\*|\*)/.test(line) && MONEY_MOVING_CALL.test(line),
    );

const isMoneyMoving = (module: string) =>
  MONEY_MOVING_MODULES.some((pattern) => pattern.test(module));

/**
 * Whatever a route is named, it can only run what `/internal` imports. This
 * follows every value import from the internal routes, so a route that
 * could create, approve, fund or retry a payout or withdrawal fails here.
 */
describe("the code behind the internal routes", () => {
  const modules = reachableModules("routes/internal/index.ts");

  it("reaches the services the routes use", () => {
    // #then
    expect([...modules.keys()]).toEqual(
      expect.arrayContaining([
        "routes/internal/payouts.ts",
        "services/staff/resolve.ts",
        "services/payout/sync.ts",
        "services/payout/pretium-sync.ts",
        "services/staff/intent-quote-resolve.ts",
        "services/intents/quote-settle.ts",
        "routes/internal/card-simulations.ts",
        "services/card-simulations/simulate.ts",
        "services/card-simulations/lithic-simulator.ts",
      ]),
    );
  });

  it("would see money-moving code if a route imported it", () => {
    // #when
    const fromThePayoutEngine = reachableModules(
      "services/payout/payout-service.ts",
    );

    // #then
    expect([...fromThePayoutEngine.keys()].filter(isMoneyMoving)).toEqual(
      expect.arrayContaining([
        "services/payout/fund.ts",
        "services/payout/pretium-fund.ts",
      ]),
    );
    expect(
      ["services/payout/fund.ts", "services/payout/pretium-fund.ts"].filter(
        (module) =>
          !callsMoneyMovingCode(fromThePayoutEngine.get(module) ?? ""),
      ),
    ).toEqual([]);
  });

  it("never reaches code that creates, approves, funds, sends or retries a payout or withdrawal", () => {
    // #then
    expect([...modules.keys()].filter(isMoneyMoving)).toEqual([]);
  });

  it("never calls Privy's send, Paycrest's order creation or Pretium's pay or refund", () => {
    // #when
    const callers = [...modules]
      .filter(([, source]) => callsMoneyMovingCode(source))
      .map(([module]) => module);

    // #then
    expect(callers).toEqual([]);
  });
});

describe("movesMoney", () => {
  const endpoint = (method: string, path: string): Endpoint => ({
    method,
    path,
    handlerNames: [""],
  });

  it.each([
    ["POST", "/internal/payouts"],
    ["PUT", "/internal/companies/:organizationId/payouts"],
    ["POST", "/internal/payouts/create"],
    ["POST", "/internal/claims/:claimId/approve"],
    ["POST", "/internal/payouts/:payoutId/retry"],
    ["POST", "/internal/payroll-runs/:runId/pay"],
    ["POST", "/internal/companies/:organizationId/withdrawals"],
    ["GET", "/internal/withdrawal-addresses"],
    ["POST", "/internal/wallets/:walletId/fund"],
  ])("flags %s %s", (method, path) => {
    // #then
    expect(movesMoney(endpoint(method, path))).toBe(true);
  });

  it("flags a handler named for creating a payout", () => {
    // #then
    expect(
      movesMoney({
        method: "POST",
        path: "/internal/companies/:organizationId/run",
        handlerNames: ["createPayoutForClaim"],
      }),
    ).toBe(true);
  });

  it.each([
    ["GET", "/internal/payouts"],
    ["GET", "/internal/payouts/:payoutId"],
    ["POST", "/internal/payouts/:payoutId/resolve"],
    ["POST", "/internal/payouts/:payoutId/refetch"],
    ["POST", "/internal/payouts/pause"],
    ["POST", "/internal/companies/:organizationId/pause-payouts"],
    ["GET", "/internal/payroll-runs"],
    ["POST", "/internal/session"],
  ])("allows %s %s", (method, path) => {
    // #then
    expect(movesMoney(endpoint(method, path))).toBe(false);
  });
});
