import { eq } from "drizzle-orm";
import { Effect, Either } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import type { PayrollPerson } from "../helpers/payroll.js";
import { DatabaseService } from "../../db/client.js";
import { bills, payees } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { draftDuePayroll } from "../../services/payroll/drafts.js";
import {
  payablePayrollRun,
  payrollPayoutRequests,
} from "../../services/payroll/payable.js";
import { MAX_KES_PER_ORDER_CENTS } from "../../services/payroll/split.js";
import { addCategory } from "../helpers/claims.js";
import { createCompany } from "../helpers/db.js";
import { confirmPhone, randomKenyanMobile } from "../helpers/payees.js";
import {
  addEmployeePayee,
  insertPersonnelPayee,
  insertSalary,
  runsOf,
  setRunStatus,
} from "../helpers/payroll.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;

let company: TestCompany;
let amina: PayrollPerson;
let casualId: string;
let aminaPhone: string;
let casualPhone: string;
let runId: string;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  company = await createCompany(db);
  const categoryId = await addCategory(db, company, "Salaries");
  amina = await addEmployeePayee(db, company, "Amina");
  aminaPhone = randomKenyanMobile();
  await confirmPhone(db, amina.user.id, aminaPhone);
  casualPhone = randomKenyanMobile();
  casualId = await insertPersonnelPayee(db, company, "Otieno", casualPhone);
  await insertSalary(db, company, {
    payeeId: amina.payeeId,
    categoryId,
    amountKes: 6_000_000n,
  });
  await insertSalary(db, company, {
    payeeId: casualId,
    categoryId,
    amountKes: 1_500_000n,
  });
  await runtime.runPromise(
    draftDuePayroll(company.organizationId, new Date("2026-11-23T06:00:00Z")),
  );
  const [run] = await runsOf(db, company);
  if (!run) throw new Error("no run drafted");
  runId = run.id;
});

const asAdmin = () => ({
  organizationId: company.organizationId,
  userId: company.admin.id,
  role: "admin" as const,
});

const payable = (secondConfirmation = false) =>
  runtime.runPromise(
    Effect.either(
      withScope(asAdmin(), (tx) =>
        payablePayrollRun(tx, company.organizationId, runId, {
          secondConfirmation,
        }),
      ),
    ),
  );

describe("payablePayrollRun (the seam for T39)", () => {
  it("resolves everyone's recipient now, an employee to the number they confirmed", async () => {
    // #when
    const result = await payable();

    // #then
    expect(
      Either.getOrThrow(result).payments.map((payment) => ({
        name: payment.payeeName,
        amountKesCents: payment.amountKesCents,
        method: payment.recipient.method,
        phone:
          payment.recipient.method === "mpesa_phone"
            ? payment.recipient.phone
            : null,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          name: "Amina",
          amountKesCents: 6_000_000n,
          method: "mpesa_phone",
          phone: aminaPhone,
        },
        {
          name: "Otieno",
          amountKesCents: 1_500_000n,
          method: "mpesa_phone",
          phone: casualPhone,
        },
      ]),
    );
  });

  it("leaves out whoever the admin left out", async () => {
    // #given
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(bills)
        .set({
          status: "cancelled",
          cancelledReason: "Left",
          cancelledBy: company.admin.id,
          cancelledAt: new Date(),
        })
        .where(eq(bills.payeeId, casualId)),
    );

    // #when
    const result = await payable();

    // #then
    expect(
      Either.getOrThrow(result).payments.map((payment) => payment.payeeName),
    ).toEqual(["Amina"]);
  });

  it("refuses an employee who hasn't confirmed their M-Pesa number", async () => {
    // #given
    await confirmPhone(db, amina.user.id, null);

    // #when
    const result = await payable();

    // #then
    expect(Either.flip(result)).toMatchObject(
      Either.right({ _tag: "PayeeNotPayable", reason: "no_confirmed_phone" }),
    );
  });

  it("needs the second confirmation for someone whose details just changed", async () => {
    // #given
    await runInScope(db, asAdmin(), (tx) =>
      tx
        .update(payees)
        .set({ detailsChangedAt: new Date() })
        .where(eq(payees.id, casualId)),
    );

    // #when
    const [without, withIt] = [await payable(false), await payable(true)];

    // #then
    expect([Either.isLeft(without), Either.isRight(withIt)]).toEqual([
      true,
      true,
    ]);
  });

  it("refuses a run that's no longer a draft", async () => {
    // #given
    await setRunStatus(db, company, runId, "paying");

    // #when
    const result = await payable();

    // #then
    expect(Either.flip(result)).toMatchObject(
      Either.right({ _tag: "Conflict" }),
    );
  });
});

describe("payrollPayoutRequests", () => {
  it("asks the engine for one payout per person, tagged with the run and keyed to the bill", async () => {
    // #given
    const { payments } = Either.getOrThrow(await payable());

    // #when
    const requests = payrollPayoutRequests(
      runId,
      payments,
      MAX_KES_PER_ORDER_CENTS,
    );

    // #then
    expect(requests).toEqual(
      payments.map((payment) => ({
        subjectType: "bill",
        subjectId: payment.billId,
        payrollRunId: runId,
        idempotencyKey: `payroll:${payment.billId}:1`,
        recipient: payment.recipient,
        amountKesCents: payment.amountKesCents,
      })),
    );
  });
});
