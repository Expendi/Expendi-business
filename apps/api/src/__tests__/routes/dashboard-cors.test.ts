import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { createCompany, createUser } from "../helpers/db.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

const DASHBOARD_ORIGIN = "https://business.expendi.test";
const ADMIN_APP_ORIGIN = "https://ops.expendi.test";

let runtime: AppRuntime;
let db: Database;
let app: App;

beforeAll(async () => {
  runtime = makeTestRuntime(
    {},
    {
      DASHBOARD_ORIGINS: `http://localhost:3002, ${DASHBOARD_ORIGIN}`,
      ADMIN_APP_ORIGINS: ADMIN_APP_ORIGIN,
    },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

/** What a browser sends before a bearer-token request: no token of its own. */
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

function allowedOrigin(response: Response): string | null {
  return response.headers.get("access-control-allow-origin");
}

const customerPaths = (): string[] => [
  "/me",
  "/me/approval-passkey/options",
  "/organizations",
  `/organizations/${randomUUID()}`,
  `/organizations/${randomUUID()}/members`,
];

describe("CORS for the web dashboard on customer routes", () => {
  it.each(customerPaths())(
    "answers a preflight to %s from the dashboard's origin without a token",
    async (path) => {
      // #when
      const response = await preflight(path, DASHBOARD_ORIGIN);

      // #then
      expect(response.status).toBe(204);
      expect(allowedOrigin(response)).toBe(DASHBOARD_ORIGIN);
      expect(response.headers.get("access-control-allow-headers")).toBe(
        "Authorization,Content-Type",
      );
      expect(response.headers.get("access-control-allow-methods")).toBe(
        "GET,POST,PUT,PATCH,DELETE",
      );
    },
  );

  it("allows every origin listed in DASHBOARD_ORIGINS", async () => {
    // #when
    const response = await preflight("/me", "http://localhost:3002");

    // #then
    expect(allowedOrigin(response)).toBe("http://localhost:3002");
  });

  it.each([
    ["another site", "https://evil.example"],
    [
      "a look-alike of the dashboard",
      "https://business.expendi.test.evil.example",
    ],
    ["the admin app", ADMIN_APP_ORIGIN],
  ])("gives %s no CORS access", async (_label, origin) => {
    // #when
    const responses = await Promise.all(
      customerPaths().map((path) => preflight(path, origin)),
    );

    // #then
    for (const response of responses) {
      expect(allowedOrigin(response)).toBeNull();
    }
  });

  it("answers a signed-in request from the dashboard with CORS headers", async () => {
    // #given
    const user = await createUser(db);

    // #when
    const response = await app.request("/me", {
      headers: { ...bearer(user.privyUserId), origin: DASHBOARD_ORIGIN },
    });

    // #then
    expect(response.status).toBe(200);
    expect(allowedOrigin(response)).toBe(DASHBOARD_ORIGIN);
  });

  it("gives another origin's signed-in request no CORS headers", async () => {
    // #given
    const user = await createUser(db);

    // #when
    const response = await app.request("/me", {
      headers: { ...bearer(user.privyUserId), origin: "https://evil.example" },
    });

    // #then
    expect(allowedOrigin(response)).toBeNull();
  });

  it("lets the dashboard read a refusal", async () => {
    // #given
    const outsider = await createUser(db);
    const company = await createCompany(db);

    // #when
    const noToken = await app.request("/me", {
      headers: { origin: DASHBOARD_ORIGIN },
    });
    const notAMember = await app.request(
      `/organizations/${company.organizationId}/members`,
      {
        headers: { ...bearer(outsider.privyUserId), origin: DASHBOARD_ORIGIN },
      },
    );

    // #then
    expect(noToken.status).toBe(401);
    expect(allowedOrigin(noToken)).toBe(DASHBOARD_ORIGIN);
    expect(notAMember.status).toBe(403);
    expect(allowedOrigin(notAMember)).toBe(DASHBOARD_ORIGIN);
  });
});

describe("CORS outside the customer routes", () => {
  it("leaves /internal to the admin app's origins", async () => {
    // #when
    const fromDashboard = await preflight(
      "/internal/session",
      DASHBOARD_ORIGIN,
    );
    const fromAdminApp = await preflight("/internal/session", ADMIN_APP_ORIGIN);

    // #then
    expect(allowedOrigin(fromDashboard)).toBeNull();
    expect(allowedOrigin(fromAdminApp)).toBe(ADMIN_APP_ORIGIN);
  });

  it.each([
    "/webhooks/paycrest",
    "/webhooks/alchemy",
    "/integrations/zoho/connect",
    "/health",
  ])("gives %s no CORS, even for the dashboard", async (path) => {
    // #when
    const response = await preflight(path, DASHBOARD_ORIGIN);

    // #then
    expect(allowedOrigin(response)).toBeNull();
  });
});

describe("without DASHBOARD_ORIGINS", () => {
  it("gives no browser origin CORS access to customer routes", async () => {
    // #given
    const unconfigured = makeTestRuntime({}, { DASHBOARD_ORIGINS: undefined });
    try {
      const unconfiguredApp = createApp({ runtime: unconfigured });

      // #when
      const response = await unconfiguredApp.request("/me", {
        method: "OPTIONS",
        headers: {
          origin: DASHBOARD_ORIGIN,
          "access-control-request-method": "GET",
        },
      });

      // #then
      expect(allowedOrigin(response)).toBeNull();
    } finally {
      await unconfigured.dispose();
    }
  });
});
