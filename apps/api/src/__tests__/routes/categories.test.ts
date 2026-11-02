import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ManagedCategory } from "@expendi-business/shared";
import {
  categoriesResponseSchema,
  claimDetailSchema,
  managedCategorySchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { categories } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import { insertPayee, shiftDays } from "../helpers/bills.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { addEmployeePayee } from "../helpers/payroll.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

const insertCategory = (
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
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE });
  fixture = await createIsolationFixture(db);
  await insertCategory(fixture.companyA, "Fuel");
  await insertCategory(fixture.companyA, "airtime");
  await insertCategory(fixture.companyA, "Archived thing", true);
  await insertCategory(fixture.companyB, "Company B only");
});

afterAll(async () => {
  await owner.end();
  await runtime.dispose();
});

beforeEach(() => {
  storage.state.reset();
});

const categoriesPath = (organizationId: string, rest = "") =>
  `/organizations/${organizationId}/categories${rest}`;

const listCategories = (organizationId: string, privyUserId: string) =>
  app.request(categoriesPath(organizationId), {
    headers: bearer(privyUserId),
  });

async function dataOf(response: Response): Promise<unknown> {
  const { data } = (await response.json()) as { data: unknown };
  return data;
}

async function errorOf(response: Response): Promise<string> {
  const { error } = (await response.json()) as { error: { message: string } };
  return error.message;
}

async function listed(
  company: TestCompany,
  query = "",
  user: Pick<TestUser, "privyUserId"> = company.admin,
): Promise<string[]> {
  const response = await sendJson(
    app,
    categoriesPath(company.organizationId, query),
    user,
  );
  expect(response.status).toBe(200);
  return categoriesResponseSchema
    .parse(await dataOf(response))
    .map(({ name }) => name);
}

async function managed(response: Response): Promise<ManagedCategory> {
  if (response.status !== 200 && response.status !== 201) {
    throw new Error(`answered ${response.status}: ${await response.text()}`);
  }
  return managedCategorySchema.parse(await dataOf(response));
}

const addViaApi = (
  company: TestCompany,
  body: unknown,
  user: Pick<TestUser, "privyUserId"> = company.admin,
) =>
  sendJson(app, categoriesPath(company.organizationId), user, {
    method: "POST",
    body,
  });

const editViaApi = (
  company: TestCompany,
  categoryId: string,
  body: unknown,
  user: Pick<TestUser, "privyUserId"> = company.admin,
) =>
  sendJson(
    app,
    categoriesPath(company.organizationId, `/${categoryId}`),
    user,
    {
      method: "PATCH",
      body,
    },
  );

const archiveViaApi = (
  company: TestCompany,
  categoryId: string,
  action: "archive" | "restore" = "archive",
  user: Pick<TestUser, "privyUserId"> = company.admin,
) =>
  sendJson(
    app,
    categoriesPath(company.organizationId, `/${categoryId}/${action}`),
    user,
    { method: "POST" },
  );

async function categoryAudit(categoryId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    organization_id: string;
    before: unknown;
    after: unknown;
  }>(
    `SELECT action, actor_id, organization_id, before, after FROM audit_log
     WHERE entity_type = 'category' AND entity_id = $1
     ORDER BY occurred_at, action`,
    [categoryId],
  );
  return rows;
}

/** As the company sees it: the table is FORCE row-level security. */
async function categoryRow(company: TestCompany, categoryId: string) {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({ name: categories.name, archived: categories.archived })
        .from(categories)
        .where(eq(categories.id, categoryId)),
  );
  return row;
}

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

  it("lists only the archived ones with archived=true, for admins and accountants", async () => {
    // #given
    const { companyA } = fixture;
    const accountant = await createUser(db);
    await addMember(db, companyA, accountant, { role: "accountant" });

    // #when
    const asAdmin = await listed(companyA, "?archived=true");
    const asAccountant = await listed(companyA, "?archived=true", accountant);

    // #then
    expect(asAdmin).toEqual(["Archived thing"]);
    expect(asAccountant).toEqual(asAdmin);
  });

  it("refuses the archived list to an employee", async () => {
    // #given
    const { companyA } = fixture;
    const employee = await createUser(db);
    await addMember(db, companyA, employee);

    // #when
    const response = await sendJson(
      app,
      categoriesPath(companyA.organizationId, "?archived=true"),
      employee,
    );

    // #then
    expect(response.status).toBe(403);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: categoriesPath(organizationId),
    }));
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: categoriesPath(organizationId, "?archived=true"),
    }));
  });
});

describe("POST /organizations/:organizationId/categories", () => {
  it("adds a category for new spending, audited in the company", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const created = await managed(
      await addViaApi(company, { name: "  Courier  ", etimsNotRequired: true }),
    );

    // #then
    expect(created).toMatchObject({
      name: "Courier",
      etimsNotRequired: true,
      archived: false,
    });
    expect(await listed(company)).toEqual(["Courier"]);
    expect(await categoryAudit(created.id)).toEqual([
      {
        action: "category.created",
        actor_id: company.admin.id,
        organization_id: company.organizationId,
        before: null,
        after: { name: "Courier", etimsNotRequired: true },
      },
    ]);
  });

  it("refuses a name already in use, in any case, and audits nothing", async () => {
    // #given
    const company = await createCompany(db);
    await addCategory(db, company, "Transport");

    // #when
    const response = await addViaApi(company, { name: "TRANSPORT" });

    // #then
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(
      "There's already a category called TRANSPORT.",
    );
    expect(await listed(company)).toEqual(["Transport"]);
  });

  it("refuses a blank name", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const response = await addViaApi(company, { name: "   " });

    // #then
    expect(response.status).toBe(400);
    expect(await errorOf(response)).toBe("Name the category, e.g. Transport.");
  });

  it("refuses employees and accountants", async () => {
    // #given
    const company = await createCompany(db);
    const [employee, accountant] = await Promise.all([
      createUser(db),
      createUser(db),
    ]);
    await addMember(db, company, employee);
    await addMember(db, company, accountant, { role: "accountant" });

    // #when
    const answers = await Promise.all(
      [employee, accountant].map(
        async (user) =>
          (await addViaApi(company, { name: "Mine" }, user)).status,
      ),
    );

    // #then
    expect(answers).toEqual([403, 403]);
    expect(await listed(company)).toEqual([]);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: categoriesPath(organizationId),
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: `Isolated ${randomUUID()}` }),
      },
    }));
  });
});

describe("PATCH /organizations/:organizationId/categories/:categoryId", () => {
  it("renames a category and marks it eTIMS-exempt, audited with before and after", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Flights");

    // #when
    const updated = await managed(
      await editViaApi(company, categoryId, {
        name: "Air tickets",
        etimsNotRequired: true,
      }),
    );

    // #then
    expect(updated).toEqual({
      id: categoryId,
      name: "Air tickets",
      etimsNotRequired: true,
      archived: false,
    });
    expect(await categoryAudit(categoryId)).toEqual([
      {
        action: "category.updated",
        actor_id: company.admin.id,
        organization_id: company.organizationId,
        before: { name: "Flights", etimsNotRequired: false },
        after: { name: "Air tickets", etimsNotRequired: true },
      },
    ]);
  });

  it("audits nothing when nothing changes", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Fuel");

    // #when
    const response = await editViaApi(company, categoryId, { name: "Fuel" });

    // #then
    expect(response.status).toBe(200);
    expect(await categoryAudit(categoryId)).toEqual([]);
  });

  it("refuses a name another category has, and an archived category", async () => {
    // #given
    const company = await createCompany(db);
    await addCategory(db, company, "Fuel");
    const transportId = await addCategory(db, company, "Transport");
    const oldId = await addCategory(db, company, "Old", { archived: true });

    // #when
    const taken = await editViaApi(company, transportId, { name: "fuel" });
    const archived = await editViaApi(company, oldId, { name: "New" });

    // #then
    expect([taken.status, archived.status]).toEqual([409, 409]);
    expect(await categoryRow(company, transportId)).toEqual({
      name: "Transport",
      archived: false,
    });
    expect(await categoryRow(company, oldId)).toEqual({
      name: "Old",
      archived: true,
    });
    expect(await categoryAudit(transportId)).toEqual([]);
  });

  it("can't reach another company's category", async () => {
    // #given
    const company = await createCompany(db);
    const other = await createCompany(db);
    const theirs = await addCategory(db, other, "Theirs");

    // #when
    const response = await editViaApi(company, theirs, { name: "Mine now" });

    // #then
    expect(response.status).toBe(404);
    expect(await categoryRow(other, theirs)).toEqual({
      name: "Theirs",
      archived: false,
    });
  });

  it("refuses employees and accountants", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Fuel");
    const [employee, accountant] = await Promise.all([
      createUser(db),
      createUser(db),
    ]);
    await addMember(db, company, employee);
    await addMember(db, company, accountant, { role: "accountant" });

    // #when
    const answers = await Promise.all(
      [employee, accountant].map(
        async (user) =>
          (await editViaApi(company, categoryId, { name: "Petrol" }, user))
            .status,
      ),
    );

    // #then
    expect(answers).toEqual([403, 403]);
    expect(await categoryRow(company, categoryId)).toEqual({
      name: "Fuel",
      archived: false,
    });
  });

  it("is isolated between companies", async () => {
    const categoryOfB = await addCategory(db, fixture.companyB, "B's");
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: categoriesPath(organizationId, `/${categoryOfB}`),
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Taken over" }),
      },
    }));
  });
});

describe("archiving and restoring a category", () => {
  it("archives a category once, audited, and lists it with the archived ones", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Marketing");

    // #when
    const archived = await managed(await archiveViaApi(company, categoryId));
    const again = await managed(await archiveViaApi(company, categoryId));

    // #then
    expect(archived.archived).toBe(true);
    expect(again.archived).toBe(true);
    expect(await listed(company)).toEqual([]);
    expect(await listed(company, "?archived=true")).toEqual(["Marketing"]);
    expect(await categoryAudit(categoryId)).toEqual([
      {
        action: "category.archived",
        actor_id: company.admin.id,
        organization_id: company.organizationId,
        before: { name: "Marketing", archived: false },
        after: { name: "Marketing", archived: true },
      },
    ]);
  });

  it("restores an archived category to the list, audited", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Marketing", {
      archived: true,
    });

    // #when
    const restored = await managed(
      await archiveViaApi(company, categoryId, "restore"),
    );

    // #then
    expect(restored.archived).toBe(false);
    expect(await listed(company)).toEqual(["Marketing"]);
    expect(await categoryAudit(categoryId)).toMatchObject([
      {
        action: "category.restored",
        after: { name: "Marketing", archived: false },
      },
    ]);
  });

  it("won't restore a category whose name another one has taken meanwhile", async () => {
    // #given
    const company = await createCompany(db);
    const oldId = await addCategory(db, company, "Marketing", {
      archived: true,
    });
    await addCategory(db, company, "MARKETING");

    // #when
    const response = await archiveViaApi(company, oldId, "restore");

    // #then
    expect(response.status).toBe(409);
    expect(await errorOf(response)).toBe(
      "There's already a category called Marketing.",
    );
    expect(await categoryRow(company, oldId)).toEqual({
      name: "Marketing",
      archived: true,
    });
    expect(await categoryAudit(oldId)).toEqual([]);
  });

  it("refuses employees and accountants", async () => {
    // #given
    const company = await createCompany(db);
    const categoryId = await addCategory(db, company, "Fuel");
    const [employee, accountant] = await Promise.all([
      createUser(db),
      createUser(db),
    ]);
    await addMember(db, company, employee);
    await addMember(db, company, accountant, { role: "accountant" });

    // #when
    const answers = await Promise.all(
      [employee, accountant].map(
        async (user) =>
          (await archiveViaApi(company, categoryId, "archive", user)).status,
      ),
    );

    // #then
    expect(answers).toEqual([403, 403]);
    expect(await categoryRow(company, categoryId)).toEqual({
      name: "Fuel",
      archived: false,
    });
  });

  it("is isolated between companies", async () => {
    const categoryOfB = await addCategory(
      db,
      fixture.companyB,
      "B's to archive",
    );
    for (const action of ["archive", "restore"]) {
      await expectRouteIsolation(app, fixture, (organizationId) => ({
        path: categoriesPath(organizationId, `/${categoryOfB}/${action}`),
        init: { method: "POST" },
      }));
    }
  });
});

describe("an archived category and spending", () => {
  const PICK_A_CATEGORY = "Pick one of the company's categories.";

  it("can't be picked for any new spending, while spending that has it keeps it", async () => {
    // #given a category with a claim already in it, archived by the admin
    const company = await createCompany(db);
    const base = `/organizations/${company.organizationId}`;
    const categoryId = await addCategory(db, company, "Travel");
    const amina = await addEmployeePayee(db, company, "Amina");
    const supplierId = await insertPayee(db, company, { name: "Kenya Power" });
    const paidFrom = await sendJson(
      app,
      `${base}/paid-from-accounts`,
      company.admin,
      { method: "POST", body: { name: "KCB current account", kind: "bank" } },
    );
    const paidFromAccountId = (
      (await dataOf(paidFrom)) as { readonly id: string }
    ).id;
    const floatId = await runInScope(
      db,
      {
        organizationId: company.organizationId,
        userId: company.admin.id,
        role: "admin",
      },
      (tx) =>
        tx.execute<{ id: string }>(
          sql`INSERT INTO floats (organization_id, membership_id) VALUES (${company.organizationId}, ${amina.membershipId}) RETURNING id`,
        ),
    ).then(({ rows }) => rows[0]?.id ?? "");
    const photo = async (user: TestUser) =>
      (await uploadReceipt(app, storage, company, user)).receiptFileId;
    const earlier = await sendJson(app, `${base}/claims`, amina.user, {
      method: "POST",
      body: claimRequest({
        categoryId,
        receiptFileIds: [await photo(amina.user)],
      }),
    });
    expect(earlier.status).toBe(201);
    const earlierClaim = claimDetailSchema.parse(await dataOf(earlier));
    expect((await archiveViaApi(company, categoryId)).status).toBe(200);
    const today = nairobiDate(new Date());

    // #when every kind of new spending names it
    const attempts = {
      claim: await sendJson(app, `${base}/claims`, amina.user, {
        method: "POST",
        body: claimRequest({
          categoryId,
          receiptFileIds: [await photo(amina.user)],
        }),
      }),
      floatSpending: await sendJson(
        app,
        `${base}/floats/${floatId}/spending`,
        amina.user,
        {
          method: "POST",
          body: {
            merchant: "Naivas Supermarket",
            amountKes: "300",
            spentOn: shiftDays(today, -1),
            categoryId,
            description: "Printer paper",
            receiptFileIds: [await photo(amina.user)],
          },
        },
      ),
      companySpending: await sendJson(
        app,
        `${base}/company-spending`,
        company.admin,
        {
          method: "POST",
          body: {
            merchant: "Kenya Power",
            amountKes: "4,500.00",
            spentOn: shiftDays(today, -1),
            categoryId,
            description: "October electricity",
            paidFromAccountId,
            receiptFileIds: [await photo(company.admin)],
          },
        },
      ),
      bill: await sendJson(app, `${base}/bills`, company.admin, {
        method: "POST",
        body: {
          payeeId: supplierId,
          amountKes: "15,000.50",
          dueOn: shiftDays(today, 10),
          categoryId,
          reference: "INV-0042",
        },
      }),
      recurringItem: await sendJson(
        app,
        `${base}/recurring-items`,
        company.admin,
        {
          method: "POST",
          body: {
            payeeId: supplierId,
            amountKes: "45,000",
            schedule: "monthly",
            scheduleDay: 5,
            startsOn: shiftDays(today, 10),
            categoryId,
          },
        },
      ),
      salary: await sendJson(app, `${base}/salaries`, company.admin, {
        method: "POST",
        body: {
          payeeId: amina.payeeId,
          amountKes: "50,000",
          payDay: 28,
          startsOn: shiftDays(today, 40),
          categoryId,
        },
      }),
    };

    // #then each is refused for the category
    const answers = await Promise.all(
      Object.entries(attempts).map(async ([kind, response]) => [
        kind,
        response.status,
        await errorOf(response),
      ]),
    );
    expect(answers).toEqual(
      Object.keys(attempts).map((kind) => [kind, 400, PICK_A_CATEGORY]),
    );
    // and the earlier claim keeps it, even when edited
    const edited = await sendJson(
      app,
      `${base}/claims/${earlierClaim.id}`,
      amina.user,
      { method: "PATCH", body: { description: "Taxi to the airport" } },
    );
    expect(edited.status).toBe(200);
    expect(claimDetailSchema.parse(await dataOf(edited))).toMatchObject({
      category: { id: categoryId, name: "Travel" },
      description: "Taxi to the airport",
    });
  });
});

describe("categories table", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "categories");
  });

  it("refuses a second unarchived category with the same name in any case", async () => {
    // #given
    const company = await createCompany(db);
    await insertCategory(company, "Transport");

    // #when
    const attempt = insertCategory(company, "TRANSPORT");

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
    await insertCategory(company, "Transport");
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
    const sameCompany = insertCategory(company, "transport");
    const otherCompany = insertCategory(other, "Transport");

    // #then
    await expect(sameCompany).resolves.toBeDefined();
    await expect(otherCompany).resolves.toBeDefined();
  });
});
