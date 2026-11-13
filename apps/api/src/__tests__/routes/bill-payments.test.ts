import { randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  BillPayment,
  BillPaymentResult,
  RecurringItem,
} from "@expendi-business/shared";
import {
  billDetailSchema,
  billPaymentResultSchema,
  billPaymentSchema,
  payeeChangeHoldSchema,
  recurringItemSchema,
  resolvePreparedSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { NewBill, NewPayee, Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, organizations, payouts } from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { nairobiDate } from "../../services/bills/status.js";
import { kesCentsFor, usdcCovering } from "../../services/paycrest/amounts.js";
import { maxDebitFor } from "../../services/payout/prepare.js";
import { applyPayoutOutcome } from "../../services/payout/subjects.js";
import { insertBill, insertPayee, readBill } from "../helpers/bills.js";
import { randomTxHash } from "../helpers/chain.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
  makeFakePaycrest,
  randomAddress,
  signPaycrestBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import {
  createNearUsdcPayingCompany,
  followPayout,
  makeNearUsdcFakes,
  registeredNearAccount,
} from "../helpers/near-usdc-payouts.js";
import { ageDetailsChange } from "../helpers/payees.js";
import {
  allowlistAddress,
  createPayingCompany,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { outstandingBillsOfItem } from "../helpers/recurring.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const near = makeNearUsdcFakes();
const { privy } = near;
const paycrest = makeFakePaycrest();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let paying: PayingCompany;
let categoryId: string;

/** KES 2,500 at the fake's 128.68 KES/USDC. */
const BILL_KES = 250_000n;
const BILL_USDC = usdcCovering(BILL_KES, "128.68");
const BILL_MAX_DEBIT = maxDebitFor(BILL_USDC);
const OLD_CHANGE = new Date("2026-01-01T00:00:00Z");
const HOUR_MS = 60 * 60_000;

beforeAll(async () => {
  runtime = makeTestRuntime({
    ...near.layers,
    paycrest: paycrest.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

async function setUpCompany(balance = 100n * USDC): Promise<void> {
  paying = await createPayingCompany(runtime, db, balance);
  categoryId = await addCategory(db, paying.company, "Utilities");
}

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  await setUpCompany();
});

const admin = () => paying.company.admin;
const billsPath = (company: TestCompany = paying.company) =>
  `/organizations/${company.organizationId}/bills`;

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function errorOf(response: Response) {
  const body = (await response.json()) as {
    error: { message: string; details?: Record<string, unknown> };
  };
  return body.error;
}

let tills = 100_000;

/** A supplier paid to an M-Pesa Till, whose details changed long ago. */
function tillPayee(values: Partial<NewPayee> = {}): Promise<string> {
  tills += 1;
  return insertPayee(db, paying.company, {
    name: `Kenya Power ${tills}`,
    method: "mpesa_till",
    tillNumber: String(tills),
    accountName: `Kenya Power ${tills}`,
    detailsChangedAt: OLD_CHANGE,
    ...values,
  });
}

/** A supplier paid in USDC to an address on the company's allowlist. */
async function usdcPayee(): Promise<{ payeeId: string; address: string }> {
  const address = randomAddress().toLowerCase();
  await allowlistAddress(runtime, paying, address, "Vercel");
  const payeeId = await insertPayee(db, paying.company, {
    name: "Vercel Inc",
    method: "usdc",
    usdcChain: "base",
    usdcAddress: address,
    detailsChangedAt: OLD_CHANGE,
  });
  return { payeeId, address };
}

/**
 * Moves the test to a company whose wallet is on NEAR, with a supplier paid
 * in USDC to a NEAR account on its allowlist.
 */
async function nearUsdcPayee(): Promise<{ payeeId: string; address: string }> {
  paying = await createNearUsdcPayingCompany(runtime, db, near);
  categoryId = await addCategory(db, paying.company, "Utilities");
  const address = registeredNearAccount(near);
  await allowlistAddress(runtime, paying, address, "Vercel", "near");
  const payeeId = await insertPayee(db, paying.company, {
    name: "Vercel Inc",
    method: "usdc",
    usdcChain: "near",
    usdcAddress: address,
    detailsChangedAt: OLD_CHANGE,
  });
  return { payeeId, address };
}

function bill(
  payeeId: string,
  values: Partial<NewBill> = {},
  company: TestCompany = paying.company,
  category: string = categoryId,
): Promise<string> {
  return insertBill(db, company, {
    payeeId,
    categoryId: category,
    amountKes: BILL_KES,
    dueOn: nairobiDate(new Date()),
    status: "due",
    ...values,
  });
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Payment extends Omit<BillPayment, "options"> {
  readonly options: SignOptions;
}

function prepare(
  billIds: readonly string[],
  options: { secondConfirmation?: boolean; user?: TestUser } = {},
): Promise<Response> {
  return sendJson(app, `${billsPath()}/payment`, options.user ?? admin(), {
    method: "POST",
    body: {
      billIds,
      ...(options.secondConfirmation !== undefined && {
        secondConfirmation: options.secondConfirmation,
      }),
    },
  });
}

async function parsePayment(response: Response): Promise<Payment> {
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    ...billPaymentSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

const paymentFor = async (billIds: readonly string[]) =>
  parsePayment(await prepare(billIds));

function confirm(payment: Payment, user: TestUser = admin()) {
  return sendJson(
    app,
    `${billsPath()}/payment/${payment.challengeId}/confirm`,
    user,
    {
      method: "POST",
      body: { response: paying.passkey.sign(payment.options, TEST_ORIGIN) },
    },
  );
}

async function paid(payment: Payment): Promise<BillPaymentResult> {
  const response = await confirm(payment);
  expect(response.status).toBe(200);
  return billPaymentResultSchema.parse(await dataOf(response));
}

/** Prepares and confirms the bills; returns their payouts, in the bills' order. */
async function pay(billIds: readonly string[]): Promise<Payout[]> {
  const payment = await paymentFor(billIds);
  await paid(payment);
  return Promise.all(
    payment.bills.map((preview) =>
      readPayout(db, paying.company, preview.payoutId),
    ),
  );
}

function retry(
  billId: string,
  body?: unknown,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, `${billsPath()}/${billId}/retry`, user, {
    method: "POST",
    body,
  });
}

async function payoutsOf(billId: string): Promise<Payout[]> {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select()
        .from(payouts)
        .where(
          and(eq(payouts.subjectType, "bill"), eq(payouts.subjectId, billId)),
        )
        .orderBy(asc(payouts.createdAt)),
  );
}

async function auditOf(entityId: string, action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_type, actor_id, before, after FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY occurred_at",
    [entityId, action],
  );
  return rows;
}

const statusOf = async (billId: string) =>
  (await readBill(db, paying.company, billId)).status;

const moneyMoved = () => ({
  orders: paycrest.state.created.length,
  sends: privy.state.sends.length,
});

function setOrder(payout: Payout, status: string): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, {
    ...order,
    status,
    paymentReference: status === "settled" ? "SKL3ABCDEF" : null,
  });
}

function deliverWebhook(payout: Payout): Promise<Response> {
  const body = JSON.stringify({
    event: "payment_order.settled",
    webhookVersion: "1",
    data: { id: payout.providerOrderId, status: "settled" },
  });
  return Promise.resolve(
    app.request("/webhooks/paycrest", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-paycrest-signature": signPaycrestBody(body),
      },
      body,
    }),
  );
}

async function settle(payout: Payout, status = "settled"): Promise<void> {
  setOrder(payout, status);
  expect((await deliverWebhook(payout)).status).toBe(200);
}

const setCompany = (changes: Partial<typeof organizations.$inferInsert>) =>
  runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
    tx
      .update(organizations)
      .set(changes)
      .where(eq(organizations.id, paying.company.organizationId)),
  );

describe("POST /organizations/:id/bills/payment", () => {
  it("previews each bill and the total, with one passkey challenge", async () => {
    // #given
    const payeeId = await tillPayee();
    const billId = await bill(payeeId);

    // #when
    const payment = await paymentFor([billId]);

    // #then
    const [payout] = await payoutsOf(billId);
    expect(payment.bills).toEqual([
      {
        billId,
        payoutId: payout?.id,
        payeeName: expect.stringContaining("Kenya Power") as unknown,
        paidTo: {
          method: "mpesa_till",
          label: `Till ${payout?.recipient.method === "mpesa_till" ? payout.recipient.tillNumber : ""}`,
        },
        currency: "kes",
        billedKes: BILL_KES.toString(),
        receivesKes: BILL_KES.toString(),
        receivesUsdc: null,
        kesEquivalent: BILL_KES.toString(),
        rate: "128.68",
        usdc: BILL_USDC.toString(),
        feeAllowanceUsdc: (BILL_MAX_DEBIT - BILL_USDC).toString(),
        maxDebitUsdc: BILL_MAX_DEBIT.toString(),
      },
    ]);
    expect({
      totals: payment.totals,
      wallet: payment.wallet,
      key: payout?.idempotencyKey,
      ...moneyMoved(),
      bill: await statusOf(billId),
    }).toEqual({
      totals: {
        receivesKes: BILL_KES.toString(),
        receivesUsdc: "0",
        kesEquivalent: BILL_KES.toString(),
        usdc: BILL_USDC.toString(),
        feeAllowanceUsdc: (BILL_MAX_DEBIT - BILL_USDC).toString(),
        maxDebitUsdc: BILL_MAX_DEBIT.toString(),
      },
      wallet: {
        availableUsdc: (100n * USDC).toString(),
        shortfallUsdc: "0",
        topUpKes: null,
      },
      key: `bill:${billId}:1`,
      orders: 0,
      sends: 0,
      bill: "due",
    });
  });

  describe("Pay all", () => {
    it("pays each of 3 bills once under one passkey", async () => {
      // #given
      const billIds = await Promise.all(
        [tillPayee(), tillPayee(), tillPayee()].map(async (payee) =>
          bill(await payee),
        ),
      );

      // #when
      const payment = await paymentFor(billIds);
      const result = await paid(payment);
      for (const billId of billIds) {
        const [payout] = await payoutsOf(billId);
        if (!payout) throw new Error("no payout");
        await settle(payout);
      }

      // #then
      expect({
        approvals: new Set(payment.bills.map((preview) => preview.payoutId))
          .size,
        afterApproval: result.bills.map((row) => row.status),
        ...moneyMoved(),
        settled: await Promise.all(billIds.map(statusOf)),
        payoutsPerBill: await Promise.all(
          billIds.map(async (billId) => (await payoutsOf(billId)).length),
        ),
      }).toEqual({
        approvals: 3,
        afterApproval: ["paying", "paying", "paying"],
        orders: 3,
        sends: 3,
        settled: ["paid", "paid", "paid"],
        payoutsPerBill: [1, 1, 1],
      });
    });

    it("leaves the other two paid when one fails", async () => {
      // #given
      const billIds = await Promise.all(
        [tillPayee(), tillPayee(), tillPayee()].map(async (payee) =>
          bill(await payee),
        ),
      );
      privy.state.nextSends("sent", "refused", "sent");

      // #when
      await paid(await paymentFor(billIds));
      for (const billId of billIds) {
        const [payout] = await payoutsOf(billId);
        if (payout?.status === "paying") await settle(payout);
      }

      // #then
      const statuses = await Promise.all(billIds.map(statusOf));
      expect({
        statuses: [...statuses].sort(),
        payouts: (
          await Promise.all(billIds.map((billId) => payoutsOf(billId)))
        ).map((rows) => rows.length),
      }).toEqual({
        statuses: ["paid", "paid", "payout_failed"],
        payouts: [1, 1, 1],
      });
      const failed = billIds[statuses.indexOf("payout_failed")] ?? "";
      expect(await auditOf(failed, "bill.payout_failed")).toHaveLength(1);
    });
  });

  describe("what can't be paid (spec §6.20)", () => {
    it("refuses a variable bill until its amount is entered, preparing nothing", async () => {
      // #given
      const billId = await bill(await tillPayee(), {
        variable: true,
        amountKes: null,
      });

      // #when
      const response = await prepare([billId]);

      // #then
      expect(response.status).toBe(409);
      expect(await errorOf(response)).toMatchObject({
        message: "Enter this bill's amount before paying it.",
        details: { billId, reason: "no_amount" },
      });
      expect(await payoutsOf(billId)).toEqual([]);
    });

    it("refuses a payee paid outside Expendi", async () => {
      // #given
      const payeeId = await insertPayee(db, paying.company, {
        name: "Figma",
        kind: "vendor",
        method: "outside",
        detailsChangedAt: OLD_CHANGE,
      });
      const billId = await bill(payeeId);

      // #when
      const response = await prepare([billId]);

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).details).toEqual({
        billId,
        reason: "paid_outside_payee",
      });
      expect(await payoutsOf(billId)).toEqual([]);
    });

    it("prepares nothing in a batch when one bill can't be paid", async () => {
      // #given
      const ready = await bill(await tillPayee());
      const variable = await bill(await tillPayee(), {
        variable: true,
        amountKes: null,
      });

      // #when
      const response = await prepare([ready, variable]);

      // #then
      expect({
        status: response.status,
        ready: await payoutsOf(ready),
      }).toEqual({ status: 409, ready: [] });
    });

    it("refuses a bill that's already paid", async () => {
      // #given
      const billId = await bill(await tillPayee());
      const [payout] = await pay([billId]);
      if (!payout) throw new Error("no payout");
      await settle(payout);

      // #when
      const response = await prepare([billId]);

      // #then
      expect({
        status: response.status,
        reason: (await errorOf(response)).details?.reason,
      }).toEqual({ status: 409, reason: "not_unpaid" });
    });
  });

  describe("the 24-hour hold after a payee's details change (spec §6.19)", () => {
    it("asks for a second confirmation, naming the payee, and prepares nothing", async () => {
      // #given
      const payeeId = await tillPayee({ name: "Acme Supplies" });
      await ageDetailsChange(db, paying.company, payeeId, 2);
      const billId = await bill(payeeId);

      // #when
      const response = await prepare([billId]);

      // #then
      expect(response.status).toBe(409);
      const error = await errorOf(response);
      expect(error.message).toContain(
        "Acme Supplies's payment details changed in the last 24 hours",
      );
      expect(payeeChangeHoldSchema.parse(error.details)).toMatchObject({
        reason: "payee_details_changed",
        payees: [{ payeeId, name: "Acme Supplies" }],
      });
      expect(await payoutsOf(billId)).toEqual([]);
    });

    it("pays once the admin confirms a second time", async () => {
      // #given
      const payeeId = await tillPayee();
      await ageDetailsChange(db, paying.company, payeeId, 2);
      const billId = await bill(payeeId);

      // #when
      const payment = await parsePayment(
        await prepare([billId], { secondConfirmation: true }),
      );
      const result = await paid(payment);

      // #then
      expect({
        bill: result.bills[0]?.status,
        ...moneyMoved(),
      }).toEqual({ bill: "paying", orders: 1, sends: 1 });
    });

    it("needs no second confirmation 24 hours after the change", async () => {
      // #given
      const payeeId = await tillPayee();
      await ageDetailsChange(db, paying.company, payeeId, 25);
      const billId = await bill(payeeId);

      // #when
      const response = await prepare([billId]);

      // #then
      expect(response.status).toBe(201);
    });

    it("sends nothing when the details change after the payment was prepared", async () => {
      // #given
      const payeeId = await tillPayee();
      const billId = await bill(payeeId);
      const payment = await paymentFor([billId]);
      await ageDetailsChange(db, paying.company, payeeId, 0);

      // #when
      const response = await confirm(payment);

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toContain(
        "payment details changed after this payment was prepared",
      );
      expect({ ...moneyMoved(), bill: await statusOf(billId) }).toEqual({
        orders: 0,
        sends: 0,
        bill: "due",
      });
    });
  });

  it("sends nothing when the bill's amount changed after preparing", async () => {
    // #given
    const billId = await bill(await tillPayee());
    const payment = await paymentFor([billId]);
    const edited = await sendJson(app, `${billsPath()}/${billId}`, admin(), {
      method: "PATCH",
      body: { amountKes: "3,000", adjustmentReason: "New invoice" },
    });
    expect(edited.status).toBe(200);

    // #when
    const response = await confirm(payment);

    // #then
    expect({
      status: response.status,
      ...moneyMoved(),
      bill: await statusOf(billId),
    }).toEqual({ status: 409, orders: 0, sends: 0, bill: "due" });
  });

  describe("the daily cap (spec §7.4)", () => {
    it("refuses bills over the daily cap, sending nothing", async () => {
      // #given a KES 4,000 cap, and two bills of KES 2,500
      await setCompany({ dailyPayoutCapKes: 400_000n });
      const billIds = [
        await bill(await tillPayee()),
        await bill(await tillPayee()),
      ];

      // #when
      const response = await confirm(await paymentFor(billIds));

      // #then
      expect({
        status: response.status,
        message: (await errorOf(response)).message,
        ...moneyMoved(),
        bills: await Promise.all(billIds.map(statusOf)),
      }).toEqual({
        status: 409,
        message:
          "This would take today's payouts over the company's daily cap.",
        orders: 0,
        sends: 0,
        bills: ["due", "due"],
      });
    });

    it("counts what was paid earlier today", async () => {
      // #given a KES 4,000 cap with KES 2,500 already paid today
      await setCompany({ dailyPayoutCapKes: 400_000n });
      await pay([await bill(await tillPayee())]);
      const second = await bill(await tillPayee());

      // #when
      const response = await confirm(await paymentFor([second]));

      // #then
      expect({ status: response.status, bill: await statusOf(second) }).toEqual(
        { status: 409, bill: "due" },
      );
    });

    it("counts a USD bill at its KES equivalent", async () => {
      // #given a KES 1,000 cap: USD 7 is KES 900.76, USD 8 is KES 1,029.44
      await setCompany({ dailyPayoutCapKes: 100_000n });
      const { payeeId } = await usdcPayee();
      const under = await bill(payeeId, {
        currency: "usd",
        amountKes: null,
        amountUsdc: 7n * USDC,
      });
      const over = await bill(payeeId, {
        currency: "usd",
        amountKes: null,
        amountUsdc: 8n * USDC,
      });

      // #when
      const refused = await confirm(await paymentFor([over]));
      const allowed = await confirm(await paymentFor([under]));

      // #then
      expect([refused.status, allowed.status]).toEqual([409, 200]);
      expect((await payoutsOf(under))[0]?.amountKes).toBe(
        kesCentsFor(7n * USDC, "128.68"),
      );
    });
  });

  describe("USD bills to payees paid in USDC (spec §6.19)", () => {
    it("pays exactly the USDC to the allowlisted address, with no Paycrest order", async () => {
      // #given USD 60.50
      const { payeeId, address } = await nearUsdcPayee();
      const billId = await bill(payeeId, {
        currency: "usd",
        amountKes: null,
        amountUsdc: 60_500_000n,
      });

      // #when
      const payment = await paymentFor([billId]);
      const result = await paid(payment);

      // #then
      expect(payment.bills[0]).toMatchObject({
        currency: "usd",
        billedKes: null,
        receivesKes: null,
        receivesUsdc: "60500000",
        kesEquivalent: kesCentsFor(60_500_000n, "128.68").toString(),
        usdc: "60500000",
        feeAllowanceUsdc: "0",
        maxDebitUsdc: "60500000",
        paidTo: { method: "usdc" },
      });
      expect({
        received: near.chain.state.usdcBalanceOf(address),
        left: near.chain.state.usdcBalanceOf(paying.wallet.address),
        orders: paycrest.state.created.length,
        bill: result.bills[0]?.status,
      }).toEqual({
        received: 60_500_000n,
        left: 100n * USDC - 60_500_000n,
        orders: 0,
        bill: "paying",
      });
    });

    it("is paid once the transfer is confirmed on chain", async () => {
      // #given
      const { payeeId } = await nearUsdcPayee();
      const billId = await bill(payeeId, {
        currency: "usd",
        amountKes: null,
        amountUsdc: 25n * USDC,
      });
      const [payout] = await pay([billId]);
      if (!payout?.txHash) throw new Error("no hash");

      // #when
      await followPayout(runtime, payout);

      // #then
      const row = await readBill(db, paying.company, billId);
      expect({ status: row.status, paidOn: row.paidOn }).toEqual({
        status: "paid",
        paidOn: nairobiDate(row.paidAt ?? new Date(0)),
      });
    });

    it("refuses a KES bill once its payee is paid in USDC", async () => {
      // #given
      const { payeeId } = await usdcPayee();
      const billId = await bill(payeeId);

      // #when
      const response = await prepare([billId]);

      // #then
      expect({
        status: response.status,
        reason: (await errorOf(response)).details?.reason,
      }).toEqual({ status: 409, reason: "currency_mismatch" });
    });
  });

  it("shows Top up KES X when the wallet is short, and sends nothing", async () => {
    // #given 2 USDC short: 2 × 128.68 = KES 257.36, so top up KES 258
    await setUpCompany(BILL_MAX_DEBIT - 2n * USDC);
    const billId = await bill(await tillPayee());

    // #when
    const payment = await paymentFor([billId]);
    const response = await confirm(payment);

    // #then
    expect(payment.wallet.topUpKes).toBe("25800");
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain("Top up KES 258,");
    expect(moneyMoved()).toEqual({ orders: 0, sends: 0 });
  });

  it("refuses a salary payment: it's paid with its payroll run", async () => {
    // #given
    const runId = await runInScope(
      db,
      {
        organizationId: paying.company.organizationId,
        role: "admin",
      },
      async (tx) => {
        const { rows } = await tx.execute<{ id: string }>(
          `INSERT INTO payroll_runs (organization_id, pay_date, total_kes, cap_kes) VALUES ('${paying.company.organizationId}', '2026-11-28', 250000, 300000) RETURNING id`,
        );
        return rows[0]?.id ?? "";
      },
    );
    const billId = await bill(await tillPayee({ kind: "personnel" }), {
      payrollRunId: runId,
      overviewHeading: "salaries",
    });

    // #when
    const response = await prepare([billId]);

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain("payroll run");
  });

  describe("who can", () => {
    async function employee(): Promise<TestUser> {
      const user = await createUser(db);
      await addMember(db, paying.company, user);
      return user;
    }

    it("refuses employees preparing, confirming or retrying", async () => {
      // #given
      const billId = await bill(await tillPayee());
      const payment = await paymentFor([billId]);
      const staff = await employee();

      // #when
      const responses = await Promise.all([
        prepare([billId], { user: staff }),
        confirm(payment, staff),
        retry(billId, undefined, staff),
      ]);

      // #then
      expect({
        statuses: responses.map((response) => response.status),
        ...moneyMoved(),
      }).toEqual({ statuses: [403, 403, 403], orders: 0, sends: 0 });
    });

    it("answers 404 for another company's bill", async () => {
      // #given
      const other = await createPayingCompany(runtime, db);
      const otherCategory = await addCategory(db, other.company, "Rent");
      const otherPayee = await insertPayee(db, other.company, {
        method: "mpesa_till",
        tillNumber: "654321",
        accountName: "Landlord",
        detailsChangedAt: OLD_CHANGE,
      });
      const theirs = await bill(otherPayee, {}, other.company, otherCategory);

      // #when
      const responses = await Promise.all([prepare([theirs]), retry(theirs)]);

      // #then
      expect(responses.map((response) => response.status)).toEqual([404, 404]);
      expect(await payoutsOf(theirs)).toEqual([]);
    });

    it("answers 404 for an approval that doesn't exist", async () => {
      // #given
      const payment = await paymentFor([await bill(await tillPayee())]);

      // #when
      const response = await confirm({ ...payment, challengeId: randomUUID() });

      // #then
      expect({ status: response.status, ...moneyMoved() }).toEqual({
        status: 404,
        orders: 0,
        sends: 0,
      });
    });

    it("keeps every route to its own company", async () => {
      // #given
      const fixture = await createIsolationFixture(db);
      const body = (payload: unknown): RequestInit => ({
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });

      // #then
      await expectRouteIsolation(app, fixture, (organizationId) => ({
        path: `/organizations/${organizationId}/bills/payment`,
        init: body({ billIds: [randomUUID()] }),
      }));
      await expectRouteIsolation(app, fixture, (organizationId) => ({
        path: `/organizations/${organizationId}/bills/payment/${randomUUID()}/confirm`,
        init: body({ response: {} }),
      }));
      await expectRouteIsolation(app, fixture, (organizationId) => ({
        path: `/organizations/${organizationId}/bills/${randomUUID()}/retry`,
        init: body({}),
      }));
    });
  });
});

describe("the bill follows its payout (spec §6.20)", () => {
  it("is paid once Paycrest's signed webhook says so, and updated once however often it arrives", async () => {
    // #given
    const billId = await bill(await tillPayee());
    const [payout] = await pay([billId]);
    if (!payout) throw new Error("no payout");
    setOrder(payout, "settled");

    // #when
    await deliverWebhook(payout);
    await deliverWebhook(payout);

    // #then
    const row = await readBill(db, paying.company, billId);
    const settled = await readPayout(db, paying.company, payout.id);
    expect({
      status: row.status,
      paidAt: row.paidAt?.toISOString(),
      paidOn: row.paidOn,
      payoutId: row.payoutId,
    }).toEqual({
      status: "paid",
      paidAt: settled.paidAt?.toISOString(),
      paidOn: nairobiDate(settled.paidAt ?? new Date(0)),
      payoutId: payout.id,
    });
    expect(await auditOf(billId, "bill.paid")).toMatchObject([
      {
        actor_type: "system",
        after: { status: "paid", payoutId: payout.id },
      },
    ]);
    expect(await auditOf(billId, "bill.payment_approved")).toMatchObject([
      {
        actor_id: admin().id,
        after: { status: "paying", payoutId: payout.id },
      },
    ]);
  });

  it("is paid when its Pretium cash-out is, recording Pretium's receipt", async () => {
    // #given a bill whose cash-out went through Pretium
    const billId = await bill(await tillPayee());
    const [payout] = await pay([billId]);
    if (!payout) throw new Error("no payout");
    const paidByPretium = {
      provider: "pretium",
      providerOrderId: `TX${randomUUID().slice(0, 8).toUpperCase()}`,
      gatewayOrderId: null,
      feeUsdc: 0n,
      status: "paid",
      paidAt: new Date(),
      providerStatus: "COMPLETE",
      providerReference: "TKP9PRETIUM",
    } as const;
    await updatePayout(db, paying.company, payout.id, paidByPretium);

    // #when Pretium reports it paid with a receipt
    await runtime.runPromise(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        applyPayoutOutcome(tx, { ...payout, ...paidByPretium }),
      ),
    );

    // #then
    expect(await statusOf(billId)).toBe("paid");
    expect(await auditOf(billId, "bill.paid")).toMatchObject([
      {
        after: {
          status: "paid",
          payoutId: payout.id,
          providerReference: "TKP9PRETIUM",
        },
      },
    ]);
  });

  it("fails when Paycrest refunds the order", async () => {
    // #given
    const billId = await bill(await tillPayee());
    const [payout] = await pay([billId]);
    if (!payout) throw new Error("no payout");

    // #when
    await settle(payout, "refunded");

    // #then
    expect(await statusOf(billId)).toBe("payout_failed");
  });

  it("stays paying while its payout is under review", async () => {
    // #given
    const billId = await bill(await tillPayee());
    privy.state.nextSends("unknown");

    // #when
    const [payout] = await pay([billId]);

    // #then
    expect({ payout: payout?.status, bill: await statusOf(billId) }).toEqual({
      payout: "needs_review",
      bill: "paying",
    });
  });

  it("ignores the outcome of a payout that isn't its current payment", async () => {
    // #given a failed payment, retried and approved again
    const billId = await bill(await tillPayee());
    paycrest.state.nextCreateFailure = "refused";
    const [failed] = await pay([billId]);
    if (!failed) throw new Error("no payout");
    await paid(await parsePayment(await retry(billId)));
    expect(await statusOf(billId)).toBe("paying");

    // #when the first payout's failure is applied again
    await runtime.runPromise(
      withScope({ organizationId: paying.company.organizationId }, (tx) =>
        applyPayoutOutcome(tx, failed),
      ),
    );

    // #then
    expect(await statusOf(billId)).toBe("paying");
    expect(await auditOf(billId, "bill.payout_failed")).toHaveLength(1);
  });

  it("creates a recurring payment's next bill when it's paid", async () => {
    // #given a monthly payment, its first bill due today
    const payeeId = await tillPayee();
    const today = nairobiDate(new Date());
    const created = await sendJson(
      app,
      `/organizations/${paying.company.organizationId}/recurring-items`,
      admin(),
      {
        method: "POST",
        body: {
          payeeId,
          amountKes: "2,500",
          schedule: "monthly",
          scheduleDay: Number(today.slice(8, 10)),
          startsOn: today,
          categoryId,
        },
      },
    );
    expect(created.status).toBe(201);
    const item: RecurringItem = recurringItemSchema.parse(
      await dataOf(created),
    );
    const first = item.nextBill?.id ?? "";
    const [payout] = await pay([first]);
    if (!payout) throw new Error("no payout");

    // #when
    await settle(payout);

    // #then
    const outstanding = await outstandingBillsOfItem(
      db,
      paying.company,
      item.id,
    );
    expect({
      first: await statusOf(first),
      next: outstanding.map((row) => [row.dueOn > today, row.amountKes]),
    }).toEqual({ first: "paid", next: [[true, BILL_KES]] });
  });

  describe("when Expendi staff resolve its payout", () => {
    async function stuck(billId: string): Promise<Payout> {
      privy.state.nextSends("unknown");
      const [payout] = await pay([billId]);
      if (!payout) throw new Error("no payout");
      await updatePayout(db, paying.company, payout.id, {
        fundingStartedAt: new Date(Date.now() - 2 * HOUR_MS),
        depositValidUntil: new Date(Date.now() - HOUR_MS),
      });
      return readPayout(db, paying.company, payout.id);
    }

    async function resolve(
      payout: Payout,
      outcome: "paid" | "failed",
    ): Promise<number> {
      const staff = await createStaff(owner, { role: "ops_admin" });
      const post = (path: string, body: unknown) =>
        app.request(path, {
          method: "POST",
          headers: {
            ...bearer(staff.privyUserId),
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        });
      const prepared = await post(
        `/internal/payouts/${payout.id}/resolve/prepare`,
        { outcome, reason: "Checked Paycrest's dashboard and Basescan." },
      );
      expect(prepared.status).toBe(201);
      const { token } = resolvePreparedSchema.parse(await dataOf(prepared));
      const confirmed = await post(
        `/internal/payouts/${payout.id}/resolve/confirm`,
        { token },
      );
      return confirmed.status;
    }

    it("fails when staff close the payout as failed", async () => {
      // #given
      const billId = await bill(await tillPayee());
      const payout = await stuck(billId);
      setOrder(payout, "expired");

      // #when
      const status = await resolve(payout, "failed");

      // #then
      expect({ status, bill: await statusOf(billId) }).toEqual({
        status: 200,
        bill: "payout_failed",
      });
    });

    it("is paid when staff close the payout as paid", async () => {
      // #given
      const billId = await bill(await tillPayee());
      const payout = await stuck(billId);
      setOrder(payout, "settled");
      rpc.state.transfers.push({
        from: paying.wallet.address.toLowerCase(),
        to: (payout.depositAddress ?? "").toLowerCase(),
        amount: payout.amountToTransferUsdc ?? 0n,
        logIndex: 7,
        blockNumber: rpc.state.latestBlock - 100n,
        txHash: randomTxHash(),
      });

      // #when
      const status = await resolve(payout, "paid");

      // #then
      expect({ status, bill: await statusOf(billId) }).toEqual({
        status: 200,
        bill: "paid",
      });
    });
  });
});

describe("POST /organizations/:id/bills/:billId/retry", () => {
  async function failedBill(): Promise<string> {
    const billId = await bill(await tillPayee());
    paycrest.state.nextCreateFailure = "refused";
    await pay([billId]);
    expect(await statusOf(billId)).toBe("payout_failed");
    return billId;
  }

  it("prepares a new payout with a new key and asks for the passkey again, sending nothing", async () => {
    // #given
    const billId = await failedBill();

    // #when
    const payment = await parsePayment(await retry(billId));

    // #then
    const rows = await payoutsOf(billId);
    expect({
      rows: rows.map((row) => [row.status, row.idempotencyKey]),
      preparedFor: payment.bills.map((preview) => preview.payoutId),
      bill: await statusOf(billId),
      ...moneyMoved(),
    }).toEqual({
      rows: [
        ["failed", `bill:${billId}:1`],
        ["awaiting_approval", `bill:${billId}:2`],
      ],
      preparedFor: [rows[1]?.id],
      bill: "payout_failed",
      orders: 0,
      sends: 0,
    });
  });

  it("pays once the admin confirms, at the bill's amount as it is now", async () => {
    // #given a failed bill whose amount is corrected
    const billId = await failedBill();
    const edited = await sendJson(app, `${billsPath()}/${billId}`, admin(), {
      method: "PATCH",
      body: { amountKes: "2,600", adjustmentReason: "Late fee" },
    });
    expect(edited.status).toBe(200);

    // #when
    const result = await paid(await parsePayment(await retry(billId)));

    // #then
    expect({
      bill: result.bills[0]?.status,
      payouts: (await payoutsOf(billId)).map((row) => [
        row.status,
        row.requestedKesCents,
      ]),
      ...moneyMoved(),
    }).toEqual({
      bill: "paying",
      payouts: [
        ["failed", BILL_KES],
        ["paying", 260_000n],
      ],
      orders: 1,
      sends: 1,
    });
  });

  it("refuses a bill whose payment hasn't failed", async () => {
    // #given
    const billId = await bill(await tillPayee());

    // #when
    const response = await retry(billId);

    // #then
    expect({
      status: response.status,
      payouts: await payoutsOf(billId),
    }).toEqual({ status: 409, payouts: [] });
  });

  it("applies the 24-hour hold, unless confirmed a second time", async () => {
    // #given
    const billId = await failedBill();
    const { payeeId } = await readBill(db, paying.company, billId);
    await ageDetailsChange(db, paying.company, payeeId, 1);

    // #when
    const held = await retry(billId);
    const confirmed = await retry(billId, { secondConfirmation: true });

    // #then
    expect([held.status, confirmed.status]).toEqual([409, 201]);
  });

  it("shows the bill as it now stands", async () => {
    // #given
    const billId = await failedBill();

    // #when
    const response = await sendJson(app, `${billsPath()}/${billId}`, admin());

    // #then
    expect(billDetailSchema.parse(await dataOf(response))).toMatchObject({
      status: "payout_failed",
      currency: "kes",
      amountKes: BILL_KES.toString(),
      amountUsdc: null,
    });
  });
});

describe("bills to payees paid in USDC are in USD (spec §6.19)", () => {
  const create = (body: Record<string, unknown>) =>
    sendJson(app, billsPath(), admin(), {
      method: "POST",
      body: { dueOn: nairobiDate(new Date()), categoryId, ...body },
    });

  it("takes the amount in USD and stores it as exact USDC", async () => {
    // #given
    const { payeeId } = await usdcPayee();

    // #when
    const response = await create({ payeeId, amountUsd: "1,250.75" });

    // #then
    expect(response.status).toBe(201);
    expect(billDetailSchema.parse(await dataOf(response))).toMatchObject({
      currency: "usd",
      amountUsdc: "1250750000",
      amountKes: null,
    });
  });

  it.each([
    [
      "a KES amount for a payee paid in USDC",
      "usdc",
      { amountKes: "2,500" },
      "enter the amount in USD",
    ],
    [
      "a USD amount for a payee paid in KES",
      "till",
      { amountUsd: "25" },
      "enter the amount in KES",
    ],
  ] as const)("refuses %s", async (_, method, amount, message) => {
    // #given
    const payeeId =
      method === "usdc" ? (await usdcPayee()).payeeId : await tillPayee();

    // #when
    const response = await create({ payeeId, ...amount });

    // #then
    expect(response.status).toBe(400);
    expect((await errorOf(response)).message).toContain(message);
  });

  it("needs the amount again in USD when a fixed bill moves to a payee paid in USDC", async () => {
    // #given
    const billId = await bill(await tillPayee());
    const { payeeId } = await usdcPayee();
    const edit = (body: Record<string, unknown>) =>
      sendJson(app, `${billsPath()}/${billId}`, admin(), {
        method: "PATCH",
        body: { payeeId, ...body },
      });

    // #when
    const withoutAmount = await edit({});
    const withAmount = await edit({
      amountUsd: "19.50",
      adjustmentReason: "Paid in USDC now",
    });

    // #then
    expect([withoutAmount.status, withAmount.status]).toEqual([400, 200]);
    expect(billDetailSchema.parse(await dataOf(withAmount))).toMatchObject({
      currency: "usd",
      amountKes: null,
      amountUsdc: "19500000",
    });
  });

  it("gives a recurring payment in USD bills in USD", async () => {
    // #given
    const { payeeId } = await usdcPayee();
    const today = nairobiDate(new Date());

    // #when
    const response = await sendJson(
      app,
      `/organizations/${paying.company.organizationId}/recurring-items`,
      admin(),
      {
        method: "POST",
        body: {
          payeeId,
          amountUsd: "20",
          schedule: "monthly",
          scheduleDay: Number(today.slice(8, 10)),
          startsOn: today,
          categoryId,
        },
      },
    );

    // #then
    expect(response.status).toBe(201);
    const item = recurringItemSchema.parse(await dataOf(response));
    expect({
      currency: item.currency,
      amountUsdc: item.amountUsdc,
      nextBill: item.nextBill?.amountUsdc,
      bill: (await readBill(db, paying.company, item.nextBill?.id ?? ""))
        .currency,
    }).toEqual({
      currency: "usd",
      amountUsdc: "20000000",
      nextBill: "20000000",
      bill: "usd",
    });
  });

  it("records a USD bill marked paid outside as company spending in KES at today's rate", async () => {
    // #given
    const { payeeId } = await usdcPayee();
    const billId = await bill(payeeId, {
      currency: "usd",
      amountKes: null,
      amountUsdc: 10n * USDC,
    });

    // #when
    const response = await sendJson(
      app,
      `${billsPath()}/${billId}/mark-paid-outside`,
      admin(),
      { method: "POST", body: { paidOn: nairobiDate(new Date()) } },
    );

    // #then
    expect(response.status).toBe(200);
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ amountKes: expenses.amountKes })
          .from(expenses)
          .where(eq(expenses.billId, billId)),
    );
    expect(rows.map((row) => row.amountKes)).toEqual([
      kesCentsFor(10n * USDC, "128.68"),
    ]);
  });
});
