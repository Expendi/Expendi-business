import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Customer } from "@expendi-business/shared";
import { customerSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;
let company: TestCompany;
let employee: TestUser;
let accountant: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  accountant = await createUser(db);
  await addMember(db, company, employee);
  await addMember(db, company, accountant, { role: "accountant" });
});

const base = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/customers`;

const send = (
  method: string,
  path: string,
  body?: unknown,
  user: Pick<TestUser, "privyUserId"> = company.admin,
) => sendJson(app, path, user, { method, body });

async function addCustomer(
  fields: Record<string, unknown> = {},
): Promise<Customer> {
  const response = await send("POST", base(), {
    name: "Safaricom PLC",
    email: "ap@safaricom.test",
    ...fields,
  });
  expect(response.status).toBe(201);
  const { data } = (await response.json()) as { data: unknown };
  return customerSchema.parse(data);
}

describe("customers", () => {
  it("creates a customer and lists it", async () => {
    // #when
    const customer = await addCustomer({
      address: "Waiyaki Way, Nairobi",
      taxId: "P051234567X",
    });
    const list = await send("GET", base());

    // #then
    expect(customer).toMatchObject({
      name: "Safaricom PLC",
      email: "ap@safaricom.test",
      address: "Waiyaki Way, Nairobi",
      taxId: "P051234567X",
      archived: false,
    });
    expect(await list.json()).toMatchObject({
      data: { customers: [{ id: customer.id }] },
    });
  });

  it("stores an empty address or tax ID as null", async () => {
    // #given
    const created = await addCustomer({ address: "", taxId: "" });
    const withValues = await addCustomer({
      name: "Other",
      address: "Somewhere",
      taxId: "P0000",
    });

    // #when
    const cleared = await send("PATCH", `${base()}/${withValues.id}`, {
      address: "",
      taxId: "",
    });

    // #then
    expect(created).toMatchObject({ address: null, taxId: null });
    expect(await cleared.json()).toMatchObject({
      data: { address: null, taxId: null, name: "Other" },
    });
  });

  it("archives and restores a customer, hiding archived ones by default", async () => {
    // #given
    const customer = await addCustomer();

    // #when
    const archived = await send("PATCH", `${base()}/${customer.id}`, {
      archived: true,
    });
    const hidden = await send("GET", base());
    const shown = await send("GET", `${base()}?includeArchived=true`);
    const restored = await send("PATCH", `${base()}/${customer.id}`, {
      archived: false,
    });

    // #then
    expect(await archived.json()).toMatchObject({ data: { archived: true } });
    expect(await hidden.json()).toMatchObject({ data: { customers: [] } });
    expect(await shown.json()).toMatchObject({
      data: { customers: [{ id: customer.id, archived: true }] },
    });
    expect(await restored.json()).toMatchObject({ data: { archived: false } });
  });

  it("rejects an invalid email", async () => {
    // #when
    const response = await send("POST", base(), {
      name: "Bad",
      email: "not-an-email",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("lets an accountant read but not write, and keeps employees out", async () => {
    // #given
    const customer = await addCustomer();

    // #when
    const accountantRead = await send("GET", base(), undefined, accountant);
    const accountantWrite = await send(
      "POST",
      base(),
      { name: "X", email: "x@x.test" },
      accountant,
    );
    const employeeRead = await send("GET", base(), undefined, employee);
    const employeeWrite = await send(
      "PATCH",
      `${base()}/${customer.id}`,
      { name: "Y" },
      employee,
    );

    // #then
    expect(accountantRead.status).toBe(200);
    expect(accountantWrite.status).toBe(403);
    expect(employeeRead.status).toBe(403);
    expect(employeeWrite.status).toBe(403);
  });

  it("does not show or change another company's customer", async () => {
    // #given
    const other = await createCompany(db);
    const customer = await addCustomer();

    // #when
    const list = await send("GET", base(other), undefined, other.admin);
    const patch = await send(
      "PATCH",
      `${base(other)}/${customer.id}`,
      { name: "Hijacked" },
      other.admin,
    );

    // #then
    expect(await list.json()).toMatchObject({ data: { customers: [] } });
    expect(patch.status).toBe(404);
  });

  it("refuses a company the caller doesn't belong to", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/customers`,
    }));
  });
});
