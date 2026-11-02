import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import { DatabaseService } from "../../db/client.js";
import { deliverMonthlyExports } from "../../services/export/monthly.js";
import { monthlyExportJob } from "../../station/monthly-export.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeEmailSender, makeFakeFileStorage } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime(
    { fileStorage: makeFakeFileStorage().layer, emailSender: email.layer },
    { API_PUBLIC_URL: "https://api.expendi.test" },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

/** 00:00 on 1 November in Nairobi. */
const FIRST_OF_NOVEMBER = new Date("2026-10-31T21:00:00Z");

describe("the monthly export job", () => {
  it("runs under its own advisory lock, every 15 minutes", () => {
    // #then
    expect(monthlyExportJob).toMatchObject({
      name: "monthly-export",
      lockKey: 72_022,
      everyMs: 15 * 60_000,
    });
  });

  it("emails every company's accountants once a month, never twice, and skips removed ones", async () => {
    // #given
    const acme = await createCompany(db, "Acme Kenya Ltd");
    const beta = await createCompany(db, "Beta Traders");
    const quiet = await createCompany(db, "No Accountant Ltd");
    const acmeAccountant = await createUser(db);
    const betaInvited = await createUser(db);
    const betaRemoved = await createUser(db);
    const quietEmployee = await createUser(db);
    await addMember(db, acme, acmeAccountant, { role: "accountant" });
    await addMember(db, beta, betaInvited, {
      role: "accountant",
      status: "invited",
    });
    await addMember(db, beta, betaRemoved, {
      role: "accountant",
      status: "removed",
    });
    await addMember(db, quiet, quietEmployee);
    const ours = new Set(
      [acmeAccountant, betaInvited, betaRemoved, quietEmployee].map(
        (user) => user.email,
      ),
    );

    // #when
    for (let run = 0; run < 3; run += 1) {
      await runtime.runPromise(deliverMonthlyExports(FIRST_OF_NOVEMBER));
    }
    await runtime.runPromise(
      deliverMonthlyExports(new Date("2026-11-20T09:00:00Z")),
    );

    // #then
    const sent = email.state.sent.filter((message) => ours.has(message.to));
    expect(sent.map((message) => [message.to, message.subject]).sort()).toEqual(
      [
        [acmeAccountant.email, "Acme Kenya Ltd: October 2026 export"],
        [betaInvited.email, "Beta Traders: October 2026 export"],
      ].sort(),
    );
  });
});
