import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  claimDetailSchema,
  meResponseSchema,
  updateMeResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { createUser } from "../helpers/db.js";
import {
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let user: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({
    fileStorage: storage.layer,
    privyWallets: makeFakePrivyWallets().layer,
    paycrest: makeFakePaycrest().layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  user = await createUser(db);
});

function setName(
  who: Pick<TestUser, "privyUserId">,
  body: unknown,
): Promise<Response> {
  return sendJson(app, "/me", who, { method: "PATCH", body });
}

async function nameOf(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ fullName: users.fullName })
    .from(users)
    .where(eq(users.id, userId));
  return row?.fullName ?? null;
}

async function nameChanges(userId: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    organization_id: string | null;
    before: unknown;
    after: unknown;
  }>(
    "SELECT actor_type, actor_id, organization_id, before, after FROM audit_log WHERE action = 'user.name_changed' AND entity_type = 'user' AND entity_id = $1 ORDER BY occurred_at",
    [userId],
  );
  return rows;
}

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

describe("PATCH /me", () => {
  it.each<[string, Record<string, string>]>([
    ["no token", {}],
    ["an invalid token", { authorization: "Bearer not-a-real-token" }],
  ])("answers 401 with %s and changes nothing", async (_label, headers) => {
    // #when
    const response = await app.request("/me", {
      method: "PATCH",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ fullName: "Jane Wanjiku" }),
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("sets the caller's name and returns their details", async () => {
    // #when
    const response = await setName(user, { fullName: "Jane Wanjiku" });

    // #then
    expect(response.status).toBe(200);
    expect(updateMeResponseSchema.parse(await dataOf(response))).toEqual({
      id: user.id,
      email: user.email,
      phone: null,
      fullName: "Jane Wanjiku",
    });
  });

  it("shows the new name on GET /me", async () => {
    // #given
    await setName(user, { fullName: "Jane Wanjiku" });

    // #when
    const response = await sendJson(app, "/me", user);

    // #then
    expect(meResponseSchema.parse(await dataOf(response)).user.fullName).toBe(
      "Jane Wanjiku",
    );
  });

  it("stores the name trimmed, with single spaces and plain apostrophes", async () => {
    // #when
    await setName(user, { fullName: "  Wanjiru   O’Brien-Kamau " });

    // #then
    expect(await nameOf(user.id)).toBe("Wanjiru O'Brien-Kamau");
  });

  it.each([
    ["no name", {}],
    ["an empty name", { fullName: "   " }],
    ["a single letter", { fullName: "J" }],
    ["digits", { fullName: "Jane 007" }],
    ["a control character", { fullName: "Jane\u0007Wanjiku" }],
    ["a zero-width character", { fullName: "Jane​Wanjiku" }],
    ["a name over 100 characters", { fullName: "A".repeat(101) }],
  ])("refuses %s with 400 and keeps the name", async (_label, body) => {
    // #given
    await setName(user, { fullName: "Jane Wanjiku" });

    // #when
    const response = await setName(user, body);

    // #then
    expect({ status: response.status, name: await nameOf(user.id) }).toEqual({
      status: 400,
      name: "Jane Wanjiku",
    });
  });

  it("answers 400 to a body that isn't JSON", async () => {
    // #when
    const response = await app.request("/me", {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer test-token:${user.privyUserId}`,
      },
      body: "{",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("audits the change as the person's own, before and after", async () => {
    // #given
    await setName(user, { fullName: "Jane Wanjiku" });

    // #when
    await setName(user, { fullName: "Jane Wanjiku Kamau" });

    // #then
    expect(await nameChanges(user.id)).toEqual([
      {
        actor_type: "user",
        actor_id: user.id,
        organization_id: null,
        before: { fullName: null },
        after: { fullName: "Jane Wanjiku" },
      },
      {
        actor_type: "user",
        actor_id: user.id,
        organization_id: null,
        before: { fullName: "Jane Wanjiku" },
        after: { fullName: "Jane Wanjiku Kamau" },
      },
    ]);
  });

  it("records nothing when the name doesn't change", async () => {
    // #given
    await setName(user, { fullName: "Jane Wanjiku" });

    // #when
    const response = await setName(user, { fullName: " Jane  Wanjiku " });

    // #then
    expect({
      status: response.status,
      entries: (await nameChanges(user.id)).length,
    }).toEqual({ status: 200, entries: 1 });
  });

  it("changes only the caller's name", async () => {
    // #given
    const other = await createUser(db);
    await db
      .update(users)
      .set({ fullName: "Otieno Kamau" })
      .where(eq(users.id, other.id));

    // #when
    await setName(user, { fullName: "Jane Wanjiku" });

    // #then
    expect({
      other: await nameOf(other.id),
      audited: await nameChanges(other.id),
    }).toEqual({ other: "Otieno Kamau", audited: [] });
  });

  it("lets a company's creator Approve & pay their own claim once they've named themselves", async () => {
    // #given a creator with a confirmed payout number but no name yet
    const paying = await createPayingCompany(runtime, db);
    const creator = paying.company.admin;
    await db
      .update(users)
      .set({
        phone: `+2547${randomInt(10_000_000, 100_000_000)}`,
        phoneVerifiedAt: new Date(),
      })
      .where(eq(users.id, creator.id));
    const categoryId = await addCategory(db, paying.company, "Meals");
    const upload = await uploadReceipt(app, storage, paying.company, creator);
    const claimsPath = `/organizations/${paying.company.organizationId}/claims`;
    const submitted = await sendJson(app, claimsPath, creator, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId,
      }),
    });
    const claim = claimDetailSchema.parse(await dataOf(submitted));
    const prepare = () =>
      sendJson(app, `${claimsPath}/approval`, creator, {
        method: "POST",
        body: { claimIds: [claim.id] },
      });
    const refused = (await prepare()).status;

    // #when
    await setName(creator, { fullName: "Achieng Odhiambo" });
    const prepared = (await prepare()).status;

    // #then
    expect({ refused, prepared }).toEqual({ refused: 409, prepared: 201 });
  });
});
