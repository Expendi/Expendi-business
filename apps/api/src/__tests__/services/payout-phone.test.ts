import { randomInt } from "node:crypto";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { DatabaseService } from "../../db/client.js";
import { users } from "../../db/schema/index.js";
import { withScope } from "../../db/scope.js";
import {
  PayoutPhoneNotConfirmed,
  requireConfirmedPayoutPhone,
} from "../../services/phone-verification/payout-phone.js";
import { createUser } from "../helpers/db.js";
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

const check = (userId: string) =>
  runtime.runPromiseExit(
    withScope({}, (tx) => requireConfirmedPayoutPhone(tx, userId)),
  );

describe("requireConfirmedPayoutPhone", () => {
  it("returns the user's confirmed number", async () => {
    // #given
    const user = await createUser(db);
    const phone = `+2547${String(randomInt(0, 100_000_000)).padStart(8, "0")}`;
    await db
      .update(users)
      .set({ phone, phoneVerifiedAt: new Date() })
      .where(eq(users.id, user.id));

    // #when
    const exit = await check(user.id);

    // #then
    expect(exit).toEqual(Exit.succeed(phone));
  });

  it("refuses someone who hasn't confirmed a number", async () => {
    // #given
    const user = await createUser(db);

    // #when
    const exit = await check(user.id);

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect(failure).toBeInstanceOf(PayoutPhoneNotConfirmed);
    expect(failure).toMatchObject({ userId: user.id });
  });
});
