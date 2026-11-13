import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser, TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { receiptNumberOf } from "../../services/bills/payment-receipt.js";
import { nairobiDate } from "../../services/bills/status.js";
import {
  insertBill,
  insertBillPayment,
  insertPayee,
} from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;

let company: TestCompany;
let wallet: TestWallet;
let categoryId: string;
let payeeId: string;

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
  wallet = await createActiveWallet(db, company);
  categoryId = await addCategory(db, company, "Utilities");
  payeeId = await insertPayee(db, company, { name: "Kenya Power" });
});

const receiptPath = (
  billId: string,
  target: Pick<TestCompany, "organizationId"> = company,
) => `/organizations/${target.organizationId}/bills/${billId}/payment-receipt`;

async function download(
  billId: string,
  user: Pick<TestUser, "privyUserId"> | null = company.admin,
  target: Pick<TestCompany, "organizationId"> = company,
): Promise<Response> {
  return await app.request(receiptPath(billId, target), {
    headers: user ? bearer(user.privyUserId) : {},
  });
}

const bill = () =>
  insertBill(db, company, {
    payeeId,
    categoryId,
    dueOn: nairobiDate(new Date()),
    status: "due",
  });

async function paidBill(): Promise<{ billId: string; payoutId: string }> {
  const billId = await bill();
  const payoutId = await insertBillPayment(db, company, wallet.id, billId);
  return { billId, payoutId };
}

describe("GET /organizations/:id/bills/:billId/payment-receipt", () => {
  it("sends the receipt of a bill paid through Expendi as a PDF download", async () => {
    // #given
    const { billId, payoutId } = await paidBill();

    // #when
    const response = await download(billId);

    // #then
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe(
      `attachment; filename="payment-receipt-${receiptNumberOf(payoutId)}.pdf"`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("sends the same file on every download", async () => {
    // #given
    const { billId } = await paidBill();

    // #when
    const first = await download(billId);
    const second = await download(billId);

    // #then
    expect(
      Buffer.from(await second.arrayBuffer()).equals(
        Buffer.from(await first.arrayBuffer()),
      ),
    ).toBe(true);
  });

  it("needs a signed-in user", async () => {
    // #given
    const { billId } = await paidBill();

    // #when
    const response = await download(billId, null);

    // #then
    expect(response.status).toBe(401);
  });

  it("lets an accountant download it, since it changes nothing", async () => {
    // #given
    const { billId } = await paidBill();
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });

    // #when
    const response = await download(billId, accountant);

    // #then
    expect(response.status).toBe(200);
  });

  it("keeps it from an employee", async () => {
    // #given
    const { billId } = await paidBill();
    const employee = await createUser(db);
    await addMember(db, company, employee);

    // #when
    const response = await download(billId, employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("answers not found for a bill that belongs to another company", async () => {
    // #given
    const { billId } = await paidBill();
    const other = await createCompany(db, "Other Co");

    // #when
    const response = await download(billId, other.admin, other);

    // #then
    expect(response.status).toBe(404);
  });

  it("answers not found for an unknown or malformed bill", async () => {
    // #when
    const unknown = await download(randomUUID());
    const malformed = await download("not-a-bill");

    // #then
    expect([unknown.status, malformed.status]).toEqual([404, 404]);
  });

  it("says a bill paid outside Expendi has no receipt", async () => {
    // #given
    const billId = await insertBill(db, company, {
      payeeId,
      categoryId,
      status: "paid_outside",
      paidOn: "2026-11-12",
      paidAt: new Date("2026-11-12T09:00:00Z"),
      markedPaidBy: company.admin.id,
    });

    // #when
    const response = await download(billId);

    // #then
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "This bill wasn't paid through Expendi, so there's no payment receipt.",
    );
  });

  it("says a bill whose payout hasn't been paid has no receipt yet", async () => {
    // #given
    const billId = await bill();
    await insertBillPayment(db, company, wallet.id, billId, {
      status: "paying",
    });

    // #when
    const response = await download(billId);

    // #then
    expect(response.status).toBe(409);
  });

  it("rejects a user of another company", async () => {
    // #given
    const { billId } = await paidBill();

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: receiptPath(billId, { organizationId }),
    }));
  });
});
