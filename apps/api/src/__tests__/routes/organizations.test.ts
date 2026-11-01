import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await runtime.dispose();
});

async function getCompany(
  organizationId: string,
  user?: TestUser,
): Promise<Response> {
  return app.request(`/organizations/${organizationId}`, {
    headers: user ? bearer(user.privyUserId) : {},
  });
}

describe("GET /organizations/:organizationId", () => {
  it("returns the company and the caller's role to a member", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const response = await getCompany(companyA.organizationId, companyA.admin);

    // #then
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: { id: companyA.organizationId, name: companyA.name, role: "admin" },
    });
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}`,
    }));
  });

  it.each([
    ["an unknown company", randomUUID()],
    ["a malformed ID", "not-a-uuid"],
  ])("returns 403 for %s", async (_label, organizationId) => {
    // #given
    const { companyA } = fixture;

    // #when
    const response = await getCompany(organizationId, companyA.admin);

    // #then
    expect(response.status).toBe(403);
  });

  it.each(["invited", "removed"] as const)(
    "returns 403 to a member whose membership is %s",
    async (status) => {
      // #given
      const user = await createUser(db);
      await addMember(db, fixture.companyA, user, { status });

      // #when
      const response = await getCompany(fixture.companyA.organizationId, user);

      // #then
      expect(response.status).toBe(403);
    },
  );

  it("returns 401 without authentication", async () => {
    // #when
    const response = await getCompany(fixture.companyA.organizationId);

    // #then
    expect(response.status).toBe(401);
  });
});
