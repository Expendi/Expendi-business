import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewUser } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { randomEmail } from "../helpers/db.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

describe("users constraints", () => {
  it("accepts a user with a lowercased email and no payout phone yet", async () => {
    // #given
    const user: NewUser = { email: randomEmail() };

    // #when
    const inserted = await db.insert(users).values(user).returning();

    // #then
    expect(inserted).toMatchObject([
      { email: user.email, phone: null, phoneVerifiedAt: null },
    ]);
  });

  it.each<[string, NewUser]>([
    ["a mixed-case email", { email: "Jane.Doe@Example.com" }],
    [
      "a phone without a verification time",
      { email: randomEmail(), phone: "+254712345678" },
    ],
    [
      "a verification time without a phone",
      { email: randomEmail(), phoneVerifiedAt: new Date() },
    ],
  ])("rejects %s", async (_label, user) => {
    // #when
    const attempt = db.insert(users).values(user);

    // #then
    await expect(attempt).rejects.toMatchObject({ cause: { code: "23514" } });
  });
});
