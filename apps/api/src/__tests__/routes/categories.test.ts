import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { categories } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;

const addCategory = (
  company: TestCompany,
  name: string,
  archived = false,
): Promise<unknown> =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .insert(categories)
      .values({ organizationId: company.organizationId, name, archived }),
  );

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
  await addCategory(fixture.companyA, "Fuel");
  await addCategory(fixture.companyA, "airtime");
  await addCategory(fixture.companyA, "Archived thing", true);
  await addCategory(fixture.companyB, "Company B only");
});

afterAll(async () => {
  await runtime.dispose();
});

const listCategories = (organizationId: string, privyUserId: string) =>
  app.request(`/organizations/${organizationId}/categories`, {
    headers: bearer(privyUserId),
  });

describe("GET /organizations/:organizationId/categories", () => {
  it("lets an employee list the company's categories, by name, without archived ones", async () => {
    // #given
    const { companyA } = fixture;
    const employee = await createUser(db);
    await addMember(db, companyA, employee, { role: "employee" });

    // #when
    const response = await listCategories(
      companyA.organizationId,
      employee.privyUserId,
    );

    // #then
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: [
        { name: "airtime", etimsNotRequired: false },
        { name: "Fuel", etimsNotRequired: false },
      ],
    });
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/categories`,
    }));
  });
});

describe("categories table", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "categories");
  });

  it("refuses a second unarchived category with the same name in any case", async () => {
    // #given
    const company = await createCompany(db);
    await addCategory(company, "Transport");

    // #when
    const attempt = addCategory(company, "TRANSPORT");

    // #then
    await expect(attempt).rejects.toMatchObject({
      cause: { constraint: "categories_active_name_unique" },
    });
  });

  it("allows the name again once the first is archived, and in another company", async () => {
    // #given
    const [company, other] = await Promise.all([
      createCompany(db),
      createCompany(db),
    ]);
    await addCategory(company, "Transport");
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(categories)
        .set({ archived: true })
        .where(
          and(
            eq(categories.organizationId, company.organizationId),
            eq(categories.name, "Transport"),
          ),
        ),
    );

    // #when
    const sameCompany = addCategory(company, "transport");
    const otherCompany = addCategory(other, "Transport");

    // #then
    await expect(sameCompany).resolves.toBeDefined();
    await expect(otherCompany).resolves.toBeDefined();
  });
});
