import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { CreatePayeeRequest } from "@expendi-business/shared";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayeeChangeConfirmation } from "../../services/payees/payment-guard.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { withScope } from "../../db/scope.js";
import { archivePayee } from "../../services/payees/payees.js";
import {
  assertPayeeChangeConfirmed,
  resolvePayeeRecipient,
} from "../../services/payees/payment-guard.js";
import { addMember, createUser } from "../helpers/db.js";
import { randomAddress } from "../helpers/fakes.js";
import {
  addPayee,
  ageDetailsChange,
  changePayeeDetails,
  confirmPhone,
  randomKenyanMobile,
} from "../helpers/payees.js";
import { allowlistAddress, createPayingCompany } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  paying = await createPayingCompany(runtime, db);
});

const unconfirmed: PayeeChangeConfirmation = { secondConfirmation: false };
const confirmed: PayeeChangeConfirmation = { secondConfirmation: true };

/** The failure's tag and, for `PayeeNotPayable`, its reason; or the value. */
function outcomeOf<A>(exit: Exit.Exit<A, { readonly _tag: string }>) {
  if (Exit.isSuccess(exit)) return { ok: exit.value };
  const failure = Cause.failureOption(exit.cause);
  if (Option.isNone(failure)) return { defect: Cause.pretty(exit.cause) };
  const error = failure.value;
  return "reason" in error
    ? { error: error._tag, reason: error.reason }
    : { error: error._tag };
}

async function guard(
  payeeId: string,
  confirmation = unconfirmed,
  company = paying.company,
) {
  return outcomeOf(
    await runtime.runPromiseExit(
      withScope({ organizationId: company.organizationId }, (tx) =>
        assertPayeeChangeConfirmed(tx, payeeId, confirmation),
      ),
    ),
  );
}

async function resolve(payeeId: string, confirmation = confirmed) {
  return outcomeOf(
    await runtime.runPromiseExit(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        resolvePayeeRecipient(tx, payeeId, confirmation),
      ),
    ),
  );
}

const add = (input: CreatePayeeRequest) => addPayee(runtime, paying, input);

const bank = {
  method: "bank",
  bankCode: "KCBLKENX",
  accountNumber: "0123456789",
  accountName: "Acme Supplies Ltd",
} as const;

async function employeePayee() {
  const user = await createUser(db);
  const membershipId = await addMember(db, paying.company, user);
  const payee = await add({
    kind: "employee",
    name: "Wanjiru",
    membershipId,
    details: { method: "mpesa_phone", accountName: "Wanjiru Kamau" },
  });
  return { user, payee };
}

describe("assertPayeeChangeConfirmed", () => {
  it("refuses to pay a payee whose details changed in the last 24 hours", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });

    // #when
    const outcome = await guard(payee.id);

    // #then
    expect(outcome).toEqual({ error: "PayeeChangeUnconfirmed" });
  });

  it("allows it with the admin's second confirmation", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });

    // #when
    const outcome = await guard(payee.id, confirmed);

    // #then
    expect(outcome).toEqual({ ok: undefined });
  });

  it("still refuses just before the 24 hours are up", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });
    await ageDetailsChange(db, paying.company, payee.id, 23.9);

    // #when
    const outcome = await guard(payee.id);

    // #then
    expect(outcome).toEqual({ error: "PayeeChangeUnconfirmed" });
  });

  it("allows it once 24 hours have passed", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });
    await ageDetailsChange(db, paying.company, payee.id, 24.1);

    // #when
    const outcome = await guard(payee.id);

    // #then
    expect(outcome).toEqual({ ok: undefined });
  });

  it("starts the 24 hours again when the details change again", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });
    await ageDetailsChange(db, paying.company, payee.id, 72);
    await changePayeeDetails(runtime, paying, payee.id, {
      ...bank,
      accountNumber: "5555666677",
    });

    // #when
    const outcome = await guard(payee.id);

    // #then
    expect(outcome).toEqual({ error: "PayeeChangeUnconfirmed" });
  });

  it("has nothing to confirm for a payee whose details never changed", async () => {
    // #given
    const payee = await add({ kind: "statutory", name: "KRA" });

    // #when
    const outcome = await guard(payee.id);

    // #then
    expect(outcome).toEqual({ ok: undefined });
  });

  it("can't see another company's payee", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });
    const other = await createPayingCompany(runtime, db);

    // #when
    const outcome = await guard(payee.id, confirmed, other.company);

    // #then
    expect(outcome).toEqual({ error: "PayeeNotFound" });
  });
});

describe("resolvePayeeRecipient", () => {
  it("pays an employee on M-Pesa to the number they confirmed", async () => {
    // #given
    const { user, payee } = await employeePayee();
    const phone = randomKenyanMobile();
    await confirmPhone(db, user.id, phone);

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({
      ok: { method: "mpesa_phone", phone, accountName: "Wanjiru Kamau" },
    });
  });

  it("follows the employee's number when they confirm a new one", async () => {
    // #given
    const { user, payee } = await employeePayee();
    await confirmPhone(db, user.id, randomKenyanMobile());
    const newPhone = randomKenyanMobile();
    await confirmPhone(db, user.id, newPhone);

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toMatchObject({ ok: { phone: newPhone } });
  });

  it("can't pay an employee who hasn't confirmed a number", async () => {
    // #given
    const { payee } = await employeePayee();

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({
      error: "PayeeNotPayable",
      reason: "no_confirmed_phone",
    });
  });

  it("pays an employee's bank account when an admin added one", async () => {
    // #given
    const user = await createUser(db);
    const membershipId = await addMember(db, paying.company, user);
    const payee = await add({
      kind: "employee",
      name: "Wanjiru",
      membershipId,
      details: bank,
    });

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({ ok: bank });
  });

  it("pays other personnel to the number stored on the payee", async () => {
    // #given
    const phone = randomKenyanMobile();
    const payee = await add({
      kind: "personnel",
      name: "Otieno",
      details: { method: "mpesa_phone", phone, accountName: "Otieno Ouma" },
    });

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({
      ok: { method: "mpesa_phone", phone, accountName: "Otieno Ouma" },
    });
  });

  it("pays a Paybill to its business and account numbers", async () => {
    // #given
    const paybill = {
      method: "mpesa_paybill",
      paybillNumber: "888880",
      accountReference: "ACC-1234",
      accountName: "Kenya Power",
    } as const;
    const payee = await add({
      kind: "supplier",
      name: "KPLC",
      details: paybill,
    });

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({ ok: paybill });
  });

  it("pays a USDC payee to its address, named after the payee", async () => {
    // #given
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address);
    const payee = await add({
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", address },
    });

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({
      ok: { method: "usdc", address, accountName: "Cloud host" },
    });
  });

  it.each([
    ["no_details", { kind: "supplier", name: "Acme" }],
    [
      "paid_outside",
      { kind: "vendor", name: "Figma", details: { method: "outside" } },
    ],
  ] as const)("refuses a payee that is %s", async (reason, input) => {
    // #given
    const payee = await add(input);

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({ error: "PayeeNotPayable", reason });
  });

  it("refuses an archived payee", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });
    await runtime.runPromise(
      archivePayee(
        {
          organizationId: paying.company.organizationId,
          userId: paying.company.admin.id,
        },
        payee.id,
      ),
    );

    // #when
    const outcome = await resolve(payee.id);

    // #then
    expect(outcome).toEqual({ error: "PayeeNotPayable", reason: "archived" });
  });

  it("applies the 24-hour rule too", async () => {
    // #given
    const payee = await add({ kind: "supplier", name: "Acme", details: bank });

    // #when
    const outcome = await resolve(payee.id, unconfirmed);

    // #then
    expect(outcome).toEqual({ error: "PayeeChangeUnconfirmed" });
  });
});
