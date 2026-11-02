import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  FloatApproval,
  FloatDetail,
  FloatPaymentResult,
  RecordFloatSpendingRequest,
} from "@expendi-business/shared";
import {
  claimApprovalSchema,
  claimDetailSchema,
  floatApprovalSchema,
  floatDetailSchema,
  floatPaymentResultSchema,
  floatSpendingResultSchema,
  floatsResponseSchema,
  resolvePreparedSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  expenses,
  floatMovements,
  floats,
  organizations,
  payouts,
  receiptFiles,
  users,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  addCategory,
  buyGoodsSms,
  pasteSms,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
  signPaycrestBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import {
  createPayingCompany,
  readPayout,
  updatePayout,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let paying: PayingCompany;
let categoryId: string;
let employee: TestUser;
let employeeMembershipId: string;

const HOUR_MS = 60 * 60_000;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    fileStorage: storage.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const randomPhone = () => `+2547${randomInt(10_000_000, 100_000_000)}`;

/** As T32 leaves a person who confirmed their number by SMS code. */
async function confirmPhone(
  user: TestUser,
  phone = randomPhone(),
): Promise<string> {
  await db
    .update(users)
    .set({ phone, phoneVerifiedAt: new Date(), fullName: "Jane Wanjiku" })
    .where(eq(users.id, user.id));
  return phone;
}

async function payableEmployee(
  company: TestCompany = paying.company,
): Promise<{ user: TestUser; membershipId: string }> {
  const user = await createUser(db);
  const membershipId = await addMember(db, company, user);
  await confirmPhone(user);
  return { user, membershipId };
}

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  paying = await createPayingCompany(runtime, db);
  categoryId = await addCategory(db, paying.company, "Office supplies");
  ({ user: employee, membershipId: employeeMembershipId } =
    await payableEmployee());
});

const admin = () => paying.company.admin;
const floatsPath = (company: TestCompany = paying.company) =>
  `/organizations/${company.organizationId}/floats`;

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

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Approval extends Omit<FloatApproval, "options"> {
  readonly options: SignOptions;
}

async function parseApproval(response: Response): Promise<Approval> {
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    ...floatApprovalSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

function issue(
  membershipId: string = employeeMembershipId,
  amountKes = "1,000",
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, floatsPath(), user, {
    method: "POST",
    body: { membershipId, amountKes },
  });
}

function topUp(
  floatId: string,
  amountKes = "500",
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, `${floatsPath()}/${floatId}/top-ups`, user, {
    method: "POST",
    body: { amountKes },
  });
}

function approveMovement(
  floatId: string,
  movementId: string,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(
    app,
    `${floatsPath()}/${floatId}/movements/${movementId}/approval`,
    user,
    { method: "POST" },
  );
}

function confirm(
  approval: Approval,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(
    app,
    `${floatsPath()}/approval/${approval.challengeId}/confirm`,
    user,
    {
      method: "POST",
      body: { response: paying.passkey.sign(approval.options, TEST_ORIGIN) },
    },
  );
}

async function paid(approval: Approval): Promise<FloatPaymentResult> {
  const response = await confirm(approval);
  expect(response.status).toBe(200);
  return floatPaymentResultSchema.parse(await dataOf(response));
}

async function floatAs(
  floatId: string,
  user: TestUser = admin(),
): Promise<FloatDetail> {
  const response = await sendJson(app, `${floatsPath()}/${floatId}`, user);
  expect(response.status).toBe(200);
  return floatDetailSchema.parse(await dataOf(response));
}

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

async function deliverWebhook(payout: Payout, status: string): Promise<void> {
  setOrder(payout, status);
  const body = JSON.stringify({
    event: `payment_order.${status}`,
    webhookVersion: "1",
    data: { id: payout.providerOrderId, status },
  });
  const response = await app.request("/webhooks/paycrest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paycrest-signature": signPaycrestBody(body),
    },
    body,
  });
  expect(response.status).toBe(200);
}

/** Paycrest settles the payment, through its signed webhook. */
async function settle(approval: Approval): Promise<void> {
  await deliverWebhook(
    await readPayout(db, paying.company, approval.payment.payoutId),
    "settled",
  );
}

/** A float issued, approved and paid: `amountKes` is on it. */
async function issuedFloat(amountKes = "1,000"): Promise<string> {
  const approval = await parseApproval(await issue(undefined, amountKes));
  await paid(approval);
  await settle(approval);
  return approval.float.id;
}

async function spend(
  floatId: string,
  overrides: Partial<RecordFloatSpendingRequest> = {},
  user: TestUser = employee,
): Promise<Response> {
  const receiptFileIds =
    overrides.receiptFileIds ??
    (overrides.noReceiptReason
      ? []
      : [
          (await uploadReceipt(app, storage, paying.company, user))
            .receiptFileId,
        ]);
  return sendJson(app, `${floatsPath()}/${floatId}/spending`, user, {
    method: "POST",
    body: {
      merchant: "Naivas Supermarket",
      amountKes: "300",
      spentOn: "2026-10-15",
      categoryId,
      description: "Printer paper",
      ...overrides,
      receiptFileIds,
    },
  });
}

async function spent(
  floatId: string,
  overrides: Partial<RecordFloatSpendingRequest> = {},
) {
  const response = await spend(floatId, overrides);
  expect(response.status).toBe(201);
  return floatSpendingResultSchema.parse(await dataOf(response));
}

async function auditOf(entityId: string, action: string) {
  const { rows } = await owner.query<{
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown>;
  }>(
    "SELECT actor_id, before, after FROM audit_log WHERE entity_id = $1 AND action = $2 ORDER BY occurred_at",
    [entityId, action],
  );
  return rows;
}

async function payoutsOf(movementId: string): Promise<Payout[]> {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select()
        .from(payouts)
        .where(
          and(
            eq(payouts.subjectType, "float"),
            eq(payouts.subjectId, movementId),
          ),
        )
        .orderBy(asc(payouts.createdAt)),
  );
}

async function movementRow(movementId: string) {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx.select().from(floatMovements).where(eq(floatMovements.id, movementId)),
  );
  if (!row) throw new Error(`movement ${movementId} not found`);
  return row;
}

const balanceOf = (float: FloatDetail) => ({
  issued: float.issuedKes,
  spent: float.spentKes,
  left: float.leftKes,
  onTheWay: float.onTheWayKes,
  awaitingApproval: float.awaitingApprovalKes,
});

describe("POST /organizations/:id/floats (issuing)", () => {
  it("opens the float and previews the payment, sending nothing", async () => {
    // #when
    const approval = await parseApproval(await issue());

    // #then
    expect({
      float: {
        status: approval.float.status,
        holder: approval.float.holder.membershipId,
        issued: approval.float.issuedKes,
        awaitingApproval: approval.float.awaitingApprovalKes,
      },
      movement: [
        approval.movement.type,
        approval.movement.status,
        approval.movement.phase,
      ],
      payment: {
        requestedKes: approval.payment.requestedKes,
        receivesKes: approval.payment.receivesKes,
        holderName: approval.payment.holderName,
      },
      ...moneyMoved(),
    }).toEqual({
      float: {
        status: "open",
        holder: employeeMembershipId,
        issued: "0",
        awaitingApproval: "100000",
      },
      movement: ["issue", "pending", "awaiting_approval"],
      payment: {
        requestedKes: "100000",
        receivesKes: "100000",
        holderName: "Jane Wanjiku",
      },
      orders: 0,
      sends: 0,
    });
    const [payout] = await payoutsOf(approval.movement.id);
    expect(payout?.idempotencyKey).toBe(`float:${approval.movement.id}:1`);
    expect(await auditOf(approval.float.id, "float.opened")).toHaveLength(1);
  });

  it("pays the employee once, and counts it only once it's paid", async () => {
    // #given
    const approval = await parseApproval(await issue());

    // #when
    const result = await paid(approval);
    const onItsWay = await floatAs(approval.float.id);
    await settle(approval);
    const settled = await floatAs(approval.float.id);

    // #then
    expect({
      result: [result.movement.status, result.movement.phase],
      onItsWay: balanceOf(onItsWay),
      settled: balanceOf(settled),
      movement: settled.movements.map((row) => [row.type, row.status]),
      ...moneyMoved(),
    }).toEqual({
      result: ["pending", "on_its_way"],
      onItsWay: {
        issued: "0",
        spent: "0",
        left: "0",
        onTheWay: "100000",
        awaitingApproval: "0",
      },
      settled: {
        issued: "100000",
        spent: "0",
        left: "100000",
        onTheWay: "0",
        awaitingApproval: "0",
      },
      movement: [["issue", "paid"]],
      orders: 1,
      sends: 1,
    });
    expect(
      await auditOf(approval.movement.id, "float.payment_paid"),
    ).toHaveLength(1);
  });

  it("pays to the employee's confirmed number", async () => {
    // #given
    const approval = await parseApproval(await issue());

    // #when
    await paid(approval);

    // #then
    const payout = await readPayout(
      db,
      paying.company,
      approval.payment.payoutId,
    );
    const [user] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, employee.id));
    expect(payout.recipient).toEqual({
      method: "mpesa_phone",
      phone: user?.phone,
      accountName: "Jane Wanjiku",
    });
  });

  it("refuses the same confirmation twice, still sending once", async () => {
    // #given
    const approval = await parseApproval(await issue());
    await paid(approval);

    // #when
    const again = await confirm(approval);

    // #then
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(moneyMoved()).toEqual({ orders: 1, sends: 1 });
  });

  it("is refused, creating nothing, while the employee has no confirmed M-Pesa number", async () => {
    // #given
    const user = await createUser(db);
    const membershipId = await addMember(db, paying.company, user);
    await db
      .update(users)
      .set({ fullName: "Otieno Kamau" })
      .where(eq(users.id, user.id));

    // #when
    const response = await issue(membershipId);

    // #then
    expect({
      status: response.status,
      message: (await errorOf(response)).message,
    }).toEqual({
      status: 409,
      message:
        "Otieno Kamau hasn't confirmed an M-Pesa number yet, so a float can't be paid to them until they do.",
    });
    const rows = await runInScope(
      db,
      { organizationId: paying.company.organizationId, role: "admin" },
      (tx) =>
        tx.select().from(floats).where(eq(floats.membershipId, membershipId)),
    );
    expect(rows).toEqual([]);
  });

  it("sends nothing when the number changed after preparing", async () => {
    // #given
    const approval = await parseApproval(await issue());
    await confirmPhone(employee);

    // #when
    const response = await confirm(approval);

    // #then
    expect(response.status).toBe(409);
    expect(moneyMoved()).toEqual({ orders: 0, sends: 0 });
  });

  it("allows one open float per person", async () => {
    // #given
    const first = await parseApproval(await issue());

    // #when
    const second = await issue(employeeMembershipId, "2,000");

    // #then
    expect({
      status: second.status,
      details: (await errorOf(second)).details,
    }).toEqual({ status: 409, details: { floatId: first.float.id } });
  });

  it("refuses a payment over the daily cap, sending nothing", async () => {
    // #given a KES 500 daily cap
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(organizations)
          .set({ dailyPayoutCapKes: 50_000n })
          .where(eq(organizations.id, paying.company.organizationId)),
    );
    const approval = await parseApproval(await issue());

    // #when
    const response = await confirm(approval);

    // #then
    expect({
      status: response.status,
      message: (await errorOf(response)).message,
      ...moneyMoved(),
      movement: (await movementRow(approval.movement.id)).status,
    }).toEqual({
      status: 409,
      message: "This would take today's payouts over the company's daily cap.",
      orders: 0,
      sends: 0,
      movement: "pending",
    });
  });

  it("refuses an employee", async () => {
    // #when
    const response = await issue(employeeMembershipId, "1,000", employee);

    // #then
    expect(response.status).toBe(403);
  });
});

describe("POST /organizations/:id/floats/:floatId/top-ups", () => {
  it("pays the top-up once, and adds it to the balance only once it's paid", async () => {
    // #given
    const floatId = await issuedFloat();
    const approval = await parseApproval(await topUp(floatId, "500"));

    // #when
    await paid(approval);
    const onItsWay = await floatAs(floatId);
    await settle(approval);
    const settled = await floatAs(floatId);

    // #then
    expect({
      onItsWay: [onItsWay.issuedKes, onItsWay.onTheWayKes],
      settled: [settled.issuedKes, settled.leftKes],
      movements: settled.movements.map((row) => [row.type, row.status]),
      ...moneyMoved(),
    }).toEqual({
      onItsWay: ["100000", "50000"],
      settled: ["150000", "150000"],
      movements: [
        ["top_up", "paid"],
        ["issue", "paid"],
      ],
      orders: 2,
      sends: 2,
    });
  });

  it("returns the same payment when asked twice for the same amount", async () => {
    // #given
    const floatId = await issuedFloat();
    const first = await parseApproval(await topUp(floatId, "500"));

    // #when
    const second = await parseApproval(await topUp(floatId, "500"));

    // #then
    expect({
      sameMovement: second.movement.id === first.movement.id,
      samePayout: second.payment.payoutId === first.payment.payoutId,
    }).toEqual({ sameMovement: true, samePayout: true });
  });

  it("replaces a top-up still waiting for approval with a new amount", async () => {
    // #given
    const floatId = await issuedFloat();
    const first = await parseApproval(await topUp(floatId, "500"));

    // #when
    const second = await parseApproval(await topUp(floatId, "700"));

    // #then
    expect({
      first: (await movementRow(first.movement.id)).status,
      firstPayout: (
        await readPayout(db, paying.company, first.payment.payoutId)
      ).status,
      second: second.movement.status,
      sent: await confirm(first).then((response) => response.status),
      ...moneyMoved(),
    }).toEqual({
      first: "failed",
      firstPayout: "failed",
      second: "pending",
      sent: 409,
      orders: 1,
      sends: 1,
    });
  });

  it("waits while an earlier payment is on its way", async () => {
    // #given
    const issued = await parseApproval(await issue());
    await paid(issued);

    // #when
    const response = await topUp(issued.float.id);

    // #then
    expect({
      status: response.status,
      message: (await errorOf(response)).message,
    }).toEqual({
      status: 409,
      message:
        "KES 1,000.00 is still on its way to Jane Wanjiku. Try again once it has arrived or failed.",
    });
  });

  it("refuses an employee", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const response = await topUp(floatId, "500", employee);

    // #then
    expect(response.status).toBe(403);
  });
});

describe("a failed float payment", () => {
  async function failedIssue(): Promise<Approval> {
    const approval = await parseApproval(await issue());
    paycrest.state.nextCreateFailure = "refused";
    const result = await paid(approval);
    expect(result.movement.status).toBe("failed");
    return approval;
  }

  it("doesn't count toward the balance", async () => {
    // #given
    const approval = await failedIssue();

    // #when
    const float = await floatAs(approval.float.id);

    // #then
    expect(balanceOf(float)).toEqual({
      issued: "0",
      spent: "0",
      left: "0",
      onTheWay: "0",
      awaitingApproval: "0",
    });
    expect(
      await auditOf(approval.movement.id, "float.payment_failed"),
    ).toHaveLength(1);
  });

  it("fails when Paycrest refunds the order", async () => {
    // #given
    const approval = await parseApproval(await issue());
    await paid(approval);

    // #when
    await deliverWebhook(
      await readPayout(db, paying.company, approval.payment.payoutId),
      "refunded",
    );

    // #then
    expect((await movementRow(approval.movement.id)).status).toBe("failed");
  });

  it("is retried with a new key and a fresh passkey, and paid once", async () => {
    // #given
    const failed = await failedIssue();

    // #when
    const retry = await parseApproval(
      await approveMovement(failed.float.id, failed.movement.id),
    );
    const beforeConfirming = moneyMoved();
    await paid(retry);
    await settle(retry);

    // #then
    expect({
      beforeConfirming,
      payouts: (await payoutsOf(failed.movement.id)).map((row) => [
        row.status,
        row.idempotencyKey,
      ]),
      movement: (await movementRow(failed.movement.id)).status,
      left: (await floatAs(failed.float.id)).leftKes,
      ...moneyMoved(),
    }).toEqual({
      beforeConfirming: { orders: 0, sends: 0 },
      payouts: [
        ["failed", `float:${failed.movement.id}:1`],
        ["paid", `float:${failed.movement.id}:2`],
      ],
      movement: "paid",
      left: "100000",
      orders: 1,
      sends: 1,
    });
  });

  it("resumes an issue left waiting for approval with the same payment", async () => {
    // #given
    const approval = await parseApproval(await issue());

    // #when
    const resumed = await parseApproval(
      await approveMovement(approval.float.id, approval.movement.id),
    );

    // #then
    expect(resumed.payment.payoutId).toBe(approval.payment.payoutId);
  });
});

describe("the float follows its payout when Expendi staff resolve it", () => {
  async function stuck(): Promise<{ approval: Approval; payout: Payout }> {
    const approval = await parseApproval(await issue());
    privy.state.nextSends("unknown");
    await paid(approval);
    await updatePayout(db, paying.company, approval.payment.payoutId, {
      fundingStartedAt: new Date(Date.now() - 2 * HOUR_MS),
      depositValidUntil: new Date(Date.now() - HOUR_MS),
    });
    return {
      approval,
      payout: await readPayout(db, paying.company, approval.payment.payoutId),
    };
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

  it("stays on its way while the payout is under review", async () => {
    // #given
    const { approval } = await stuck();

    // #when
    const float = await floatAs(approval.float.id);

    // #then
    expect({
      payout: (await readPayout(db, paying.company, approval.payment.payoutId))
        .status,
      phase: float.movements[0]?.phase,
      onTheWay: float.onTheWayKes,
    }).toEqual({
      payout: "needs_review",
      phase: "on_its_way",
      onTheWay: "100000",
    });
  });

  it("fails when staff close the payout as failed", async () => {
    // #given
    const { approval, payout } = await stuck();
    setOrder(payout, "expired");

    // #when
    const status = await resolve(payout, "failed");

    // #then
    expect({
      status,
      movement: (await movementRow(approval.movement.id)).status,
      left: (await floatAs(approval.float.id)).leftKes,
    }).toEqual({ status: 200, movement: "failed", left: "0" });
  });

  it("is paid when staff close the payout as paid", async () => {
    // #given
    const { approval, payout } = await stuck();
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
    expect({
      status,
      movement: (await movementRow(approval.movement.id)).status,
      left: (await floatAs(approval.float.id)).leftKes,
    }).toEqual({ status: 200, movement: "paid", left: "100000" });
  });
});

describe("approving a float payout with the engine directly", () => {
  it("is refused when no movement accounts for it", async () => {
    // #given
    const [payout] = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: admin().id },
        requests: [
          {
            subjectType: "float",
            subjectId: randomUUID(),
            idempotencyKey: `float:${randomUUID()}:1`,
            recipient: {
              method: "mpesa_phone",
              phone: randomPhone(),
              accountName: "Jane Wanjiku",
            },
            amountKesCents: 100_000n,
          },
        ],
      }),
    );
    if (!payout) throw new Error("nothing prepared");
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: admin().id,
        payoutIds: [payout.id],
      }),
    );

    // #when
    const exit = await runtime.runPromiseExit(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: admin().id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then
    expect({
      failed: exit._tag,
      payout: (await readPayout(db, paying.company, payout.id)).status,
    }).toEqual({ failed: "Failure", payout: "awaiting_approval" });
  });
});

describe("POST /organizations/:id/floats/:floatId/spending", () => {
  it("lowers the balance, recorded with no approval or payout", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const result = await spent(floatId, { amountKes: "300" });

    // #then
    const [row] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select()
          .from(expenses)
          .where(eq(expenses.id, result.spending?.id ?? "")),
    );
    expect({
      left: result.float.leftKes,
      spent: result.float.spentKes,
      claim: result.overspendClaim,
      row: [row?.kind, row?.status, row?.overviewHeading, row?.floatId],
      receipts: result.spending?.receiptCount,
      ...moneyMoved(),
    }).toEqual({
      left: "70000",
      spent: "30000",
      claim: null,
      row: ["float", "recorded", "petty_cash", floatId],
      receipts: 1,
      orders: 1,
      sends: 1,
    });
    expect(
      await auditOf(result.spending?.id ?? "", "expense.recorded"),
    ).toHaveLength(1);
  });

  it("turns spending over the balance into a submitted claim for exactly the extra", async () => {
    // #given KES 1,000 issued and KES 700 already spent
    const floatId = await issuedFloat();
    await spent(floatId, { amountKes: "700" });

    // #when a KES 450 purchase
    const result = await spent(floatId, { amountKes: "450" });

    // #then KES 300 from the float, KES 150 claimed
    const claimId = result.overspendClaim?.id ?? "";
    const [claim] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) => tx.select().from(expenses).where(eq(expenses.id, claimId)),
    );
    const files = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ expenseId: receiptFiles.expenseId })
          .from(receiptFiles)
          .where(eq(receiptFiles.expenseId, claimId)),
    );
    expect({
      spending: result.spending?.amountKes,
      claim: [
        claim?.kind,
        claim?.status,
        claim?.amountKes,
        claim?.floatId,
        claim?.membershipId,
      ],
      link: result.spending?.overspendClaim,
      receiptsOnClaim: files.length,
      spendingCountsThem: result.spending?.receiptCount,
      left: result.float.leftKes,
    }).toEqual({
      spending: "30000",
      claim: ["claim", "submitted", 15_000n, floatId, employeeMembershipId],
      link: { id: claimId, amountKes: "15000", status: "submitted" },
      receiptsOnClaim: 1,
      spendingCountsThem: 1,
      left: "0",
    });
    const [submitted] = await auditOf(claimId, "expense.submitted");
    expect(submitted?.after).toMatchObject({
      amountKes: "15000",
      floatOverspend: { purchaseKes: "45000", fromFloatKes: "30000" },
    });
  });

  it("never spends the same balance twice when two purchases arrive together", async () => {
    // #given KES 1,000 on the float
    const floatId = await issuedFloat();

    // #when two KES 600 purchases at once
    const responses = await Promise.all([
      spend(floatId, { amountKes: "600" }),
      spend(floatId, { amountKes: "600" }),
    ]);

    // #then KES 1,000 from the float, and only the KES 200 over it claimed
    const float = await floatAs(floatId);
    expect({
      statuses: responses.map((response) => response.status),
      spent: float.spentKes,
      left: float.leftKes,
      claimed: float.overspendClaims.map((claim) => claim.amountKes),
    }).toEqual({
      statuses: [201, 201],
      spent: "100000",
      left: "0",
      claimed: ["20000"],
    });
  });

  it("waits for the float's lock, so no two purchases spend what's left at once", async () => {
    // #given another transaction locking the float's row, in a mode that
    // still lets foreign keys to it be checked
    const floatId = await issuedFloat();
    let release: () => void = () => undefined;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signalLocked: () => void = () => undefined;
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve;
    });
    const holding = runInScope(
      db,
      {
        organizationId: paying.company.organizationId,
        userId: admin().id,
        role: "admin",
      },
      async (tx) => {
        await tx
          .select({ id: floats.id })
          .from(floats)
          .where(eq(floats.id, floatId))
          .for("no key update");
        signalLocked();
        await released;
      },
    );
    await locked;

    // #when the holder records spending meanwhile
    let finished = false;
    const spending = spend(floatId).then((response) => {
      finished = true;
      return response;
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const finishedWhileLocked = finished;
    release();
    await holding;

    // #then it waited, then went through
    expect({
      finishedWhileLocked,
      status: (await spending).status,
    }).toEqual({ finishedWhileLocked: false, status: 201 });
  });

  it("makes the whole purchase a claim when nothing is left", async () => {
    // #given
    const floatId = await issuedFloat();
    await spent(floatId, { amountKes: "1,000" });

    // #when
    const result = await spent(floatId, { amountKes: "200" });

    // #then
    expect({
      spending: result.spending,
      claim: result.overspendClaim?.amountKes,
      claims: (await floatAs(floatId)).overspendClaims.map(
        (claim) => claim.amountKes,
      ),
    }).toEqual({ spending: null, claim: "20000", claims: ["20000"] });
  });

  it("can be approved and paid like any claim", async () => {
    // #given
    const floatId = await issuedFloat();
    const result = await spent(floatId, { amountKes: "1,250" });
    const claimId = result.overspendClaim?.id ?? "";

    // #when
    const prepared = await sendJson(
      app,
      `/organizations/${paying.company.organizationId}/claims/approval`,
      admin(),
      { method: "POST", body: { claimIds: [claimId] } },
    );

    // #then
    expect(prepared.status).toBe(201);
    const data = await dataOf(prepared);
    expect(claimApprovalSchema.parse(data).claims[0]?.claimedKes).toBe("25000");
  });

  it("keeps the M-Pesa code on the claim, so the same SMS can't be recorded twice", async () => {
    // #given
    const floatId = await issuedFloat();
    const sms = await pasteSms(
      app,
      paying.company,
      employee,
      buyGoodsSms({ code: "SKL3FLOAT1", amount: "1,200.00" }),
    );
    const first = await spent(floatId, {
      amountKes: "1,200",
      receiptFileIds: [sms.receiptFileId],
    });

    // #when the same purchase again, with a different paste of the same code
    const again = await pasteSms(
      app,
      paying.company,
      employee,
      buyGoodsSms({ code: "SKL3FLOAT1", amount: "1,200.00", date: "16/10/26" }),
    );
    const response = await spend(floatId, {
      amountKes: "1,200",
      receiptFileIds: [again.receiptFileId],
    });

    // #then
    const [claim] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ mpesaCode: expenses.mpesaCode })
          .from(expenses)
          .where(eq(expenses.id, first.overspendClaim?.id ?? "")),
    );
    expect({
      claimCode: claim?.mpesaCode,
      status: response.status,
    }).toEqual({ claimCode: "SKL3FLOAT1", status: 409 });
  });

  it("refuses an overspend with no receipt, recording nothing", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const response = await spend(floatId, {
      amountKes: "1,500",
      noReceiptReason: "Kiosk gave no receipt",
    });

    // #then
    expect({
      status: response.status,
      message: (await errorOf(response)).message,
      spent: (await floatAs(floatId)).spentKes,
    }).toEqual({
      status: 400,
      message:
        "Only KES 1,000.00 is left on your float, so KES 500.00 becomes a claim, and a claim needs a receipt. Add a photo or screenshot of the receipt, or paste the M-Pesa SMS.",
      spent: "0",
    });
  });

  it("takes spending without a receipt when the holder says why, and flags it", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const result = await spent(floatId, {
      noReceiptReason: "Kiosk gave no receipt",
    });

    // #then
    expect({
      noReceipt: result.spending?.noReceipt,
      reason: result.spending?.noReceiptReason,
      flagged: (await floatAs(floatId)).noReceiptCount,
    }).toEqual({
      noReceipt: true,
      reason: "Kiosk gave no receipt",
      flagged: 1,
    });
  });

  it("needs a receipt or a reason", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const response = await spend(floatId, { receiptFileIds: [] });

    // #then
    expect(response.status).toBe(400);
  });

  it("is only for the person holding the float", async () => {
    // #given
    const floatId = await issuedFloat();
    const { user: colleague } = await payableEmployee();

    // #when
    const byAdmin = await spend(floatId, {}, admin());
    const byColleague = await spend(floatId, {}, colleague);

    // #then
    expect([byAdmin.status, byColleague.status]).toEqual([403, 404]);
  });

  it("is refused on a closed float", async () => {
    // #given
    const floatId = await issuedFloat();
    await sendJson(app, `${floatsPath()}/${floatId}/close`, admin(), {
      method: "POST",
      body: { writeOffReason: "Lost with the cash box" },
    });

    // #when
    const response = await spend(floatId);

    // #then
    expect(response.status).toBe(409);
  });
});

describe("an overspend claim", () => {
  const claimPath = (claimId: string) =>
    `/organizations/${paying.company.organizationId}/claims/${claimId}`;

  function editClaim(
    claimId: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    return sendJson(app, claimPath(claimId), employee, {
      method: "PATCH",
      body,
    });
  }

  async function claimAs(claimId: string, user: TestUser = admin()) {
    const response = await sendJson(app, claimPath(claimId), user);
    expect(response.status).toBe(200);
    return claimDetailSchema.parse(await dataOf(response));
  }

  it("can be edited when its receipt is the M-Pesa SMS for the whole purchase", async () => {
    // #given KES 1,000 on the float and a KES 1,200 purchase paid by M-Pesa
    const floatId = await issuedFloat();
    const sms = await pasteSms(
      app,
      paying.company,
      employee,
      buyGoodsSms({ code: "SKL3OVER01", amount: "1,200.00" }),
    );
    const result = await spent(floatId, {
      amountKes: "1,200",
      receiptFileIds: [sms.receiptFileId],
    });
    const claimId = result.overspendClaim?.id ?? "";

    // #when the holder fixes the description on the KES 200 claim
    const response = await editClaim(claimId, {
      description: "Printer paper and toner",
    });

    // #then
    expect({
      status: response.status,
      claim: await claimAs(claimId).then((claim) => [
        claim.description,
        claim.amountKes,
        claim.mpesaCode,
      ]),
    }).toEqual({
      status: 200,
      claim: ["Printer paper and toner", "20000", "SKL3OVER01"],
    });
  });

  it("still refuses an M-Pesa code that contradicts its SMS", async () => {
    // #given
    const floatId = await issuedFloat();
    const sms = await pasteSms(
      app,
      paying.company,
      employee,
      buyGoodsSms({ code: "SKL3OVER02", amount: "1,200.00" }),
    );
    const result = await spent(floatId, {
      amountKes: "1,200",
      receiptFileIds: [sms.receiptFileId],
    });

    // #when
    const response = await editClaim(result.overspendClaim?.id ?? "", {
      mpesaCode: "SKL3WRONG9",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an amount change, since the float spending decides the extra", async () => {
    // #given a KES 1,250 purchase: KES 1,000 from the float, KES 250 claimed
    const floatId = await issuedFloat();
    const result = await spent(floatId, { amountKes: "1,250" });
    const claimId = result.overspendClaim?.id ?? "";

    // #when
    const changed = await editClaim(claimId, { amountKes: "500" });
    const unchanged = await editClaim(claimId, {
      amountKes: "250",
      description: "Printer paper, receipt attached",
    });

    // #then
    expect({
      changed: changed.status,
      message: (await errorOf(changed)).message,
      unchanged: unchanged.status,
      amount: (await claimAs(claimId)).amountKes,
    }).toEqual({
      changed: 409,
      message:
        "This claim is the part of a petty cash purchase over the float, so its amount comes from that purchase and can't be changed.",
      unchanged: 200,
      amount: "25000",
    });
  });

  it("shows which float it came from, and a plain claim shows none", async () => {
    // #given
    const floatId = await issuedFloat();
    const result = await spent(floatId, { amountKes: "1,100" });
    const plain = await sendJson(
      app,
      `/organizations/${paying.company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: {
          merchant: "Java House",
          amountKes: "450",
          spentOn: "2026-10-15",
          categoryId,
          description: "Team lunch",
          receiptFileIds: [
            (await uploadReceipt(app, storage, paying.company, employee))
              .receiptFileId,
          ],
        },
      },
    );
    expect(plain.status).toBe(201);
    const plainId = claimDetailSchema.parse(await dataOf(plain)).id;

    // #when
    const overspend = await claimAs(result.overspendClaim?.id ?? "", employee);
    const other = await claimAs(plainId, employee);

    // #then
    expect([overspend.floatId, other.floatId]).toEqual([floatId, null]);
  });

  it("isn't flagged as a near-duplicate of its own float spending when its warnings are recomputed", async () => {
    // #given a KES 2,000 purchase: KES 1,000 from the float and KES 1,000
    // claimed, the same person, amount and day
    const floatId = await issuedFloat();
    const result = await spent(floatId, { amountKes: "2,000" });
    const claimId = result.overspendClaim?.id ?? "";

    // #when an edit recomputes the claim's warnings
    const response = await editClaim(claimId, {
      description: "Printer paper for the quarter",
    });

    // #then
    expect(response.status).toBe(200);
    expect((await claimAs(claimId)).warnings).toEqual([]);
  });
});

describe("who sees which float", () => {
  it("shows an employee only their own float, and an admin every float", async () => {
    // #given
    const mine = await issuedFloat();
    const { user: colleague, membershipId } = await payableEmployee();
    const theirs = await parseApproval(await issue(membershipId));

    // #when
    const asEmployee = await sendJson(app, floatsPath(), employee);
    const asAdmin = await sendJson(app, floatsPath(), admin());
    const colleagueReadsMine = await sendJson(
      app,
      `${floatsPath()}/${mine}`,
      colleague,
    );

    // #then
    const ids = async (response: Response) =>
      floatsResponseSchema
        .parse(await dataOf(response))
        .floats.map((float) => float.id)
        .sort();
    expect({
      employee: await ids(asEmployee),
      admin: await ids(asAdmin),
      colleague: colleagueReadsMine.status,
    }).toEqual({
      employee: [mine],
      admin: [mine, theirs.float.id].sort(),
      colleague: 404,
    });
  });

  it("hides another person's float and movements in the database itself", async () => {
    // #given
    const mine = await issuedFloat();
    const { user: colleague, membershipId } = await payableEmployee();
    const theirs = await parseApproval(await issue(membershipId));

    // #when an unfiltered read in the colleague's transaction
    const scope = {
      organizationId: paying.company.organizationId,
      userId: colleague.id,
      role: "employee" as const,
    };
    const seenFloats = await runInScope(db, scope, (tx) =>
      tx.select({ id: floats.id }).from(floats),
    );
    const seenMovements = await runInScope(db, scope, (tx) =>
      tx.select({ floatId: floatMovements.floatId }).from(floatMovements),
    );
    const adminSees = await runInScope(
      db,
      { ...scope, userId: admin().id, role: "admin" },
      (tx) => tx.select({ id: floats.id }).from(floats),
    );

    // #then
    expect({
      floats: seenFloats.map((row) => row.id),
      movements: seenMovements.map((row) => row.floatId),
      admin: adminSees.map((row) => row.id).sort(),
    }).toEqual({
      floats: [theirs.float.id],
      movements: [theirs.float.id],
      admin: [mine, theirs.float.id].sort(),
    });
  });

  it("lets the holder lock their float but not change it", async () => {
    // #given
    const floatId = await issuedFloat();
    const scope = {
      organizationId: paying.company.organizationId,
      userId: employee.id,
      role: "employee" as const,
    };

    // #when
    const update = runInScope(db, scope, (tx) =>
      tx
        .update(floats)
        .set({ status: "closed", closedAt: new Date(), closedBy: employee.id })
        .where(eq(floats.id, floatId)),
    );

    // #then
    await expect(update).rejects.toThrow();
    expect((await floatAs(floatId)).status).toBe("open");
  });
});

describe("returns and closing", () => {
  function recordReturn(floatId: string, amountKes: string, note?: string) {
    return sendJson(app, `${floatsPath()}/${floatId}/returns`, admin(), {
      method: "POST",
      body: { amountKes, note },
    });
  }

  function close(floatId: string, writeOffReason?: string) {
    return sendJson(app, `${floatsPath()}/${floatId}/close`, admin(), {
      method: "POST",
      body: writeOffReason === undefined ? {} : { writeOffReason },
    });
  }

  it("records cash handed back, then closes once nothing is left", async () => {
    // #given
    const floatId = await issuedFloat();
    await spent(floatId, { amountKes: "300" });

    // #when
    const returned = await recordReturn(floatId, "700", "Handed back in cash");
    const closed = await close(floatId);

    // #then
    expect(returned.status).toBe(201);
    expect(closed.status).toBe(200);
    const float = floatDetailSchema.parse(await dataOf(closed));
    expect({
      status: float.status,
      returned: float.returnedKes,
      left: float.leftKes,
      writtenOff: float.writtenOffKes,
    }).toEqual({
      status: "closed",
      returned: "70000",
      left: "0",
      writtenOff: "0",
    });
    expect(await auditOf(floatId, "float.closed")).toHaveLength(1);
  });

  it("refuses a return of more than is left", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const response = await recordReturn(floatId, "1,001");

    // #then
    expect({
      status: response.status,
      message: (await errorOf(response)).message,
    }).toEqual({
      status: 409,
      message: "Only KES 1,000.00 is left on this float.",
    });
  });

  it("won't close with money left unless the rest is written off with a reason", async () => {
    // #given
    const floatId = await issuedFloat();
    await spent(floatId, { amountKes: "400" });

    // #when
    const refused = await close(floatId);
    const writtenOff = await close(floatId, "Cash box lost in the move");

    // #then
    expect(refused.status).toBe(409);
    expect(writtenOff.status).toBe(200);
    const float = floatDetailSchema.parse(await dataOf(writtenOff));
    expect({
      status: float.status,
      writtenOff: float.writtenOffKes,
      left: float.leftKes,
      movement: [float.movements[0]?.type, float.movements[0]?.note],
    }).toEqual({
      status: "closed",
      writtenOff: "60000",
      left: "0",
      movement: ["write_off", "Cash box lost in the move"],
    });
  });

  it("refuses a write-off reason when nothing is left", async () => {
    // #given
    const floatId = await issuedFloat();
    await recordReturn(floatId, "1,000");

    // #when
    const response = await close(floatId, "Nothing to see here");

    // #then
    expect(response.status).toBe(400);
  });

  it("won't close while a payment is on its way", async () => {
    // #given
    const approval = await parseApproval(await issue());
    await paid(approval);

    // #when
    const response = await close(approval.float.id);

    // #then
    expect(response.status).toBe(409);
    expect((await floatAs(approval.float.id)).status).toBe("open");
  });

  it("withdraws a payment still waiting for approval, which then sends nothing", async () => {
    // #given
    const approval = await parseApproval(await issue());

    // #when
    const closed = await close(approval.float.id);
    const confirmed = await confirm(approval);

    // #then
    expect({
      closed: closed.status,
      movement: (await movementRow(approval.movement.id)).status,
      confirmed: confirmed.status,
      ...moneyMoved(),
    }).toEqual({
      closed: 200,
      movement: "failed",
      confirmed: 409,
      orders: 0,
      sends: 0,
    });
  });

  it("lets the person have a new float once the old one is closed", async () => {
    // #given
    const floatId = await issuedFloat();
    await recordReturn(floatId, "1,000");
    await close(floatId);

    // #when
    const response = await issue();

    // #then
    expect(response.status).toBe(201);
  });

  it("refuses an employee", async () => {
    // #given
    const floatId = await issuedFloat();

    // #when
    const returned = await sendJson(
      app,
      `${floatsPath()}/${floatId}/returns`,
      employee,
      { method: "POST", body: { amountKes: "100" } },
    );
    const closed = await sendJson(
      app,
      `${floatsPath()}/${floatId}/close`,
      employee,
      { method: "POST", body: {} },
    );

    // #then
    expect([returned.status, closed.status]).toEqual([403, 403]);
  });
});

describe("company isolation", () => {
  let fixture: IsolationFixture;
  let floatOfA: string;

  beforeEach(async () => {
    fixture = await createIsolationFixture(db);
    const seed = async (company: TestCompany) => {
      const user = await createUser(db);
      const membershipId = await addMember(db, company, user);
      const [float] = await runInScope(
        db,
        {
          organizationId: company.organizationId,
          userId: company.admin.id,
          role: "admin",
        },
        async (tx) => {
          const rows = await tx
            .insert(floats)
            .values({ organizationId: company.organizationId, membershipId })
            .returning({ id: floats.id });
          const [created] = rows;
          if (!created) throw new Error("float insert returned no row");
          await tx.insert(floatMovements).values({
            organizationId: company.organizationId,
            floatId: created.id,
            type: "return",
            status: "recorded",
            amountKes: 100n,
            recordedBy: company.admin.id,
          });
          return rows;
        },
      );
      if (!float) throw new Error("no float");
      return float.id;
    };
    floatOfA = await seed(fixture.companyA);
    await seed(fixture.companyB);
  });

  it("keeps floats and their movements within the company", async () => {
    // #given each company's float and movement (seeded above)
    // #when / #then
    await expectTableIsolation(fixture, "floats", "organization_id", "admin");
    await expectTableIsolation(
      fixture,
      "float_movements",
      "organization_id",
      "admin",
    );
  });

  it("keeps every float route within the company", async () => {
    // #given
    const movementId = randomUUID();
    const challengeId = randomUUID();
    const routes: {
      path: (organizationId: string) => string;
      init?: RequestInit;
    }[] = [
      { path: (id) => `/organizations/${id}/floats` },
      { path: (id) => `/organizations/${id}/floats/${floatOfA}` },
      {
        path: (id) => `/organizations/${id}/floats`,
        init: {
          method: "POST",
          body: JSON.stringify({ membershipId: randomUUID(), amountKes: "1" }),
        },
      },
      {
        path: (id) => `/organizations/${id}/floats/${floatOfA}/top-ups`,
        init: { method: "POST", body: JSON.stringify({ amountKes: "1" }) },
      },
      {
        path: (id) =>
          `/organizations/${id}/floats/${floatOfA}/movements/${movementId}/approval`,
        init: { method: "POST" },
      },
      {
        path: (id) =>
          `/organizations/${id}/floats/approval/${challengeId}/confirm`,
        init: { method: "POST", body: JSON.stringify({}) },
      },
      {
        path: (id) => `/organizations/${id}/floats/${floatOfA}/spending`,
        init: { method: "POST", body: JSON.stringify({}) },
      },
      {
        path: (id) => `/organizations/${id}/floats/${floatOfA}/returns`,
        init: { method: "POST", body: JSON.stringify({ amountKes: "1" }) },
      },
      {
        path: (id) => `/organizations/${id}/floats/${floatOfA}/close`,
        init: { method: "POST", body: JSON.stringify({}) },
      },
    ];

    // #when / #then
    for (const route of routes) {
      await expectRouteIsolation(app, fixture, (organizationId) => ({
        path: route.path(organizationId),
        init: {
          ...route.init,
          headers: { "content-type": "application/json" },
        },
      }));
    }
  });
});
