import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayrollDraftsRun } from "../../services/payroll/drafts.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { draftDuePayrollRuns } from "../../services/payroll/drafts.js";
import { addCategory } from "../helpers/claims.js";
import { createCompany } from "../helpers/db.js";
import {
  addEmployeePayee,
  billsOfRun,
  insertSalary,
  runsOf,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";

/**
 * The payroll-drafts job drafts every company's runs, so it runs on its
 * own after the main suite, like the other cross-company jobs.
 */

let runtime: AppRuntime;
let db: Database;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

const runJob = (now: Date) => runtime.runPromise(draftDuePayrollRuns(now));

async function companyPaying(
  people: number,
  values: Partial<Parameters<typeof insertSalary>[2]> = {},
): Promise<TestCompany> {
  const company = await createCompany(db);
  const categoryId = await addCategory(db, company, "Salaries");
  for (let index = 0; index < people; index += 1) {
    const { payeeId } = await addEmployeePayee(db, company);
    await insertSalary(db, company, { payeeId, categoryId, ...values });
  }
  return company;
}

async function shapeOf(company: TestCompany) {
  const runs = await runsOf(db, company);
  return Promise.all(
    runs.map(async (run) => ({
      payDate: run.payDate,
      bills: (await billsOfRun(db, company, run.id)).length,
    })),
  );
}

describe("draftDuePayrollRuns", () => {
  it("drafts nothing before midnight in Nairobi 5 days out, then every company's run at it", async () => {
    // #given two companies paying on 28 Jan 2027
    const acme = await companyPaying(2, { nextDueOn: "2027-01-28" });
    const zuri = await companyPaying(3, { nextDueOn: "2027-01-28" });

    // #when the job runs at 23:59:59 and at 00:00 in Nairobi, still 22 Jan in UTC
    const before = await runJob(new Date("2027-01-22T20:59:59Z"));
    const at = await runJob(new Date("2027-01-22T21:00:00Z"));

    // #then other files' companies may be drafted too; look at these two
    const ours = new Set([acme.organizationId, zuri.organizationId]);
    const draftedHere = (run: PayrollDraftsRun) =>
      run.drafted.filter((draft) => ours.has(draft.organizationId)).length;
    expect({
      before: draftedHere(before),
      at: { today: at.today, drafted: draftedHere(at), failed: at.failed },
      acme: await shapeOf(acme),
      zuri: await shapeOf(zuri),
    }).toEqual({
      before: 0,
      at: { today: "2027-01-23", drafted: 2, failed: 0 },
      acme: [{ payDate: "2027-01-28", bills: 2 }],
      zuri: [{ payDate: "2027-01-28", bills: 3 }],
    });
  });

  it("reports each new run for the admins' notification", async () => {
    // #given
    const company = await companyPaying(1, { nextDueOn: "2027-02-10" });

    // #when
    const run = await runJob(new Date("2027-02-05T06:00:00Z"));

    // #then
    const [drafted] = await runsOf(db, company);
    expect(run.drafted).toContainEqual({
      organizationId: company.organizationId,
      runId: drafted?.id,
      payDate: "2027-02-10",
    });
  });

  it("leaves one run per company and pay date however many times it runs", async () => {
    // #given
    const company = await companyPaying(3, { nextDueOn: "2027-03-28" });
    const now = new Date("2027-03-23T06:00:00Z");

    // #when it runs twice in a row, then twice at once
    await runJob(now);
    await runJob(now);
    await Promise.all([runJob(now), runJob(now)]);

    // #then
    expect(await shapeOf(company)).toEqual([
      { payDate: "2027-03-28", bills: 3 },
    ]);
  });

  it("leaves one run with everyone when two instances draft at once", async () => {
    // #given
    const company = await companyPaying(4, { nextDueOn: "2027-04-28" });
    const now = new Date("2027-04-23T06:00:00Z");

    // #when
    await Promise.all([runJob(now), runJob(now), runJob(now)]);

    // #then
    expect(await shapeOf(company)).toEqual([
      { payDate: "2027-04-28", bills: 4 },
    ]);
  });

  it("drafts a missed run late rather than never", async () => {
    // #given the job didn't run from 18 May until after pay day
    const company = await companyPaying(1, { nextDueOn: "2027-05-23" });

    // #when
    await runJob(new Date("2027-05-24T06:00:00Z"));

    // #then
    expect(await shapeOf(company)).toEqual([
      { payDate: "2027-05-23", bills: 1 },
    ]);
  });
});
