import { randomInt, randomUUID } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ClaimApproval,
  ClaimDetail,
  ClaimPaymentResult,
} from "@expendi-business/shared";
import {
  claimApprovalSchema,
  claimDetailSchema,
  claimPaymentResultSchema,
  claimsPageSchema,
  resolvePreparedSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  expenses,
  organizations,
  payouts,
  users,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { usdcCovering } from "../../services/paycrest/amounts.js";
import { maxDebitFor } from "../../services/payout/prepare.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  addCategory,
  claimRequest,
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
} from "../helpers/isolation.js";
import { saveTreasuryMove } from "../helpers/money-in.js";
import {
  createPayingCompany,
  readPayout,
  updatePayout,
  USDC,
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
let employeePhone: string;

/** KES 1,500.50 rounds up to KES 1,501 at the fake's 128.68 KES/USDC. */
const CLAIMED = "1,500.50";
const RECEIVES_KES = 150_100n;
const QUOTED_USDC = usdcCovering(RECEIVES_KES, "128.68");
const MAX_DEBIT = maxDebitFor(QUOTED_USDC);
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
  fullName: string | null = "Jane Wanjiku",
): Promise<string> {
  await db
    .update(users)
    .set({ phone, phoneVerifiedAt: new Date(), fullName })
    .where(eq(users.id, user.id));
  return phone;
}

/** Named, but without a confirmed M-Pesa number yet. */
async function unconfirmedEmployee(): Promise<TestUser> {
  const user = await createUser(db);
  await addMember(db, paying.company, user);
  await db
    .update(users)
    .set({ fullName: "Otieno Kamau" })
    .where(eq(users.id, user.id));
  return user;
}

async function payableEmployee(company: TestCompany): Promise<TestUser> {
  const user = await createUser(db);
  await addMember(db, company, user);
  await confirmPhone(user);
  return user;
}

async function setUpCompany(balance = 100n * USDC): Promise<void> {
  paying = await createPayingCompany(runtime, db, balance);
  categoryId = await addCategory(db, paying.company, "Meals");
  employee = await createUser(db);
  await addMember(db, paying.company, employee);
  employeePhone = await confirmPhone(employee);
}

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  await setUpCompany();
});

const claimsPath = (company: TestCompany = paying.company) =>
  `/organizations/${company.organizationId}/claims`;

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

async function submit(
  user: TestUser = employee,
  amountKes = CLAIMED,
  company: TestCompany = paying.company,
  category: string = categoryId,
): Promise<ClaimDetail> {
  const upload = await uploadReceipt(app, storage, company, user);
  const response = await sendJson(app, claimsPath(company), user, {
    method: "POST",
    body: claimRequest({
      receiptFileIds: [upload.receiptFileId],
      categoryId: category,
      amountKes,
    }),
  });
  expect(response.status).toBe(201);
  return claimDetailSchema.parse(await dataOf(response));
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Approval extends Omit<ClaimApproval, "options"> {
  readonly options: SignOptions;
}

const admin = () => paying.company.admin;

function prepare(
  claimIds: readonly string[],
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, `${claimsPath()}/approval`, user, {
    method: "POST",
    body: { claimIds },
  });
}

async function parseApproval(response: Response): Promise<Approval> {
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    ...claimApprovalSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

async function approvalFor(claimIds: readonly string[]): Promise<Approval> {
  return parseApproval(await prepare(claimIds));
}

function sendConfirmation(
  approval: Approval,
  response: ReturnType<SoftwarePasskey["sign"]>,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(
    app,
    `${claimsPath()}/approval/${approval.challengeId}/confirm`,
    user,
    { method: "POST", body: { response } },
  );
}

function confirm(
  approval: Approval,
  user: TestUser = admin(),
): Promise<Response> {
  return sendConfirmation(
    approval,
    paying.passkey.sign(approval.options, TEST_ORIGIN),
    user,
  );
}

async function paid(approval: Approval): Promise<ClaimPaymentResult> {
  const response = await confirm(approval);
  expect(response.status).toBe(200);
  return claimPaymentResultSchema.parse(await dataOf(response));
}

/** Prepares and confirms one claim; returns its payout. */
async function approveAndPay(claimId: string): Promise<Payout> {
  const approval = await approvalFor([claimId]);
  await paid(approval);
  const [payout] = approval.claims;
  if (!payout) throw new Error("no payout");
  return readPayout(db, paying.company, payout.payoutId);
}

function retry(claimId: string, user: TestUser = admin()): Promise<Response> {
  return sendJson(app, `${claimsPath()}/${claimId}/retry`, user, {
    method: "POST",
  });
}

function reject(
  claimId: string,
  reason: unknown,
  user: TestUser = admin(),
): Promise<Response> {
  return sendJson(app, `${claimsPath()}/${claimId}/reject`, user, {
    method: "POST",
    body: { reason },
  });
}

async function claimAs(claimId: string, user: TestUser): Promise<ClaimDetail> {
  const response = await sendJson(app, `${claimsPath()}/${claimId}`, user);
  expect(response.status).toBe(200);
  return claimDetailSchema.parse(await dataOf(response));
}

async function claimRow(claimId: string) {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) => tx.select().from(expenses).where(eq(expenses.id, claimId)),
  );
  if (!row) throw new Error(`claim ${claimId} not found`);
  return row;
}

async function payoutsOf(claimId: string): Promise<Payout[]> {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select()
        .from(payouts)
        .where(
          and(eq(payouts.subjectType, "claim"), eq(payouts.subjectId, claimId)),
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

describe("POST /organizations/:id/claims/approval", () => {
  it("previews what the employee receives, the USDC, the fee allowance and the total", async () => {
    // #given
    const claim = await submit();

    // #when
    const approval = await approvalFor([claim.id]);

    // #then
    const [payout] = await payoutsOf(claim.id);
    expect(approval.claims).toEqual([
      {
        claimId: claim.id,
        payoutId: payout?.id,
        claimantName: "Jane Wanjiku",
        phoneLast4: employeePhone.slice(-4),
        claimedKes: "150050",
        receivesKes: RECEIVES_KES.toString(),
        rate: "128.68",
        usdc: QUOTED_USDC.toString(),
        feeAllowanceUsdc: (MAX_DEBIT - QUOTED_USDC).toString(),
        maxDebitUsdc: MAX_DEBIT.toString(),
      },
    ]);
    expect({ totals: approval.totals, wallet: approval.wallet }).toEqual({
      totals: {
        receivesKes: RECEIVES_KES.toString(),
        usdc: QUOTED_USDC.toString(),
        feeAllowanceUsdc: (MAX_DEBIT - QUOTED_USDC).toString(),
        maxDebitUsdc: MAX_DEBIT.toString(),
      },
      wallet: {
        availableUsdc: (100n * USDC).toString(),
        shortfallUsdc: "0",
        topUpKes: null,
      },
    });
  });

  it("previews exactly what the engine reserves: the previewed total is enough, and nothing less is", async () => {
    // #given a wallet holding exactly the previewed total
    await setUpCompany(MAX_DEBIT);
    const claim = await submit();
    const approval = await approvalFor([claim.id]);
    const [payout] = await payoutsOf(claim.id);

    // #when
    const response = await confirm(approval);

    // #then
    expect({
      previewed: approval.totals.maxDebitUsdc,
      reserved: payout?.maxDebitUsdc.toString(),
      status: response.status,
      claim: (await claimRow(claim.id)).status,
    }).toEqual({
      previewed: MAX_DEBIT.toString(),
      reserved: MAX_DEBIT.toString(),
      status: 200,
      claim: "paying",
    });
  });

  it("counts what an open move to Treasury still has to send as spent: shows Top up KES X and refuses to pay", async () => {
    // #given a wallet holding 5 USDC more than a claim needs, 7 of which an
    // open move to Treasury has reserved: 2 USDC short
    await setUpCompany(MAX_DEBIT + 5n * USDC);
    await saveTreasuryMove(
      db,
      { company: paying.company, walletId: paying.wallet.id },
      { requestedUsdc: 7n * USDC },
    );
    const claim = await submit();

    // #when
    const approval = await approvalFor([claim.id]);
    const response = await confirm(approval);

    // #then
    expect({
      wallet: approval.wallet,
      status: response.status,
      claim: (await claimRow(claim.id)).status,
    }).toEqual({
      wallet: {
        availableUsdc: (MAX_DEBIT - 2n * USDC).toString(),
        shortfallUsdc: (2n * USDC).toString(),
        topUpKes: "25800",
      },
      status: 409,
      claim: "submitted",
    });
  });

  it("shows Top up KES X when the wallet is short, and refuses to pay", async () => {
    // #given 2 USDC short: 2 × 128.68 = KES 257.36, so top up KES 258
    await setUpCompany(MAX_DEBIT - 2n * USDC);
    const claim = await submit();

    // #when
    const approval = await approvalFor([claim.id]);
    const response = await confirm(approval);

    // #then
    expect(approval.wallet).toEqual({
      availableUsdc: (MAX_DEBIT - 2n * USDC).toString(),
      shortfallUsdc: (2n * USDC).toString(),
      topUpKes: "25800",
    });
    expect(response.status).toBe(409);
    const error = await errorOf(response);
    expect(error.message).toContain("Top up KES 258,");
    expect(error.details).toEqual({
      shortfallUsdc: (2n * USDC).toString(),
      topUpKes: "25800",
    });
    expect({
      ...moneyMoved(),
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ orders: 0, sends: 0, claim: "submitted" });
  });

  it("prepares a batch with one approval covering every claim", async () => {
    // #given
    const first = await submit();
    const second = await submit(await payableEmployee(paying.company), "250");

    // #when
    const approval = await approvalFor([first.id, second.id]);
    const result = await paid(approval);

    // #then
    expect(approval.totals.receivesKes).toBe(
      (RECEIVES_KES + 25_000n).toString(),
    );
    expect(result.claims.map((claim) => claim.status).sort()).toEqual([
      "paying",
      "paying",
    ]);
    expect(moneyMoved()).toEqual({ orders: 2, sends: 2 });
  });

  describe("pays exactly once", () => {
    it("moves the claim to paying and sends once", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);

      // #when
      const result = await paid(approval);

      // #then
      const [payout] = await payoutsOf(claim.id);
      expect(result.claims).toEqual([
        {
          claimId: claim.id,
          status: "paying",
          payout: { id: payout?.id, status: "paying", failureReason: null },
        },
      ]);
      expect(moneyMoved()).toEqual({ orders: 1, sends: 1 });
      expect(privy.state.sends[0]?.idempotencyKey).toBe(`payout-${payout?.id}`);
      expect(payout?.idempotencyKey).toBe(`claim:${claim.id}:1`);
    });

    it("records who approved it and when, in the approval's transaction", async () => {
      // #given
      const claim = await submit();

      // #when
      const payout = await approveAndPay(claim.id);

      // #then
      const row = await claimRow(claim.id);
      expect({
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt?.toISOString(),
        payoutId: row.payoutId,
      }).toEqual({
        approvedBy: admin().id,
        approvedAt: payout.approvedAt?.toISOString(),
        payoutId: payout.id,
      });
      expect(await auditOf(claim.id, "expense.approved")).toMatchObject([
        {
          actor_id: admin().id,
          before: { status: "submitted" },
          after: { status: "paying", payoutId: payout.id, selfApproval: false },
        },
      ]);
    });

    it("refuses the same confirmation twice", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);
      const signed = paying.passkey.sign(approval.options, TEST_ORIGIN);
      await sendConfirmation(approval, signed);

      // #when
      const replay = await sendConfirmation(approval, signed);

      // #then
      expect({ status: replay.status, ...moneyMoved() }).toEqual({
        status: 403,
        orders: 1,
        sends: 1,
      });
    });

    it("pays once when the same confirmation arrives twice at the same time", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);
      const signed = paying.passkey.sign(approval.options, TEST_ORIGIN);

      // #when
      const responses = await Promise.all([
        sendConfirmation(approval, signed),
        sendConfirmation(approval, signed),
      ]);

      // #then
      expect({
        statuses: responses.map((response) => response.status).sort(),
        ...moneyMoved(),
      }).toEqual({ statuses: [200, 403], orders: 1, sends: 1 });
    });

    it("pays once when two approvals of the same claim are confirmed together", async () => {
      // #given two challenges for the one payout
      const claim = await submit();
      const first = await approvalFor([claim.id]);
      const second = await approvalFor([claim.id]);

      // #when
      const responses = await Promise.all([confirm(first), confirm(second)]);

      // #then
      expect({
        samePayout: first.claims[0]?.payoutId === second.claims[0]?.payoutId,
        statuses: responses.map((response) => response.status).sort(),
        payouts: (await payoutsOf(claim.id)).length,
        ...moneyMoved(),
      }).toEqual({
        samePayout: true,
        statuses: [200, 409],
        payouts: 1,
        orders: 1,
        sends: 1,
      });
    });

    it("refuses a challenge used once already, even signed again", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);
      await paid(approval);

      // #when
      const again = await confirm(approval);

      // #then
      expect({ status: again.status, ...moneyMoved() }).toEqual({
        status: 403,
        orders: 1,
        sends: 1,
      });
    });

    it("refuses one claim's confirmation replayed for another claim", async () => {
      // #given
      const first = await submit();
      const second = await submit(await payableEmployee(paying.company));
      const firstApproval = await approvalFor([first.id]);
      const secondApproval = await approvalFor([second.id]);

      // #when
      const response = await sendConfirmation(
        secondApproval,
        paying.passkey.sign(firstApproval.options, TEST_ORIGIN),
      );

      // #then
      expect({ status: response.status, ...moneyMoved() }).toEqual({
        status: 403,
        orders: 0,
        sends: 0,
      });
    });

    it("returns the same payout when the claim is prepared again, never a second one", async () => {
      // #given
      const claim = await submit();
      const first = await approvalFor([claim.id]);

      // #when
      const second = await approvalFor([claim.id]);
      const third = await approvalFor([claim.id]);

      // #then
      const rows = await payoutsOf(claim.id);
      expect({
        payoutIds: [first, second, third].map(
          (approval) => approval.claims[0]?.payoutId,
        ),
        rows: rows.map((row) => row.status),
      }).toEqual({
        payoutIds: [rows[0]?.id, rows[0]?.id, rows[0]?.id],
        rows: ["awaiting_approval"],
      });
    });

    it("won't prepare a claim that's already paying", async () => {
      // #given
      const claim = await submit();
      await approveAndPay(claim.id);

      // #when
      const response = await prepare([claim.id]);

      // #then
      expect({ status: response.status, ...moneyMoved() }).toEqual({
        status: 409,
        orders: 1,
        sends: 1,
      });
    });

    it("pays each claim of a batch once, even when the batch's confirmation arrives twice at once", async () => {
      // #given three people's claims, approved together with one passkey
      const claims = [
        await submit(),
        await submit(await payableEmployee(paying.company), "250"),
        await submit(await payableEmployee(paying.company), "4,000"),
      ];
      const claimIds = claims.map((claim) => claim.id);
      const approval = await approvalFor(claimIds);
      const signed = paying.passkey.sign(approval.options, TEST_ORIGIN);

      // #when
      const responses = await Promise.all([
        sendConfirmation(approval, signed),
        sendConfirmation(approval, signed),
      ]);
      for (const preview of approval.claims) {
        const payout = await readPayout(db, paying.company, preview.payoutId);
        setOrder(payout, "settled");
        await deliverWebhook(payout);
      }
      const preparedAgain = await prepare(claimIds);

      // #then
      expect({
        statuses: responses.map((response) => response.status).sort(),
        payoutsPerClaim: await Promise.all(
          claimIds.map(async (id) => (await payoutsOf(id)).length),
        ),
        claimStatuses: await Promise.all(
          claimIds.map(async (id) => (await claimRow(id)).status),
        ),
        distinctSends: new Set(
          privy.state.sends.map((send) => send.idempotencyKey),
        ).size,
        preparedAgain: preparedAgain.status,
        ...moneyMoved(),
      }).toEqual({
        statuses: [200, 403],
        payoutsPerClaim: [1, 1, 1],
        claimStatuses: ["paid", "paid", "paid"],
        distinctSends: 3,
        preparedAgain: 409,
        orders: 3,
        sends: 3,
      });
    });
  });

  describe("the confirmed payout number (spec §6.18)", () => {
    it("is refused while the employee has no confirmed number, preparing nothing", async () => {
      // #given
      const unconfirmed = await unconfirmedEmployee();
      const claim = await submit(unconfirmed);

      // #when
      const response = await prepare([claim.id]);

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toContain(
        "hasn't confirmed an M-Pesa number yet. Approve & pay is blocked until they do.",
      );
      expect(await payoutsOf(claim.id)).toEqual([]);
    });

    it("prepares nothing in a batch when one claimant has no confirmed number", async () => {
      // #given
      const ready = await submit();
      const unconfirmed = await unconfirmedEmployee();
      const blocked = await submit(unconfirmed);

      // #when
      const response = await prepare([ready.id, blocked.id]);

      // #then
      expect({
        status: response.status,
        ready: await payoutsOf(ready.id),
        blocked: await payoutsOf(blocked.id),
      }).toEqual({ status: 409, ready: [], blocked: [] });
    });

    it("pays exactly the confirmed number", async () => {
      // #given
      const phone = await confirmPhone(employee);
      const claim = await submit();

      // #when
      const payout = await approveAndPay(claim.id);

      // #then
      expect(payout.recipient).toEqual({
        method: "mpesa_phone",
        phone,
        accountName: "Jane Wanjiku",
      });
      expect(
        paycrest.state.created[0]?.destination.recipient.accountIdentifier,
      ).toContain(phone.slice(-9));
    });

    it("sends nothing when the number moved to someone else after preparing", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);
      const [{ phone } = { phone: "" }] = await db
        .select({ phone: users.phone })
        .from(users)
        .where(eq(users.id, employee.id));
      await db
        .update(users)
        .set({ phone: null, phoneVerifiedAt: null })
        .where(eq(users.id, employee.id));
      await confirmPhone(await createUser(db), phone ?? "");

      // #when
      const response = await confirm(approval);

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toContain(
        "hasn't confirmed an M-Pesa number",
      );
      expect({
        ...moneyMoved(),
        claim: (await claimRow(claim.id)).status,
        payout: (await payoutsOf(claim.id))[0]?.status,
      }).toEqual({
        orders: 0,
        sends: 0,
        claim: "submitted",
        payout: "awaiting_approval",
      });
    });

    it("sends nothing when the employee changed their number after preparing, and pays the new one once prepared again", async () => {
      // #given
      const claim = await submit();
      const stale = await approvalFor([claim.id]);
      const newPhone = await confirmPhone(employee);

      // #when
      const refused = await confirm(stale);
      const fresh = await approvalFor([claim.id]);
      await paid(fresh);

      // #then
      const rows = await payoutsOf(claim.id);
      expect({
        refused: refused.status,
        rows: rows.map((row) => [row.status, row.idempotencyKey]),
        paidTo: rows[1]?.recipient,
        ...moneyMoved(),
      }).toEqual({
        refused: 409,
        rows: [
          ["failed", `claim:${claim.id}:1`],
          ["paying", `claim:${claim.id}:2`],
        ],
        paidTo: {
          method: "mpesa_phone",
          phone: newPhone,
          accountName: "Jane Wanjiku",
        },
        orders: 1,
        sends: 1,
      });
    });

    it("is refused while the claimant has no name to pay", async () => {
      // #given
      await confirmPhone(employee, randomPhone(), null);
      const claim = await submit();

      // #when
      const response = await prepare([claim.id]);

      // #then
      expect(response.status).toBe(409);
      expect((await errorOf(response)).message).toContain("full name");
      expect(await payoutsOf(claim.id)).toEqual([]);
    });
  });

  it("sends nothing when the claim's amount changed after preparing", async () => {
    // #given
    const claim = await submit();
    const approval = await approvalFor([claim.id]);
    const edited = await sendJson(
      app,
      `${claimsPath()}/${claim.id}`,
      employee,
      {
        method: "PATCH",
        body: { amountKes: "2,000" },
      },
    );
    expect(edited.status).toBe(200);

    // #when
    const response = await confirm(approval);

    // #then
    expect({
      status: response.status,
      ...moneyMoved(),
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ status: 409, orders: 0, sends: 0, claim: "submitted" });
  });

  describe("the engine's limits, as the admin sees them", () => {
    const setCompany = (changes: Partial<typeof organizations.$inferInsert>) =>
      runInScope(db, { organizationId: paying.company.organizationId }, (tx) =>
        tx
          .update(organizations)
          .set(changes)
          .where(eq(organizations.id, paying.company.organizationId)),
      );

    it("refuses a claim over the daily cap, with the reason", async () => {
      // #given a KES 1,000 daily cap
      await setCompany({ dailyPayoutCapKes: 100_000n });
      const claim = await submit();
      const approval = await approvalFor([claim.id]);

      // #when
      const response = await confirm(approval);

      // #then
      expect({
        status: response.status,
        message: (await errorOf(response)).message,
        ...moneyMoved(),
        claim: (await claimRow(claim.id)).status,
      }).toEqual({
        status: 409,
        message:
          "This would take today's payouts over the company's daily cap.",
        orders: 0,
        sends: 0,
        claim: "submitted",
      });
    });

    it("refuses while the company's payouts are paused, with the reason", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);
      await setCompany({ payoutsPaused: true });

      // #when
      const response = await confirm(approval);

      // #then
      expect({
        status: response.status,
        message: (await errorOf(response)).message,
        ...moneyMoved(),
        claim: (await claimRow(claim.id)).status,
      }).toEqual({
        status: 409,
        message: "Payouts are paused. Nothing was sent.",
        orders: 0,
        sends: 0,
        claim: "submitted",
      });
    });
  });

  describe("self-approval (spec §4)", () => {
    it("is allowed and flagged in the audit log and on the claim", async () => {
      // #given
      await confirmPhone(admin(), randomPhone(), "Amina Odhiambo");
      const own = await submit(admin());

      // #when
      await approveAndPay(own.id);

      // #then
      const [entry] = await auditOf(own.id, "expense.approved");
      expect({
        audited: entry?.after.selfApproval,
        stored: (await claimRow(own.id)).selfApproved,
        shown: (await claimAs(own.id, admin())).selfApproved,
      }).toEqual({ audited: true, stored: true, shown: true });
    });

    it("isn't flagged when someone else's claim is approved", async () => {
      // #given
      const claim = await submit();

      // #when
      await approveAndPay(claim.id);

      // #then
      expect((await claimAs(claim.id, admin())).selfApproved).toBe(false);
    });
  });

  describe("who can", () => {
    it("refuses an employee asking to approve", async () => {
      // #given
      const claim = await submit();

      // #when
      const response = await prepare([claim.id], employee);

      // #then
      expect({
        status: response.status,
        payouts: await payoutsOf(claim.id),
      }).toEqual({ status: 403, payouts: [] });
    });

    it("refuses an employee confirming an admin's approval", async () => {
      // #given
      const claim = await submit();
      const approval = await approvalFor([claim.id]);

      // #when
      const response = await confirm(approval, employee);

      // #then
      expect({ status: response.status, ...moneyMoved() }).toEqual({
        status: 403,
        orders: 0,
        sends: 0,
      });
    });

    it("answers 404 for another company's claim", async () => {
      // #given
      const other = await createPayingCompany(runtime, db);
      const otherCategory = await addCategory(db, other.company, "Meals");
      const theirs = await submit(
        await payableEmployee(other.company),
        CLAIMED,
        other.company,
        otherCategory,
      );

      // #when
      const responses = await Promise.all([
        prepare([theirs.id]),
        retry(theirs.id),
        reject(theirs.id, "Not a business expense"),
      ]);

      // #then
      expect(responses.map((response) => response.status)).toEqual([
        404, 404, 404,
      ]);
      expect(await payoutsOf(theirs.id)).toEqual([]);
    });

    it("answers 404 for another company's approval", async () => {
      // #given
      const other = await createPayingCompany(runtime, db);
      const otherCategory = await addCategory(db, other.company, "Meals");
      const theirs = await submit(
        await payableEmployee(other.company),
        CLAIMED,
        other.company,
        otherCategory,
      );
      const response = await sendJson(
        app,
        `${claimsPath(other.company)}/approval`,
        other.company.admin,
        { method: "POST", body: { claimIds: [theirs.id] } },
      );
      const theirApproval = await parseApproval(response);

      // #when
      const confirmed = await sendConfirmation(
        theirApproval,
        other.passkey.sign(theirApproval.options, TEST_ORIGIN),
      );

      // #then
      expect({ status: confirmed.status, ...moneyMoved() }).toEqual({
        status: 404,
        orders: 0,
        sends: 0,
      });
    });

    it("answers 404 for an approval that doesn't exist", async () => {
      // #given a signed assertion, sent for an unknown challenge
      const claim = await submit();
      const approval = await approvalFor([claim.id]);

      // #when
      const response = await sendJson(
        app,
        `${claimsPath()}/approval/${randomUUID()}/confirm`,
        admin(),
        {
          method: "POST",
          body: {
            response: paying.passkey.sign(approval.options, TEST_ORIGIN),
          },
        },
      );

      // #then
      expect({ status: response.status, ...moneyMoved() }).toEqual({
        status: 404,
        orders: 0,
        sends: 0,
      });
    });

    it("refuses a batch of more than 20, or the same claim twice", async () => {
      // #given
      const claim = await submit();

      // #when
      const tooMany = await prepare(
        Array.from({ length: 21 }, () => randomUUID()),
      );
      const twice = await prepare([claim.id, claim.id]);

      // #then
      expect([tooMany.status, twice.status]).toEqual([400, 400]);
    });
  });
});

describe("POST /organizations/:id/claims/:claimId/reject", () => {
  it("requires a reason", async () => {
    // #given
    const claim = await submit();

    // #when
    const responses = await Promise.all([
      reject(claim.id, undefined),
      reject(claim.id, "   "),
      reject(claim.id, "no"),
    ]);

    // #then
    expect({
      statuses: responses.map((response) => response.status),
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ statuses: [400, 400, 400], claim: "submitted" });
  });

  it("rejects with the reason the employee sees, audited", async () => {
    // #given
    const claim = await submit();

    // #when
    const response = await reject(claim.id, "  The receipt is unreadable  ");

    // #then
    expect(response.status).toBe(200);
    expect(await claimAs(claim.id, employee)).toMatchObject({
      status: "rejected",
      rejectedReason: "The receipt is unreadable",
      canEdit: true,
    });
    expect(await auditOf(claim.id, "expense.rejected")).toEqual([
      expect.objectContaining({
        actor_id: admin().id,
        before: { status: "submitted" },
        after: {
          status: "rejected",
          rejectedReason: "The receipt is unreadable",
        },
      }),
    ]);
  });

  it("refuses a claim that's already being paid", async () => {
    // #given
    const claim = await submit();
    await approveAndPay(claim.id);

    // #when
    const response = await reject(claim.id, "Changed my mind");

    // #then
    expect({
      status: response.status,
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ status: 409, claim: "paying" });
  });

  it("refuses an employee", async () => {
    // #given
    const claim = await submit();

    // #when
    const response = await reject(claim.id, "Not allowed", employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("sends nothing for an approval prepared before the claim was rejected", async () => {
    // #given
    const claim = await submit();
    const approval = await approvalFor([claim.id]);
    await reject(claim.id, "Wrong category");

    // #when
    const response = await confirm(approval);

    // #then
    expect({
      status: response.status,
      ...moneyMoved(),
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ status: 409, orders: 0, sends: 0, claim: "rejected" });
  });

  it("lets the employee edit and resubmit, then an admin approve and pay it", async () => {
    // #given
    const claim = await submit();
    await approvalFor([claim.id]);
    await reject(claim.id, "The amount doesn't match the receipt");

    // #when
    const resubmitted = await sendJson(
      app,
      `${claimsPath()}/${claim.id}`,
      employee,
      { method: "PATCH", body: { amountKes: "1,450" } },
    );
    const approval = await approvalFor([claim.id]);
    const result = await paid(approval);

    // #then
    expect(resubmitted.status).toBe(200);
    expect(approval.claims[0]?.receivesKes).toBe("145000");
    expect(result.claims[0]?.status).toBe("paying");
    expect(
      (await payoutsOf(claim.id)).map((row) => [row.status, row.amountKes]),
    ).toEqual([
      ["failed", RECEIVES_KES],
      ["paying", 145_000n],
    ]);
    expect(moneyMoved()).toEqual({ orders: 1, sends: 1 });
  });
});

describe("the claim follows its payout (spec §6.7 step 6, §6.8)", () => {
  it("fails with the payout when Paycrest refuses the order", async () => {
    // #given
    const claim = await submit();
    paycrest.state.nextCreateFailure = "refused";

    // #when
    const result = await paid(await approvalFor([claim.id]));

    // #then
    expect(result.claims[0]).toMatchObject({
      status: "payout_failed",
      payout: { status: "failed" },
    });
    expect(await auditOf(claim.id, "expense.payout_failed")).toHaveLength(1);
  });

  it("fails with the payout when the wallet refuses the transfer", async () => {
    // #given
    const claim = await submit();
    privy.state.nextSends("refused");

    // #when
    const result = await paid(await approvalFor([claim.id]));

    // #then
    expect(result.claims[0]).toMatchObject({
      status: "payout_failed",
      payout: { status: "failed" },
    });
  });

  it("stays paying while the payout is under review", async () => {
    // #given
    const claim = await submit();
    privy.state.nextSends("unknown");

    // #when
    const result = await paid(await approvalFor([claim.id]));

    // #then
    expect(result.claims[0]).toMatchObject({
      status: "paying",
      payout: { status: "needs_review" },
    });
  });

  it("is paid once Paycrest's signed webhook says so", async () => {
    // #given
    const claim = await submit();
    const payout = await approveAndPay(claim.id);
    setOrder(payout, "settled");

    // #when
    const response = await deliverWebhook(payout);

    // #then
    const row = await claimRow(claim.id);
    const settled = await readPayout(db, paying.company, payout.id);
    expect({
      http: response.status,
      status: row.status,
      paidAt: row.paidAt?.toISOString(),
    }).toEqual({
      http: 200,
      status: "paid",
      paidAt: settled.paidAt?.toISOString(),
    });
    expect(await auditOf(claim.id, "expense.paid")).toMatchObject([
      {
        actor_type: "system",
        after: {
          status: "paid",
          payoutId: payout.id,
          providerReference: "SKL3ABCDEF",
        },
      },
    ]);
  });

  it("fails once Paycrest's signed webhook says the order was refunded", async () => {
    // #given
    const claim = await submit();
    const payout = await approveAndPay(claim.id);
    setOrder(payout, "refunded");

    // #when
    await deliverWebhook(payout);

    // #then
    expect((await claimRow(claim.id)).status).toBe("payout_failed");
  });

  it("stays paying when Paycrest's webhook says an order we funded expired", async () => {
    // #given
    const claim = await submit();
    const payout = await approveAndPay(claim.id);
    setOrder(payout, "expired");

    // #when
    await deliverWebhook(payout);

    // #then
    expect({
      payout: (await readPayout(db, paying.company, payout.id)).status,
      claim: (await claimRow(claim.id)).status,
    }).toEqual({ payout: "needs_review", claim: "paying" });
  });

  it("updates the claim once however many times the webhook arrives", async () => {
    // #given
    const claim = await submit();
    const payout = await approveAndPay(claim.id);
    setOrder(payout, "settled");

    // #when
    await deliverWebhook(payout);
    await deliverWebhook(payout);

    // #then
    expect(await auditOf(claim.id, "expense.paid")).toHaveLength(1);
  });

  describe("when Expendi staff resolve its payout", () => {
    async function stuck(claimId: string): Promise<Payout> {
      privy.state.nextSends("unknown");
      const payout = await approveAndPay(claimId);
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
      const claim = await submit();
      const payout = await stuck(claim.id);
      setOrder(payout, "expired");

      // #when
      const status = await resolve(payout, "failed");

      // #then
      expect({
        status,
        claim: (await claimRow(claim.id)).status,
      }).toEqual({ status: 200, claim: "payout_failed" });
    });

    it("is paid when staff close the payout as paid", async () => {
      // #given
      const claim = await submit();
      const payout = await stuck(claim.id);
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
        claim: (await claimRow(claim.id)).status,
      }).toEqual({ status: 200, claim: "paid" });
    });
  });
});

describe("POST /organizations/:id/claims/:claimId/retry", () => {
  async function failedClaim(): Promise<ClaimDetail> {
    const claim = await submit();
    paycrest.state.nextCreateFailure = "refused";
    await paid(await approvalFor([claim.id]));
    expect((await claimRow(claim.id)).status).toBe("payout_failed");
    return claim;
  }

  it("prepares a new payout with a new key and asks for the passkey again, sending nothing", async () => {
    // #given
    const claim = await failedClaim();

    // #when
    const approval = await parseApproval(await retry(claim.id));

    // #then
    const rows = await payoutsOf(claim.id);
    expect({
      rows: rows.map((row) => [row.status, row.idempotencyKey]),
      preparedFor: approval.claims.map((preview) => preview.payoutId),
      claim: (await claimRow(claim.id)).status,
      ...moneyMoved(),
    }).toEqual({
      rows: [
        ["failed", `claim:${claim.id}:1`],
        ["awaiting_approval", `claim:${claim.id}:2`],
      ],
      preparedFor: [rows[1]?.id],
      claim: "payout_failed",
      orders: 0,
      sends: 0,
    });
    expect(await auditOf(rows[0]?.id ?? "", "payout.retried")).toHaveLength(1);
  });

  it("pays once the admin confirms, and only then moves the claim to paying", async () => {
    // #given
    const claim = await failedClaim();
    const approval = await parseApproval(await retry(claim.id));

    // #when
    const result = await paid(approval);

    // #then
    expect({
      claim: result.claims[0]?.status,
      payouts: (await payoutsOf(claim.id)).map((row) => row.status),
      ...moneyMoved(),
    }).toEqual({
      claim: "paying",
      payouts: ["failed", "paying"],
      orders: 1,
      sends: 1,
    });
  });

  it("returns the same retry when asked twice", async () => {
    // #given
    const claim = await failedClaim();

    // #when
    const first = await parseApproval(await retry(claim.id));
    const second = await parseApproval(await retry(claim.id));

    // #then
    expect({
      same: first.claims[0]?.payoutId === second.claims[0]?.payoutId,
      payouts: (await payoutsOf(claim.id)).length,
    }).toEqual({ same: true, payouts: 2 });
  });

  it("pays the employee's current number", async () => {
    // #given
    const claim = await failedClaim();
    const corrected = await confirmPhone(employee);

    // #when
    await paid(await parseApproval(await retry(claim.id)));

    // #then
    expect((await payoutsOf(claim.id))[1]?.recipient).toMatchObject({
      phone: corrected,
    });
  });

  it("can't use the failed payment's approval again", async () => {
    // #given
    const claim = await submit();
    paycrest.state.nextCreateFailure = "refused";
    const original = await approvalFor([claim.id]);
    await paid(original);
    await retry(claim.id);

    // #when
    const response = await confirm(original);

    // #then
    expect({ status: response.status, ...moneyMoved() }).toEqual({
      status: 403,
      orders: 0,
      sends: 0,
    });
  });

  it.each(["submitted", "paying"] as const)(
    "refuses a claim that's %s",
    async (state) => {
      // #given
      const claim = await submit();
      if (state === "paying") await approveAndPay(claim.id);

      // #when
      const response = await retry(claim.id);

      // #then
      expect(response.status).toBe(409);
    },
  );

  it("refuses an employee", async () => {
    // #given
    const claim = await failedClaim();

    // #when
    const response = await retry(claim.id, employee);

    // #then
    expect(response.status).toBe(403);
  });
});

describe("the admin's queue: GET /organizations/:id/claims?status=submitted", () => {
  it("says whose claims can't be paid yet, without showing anyone's number", async () => {
    // #given
    const ready = await submit();
    const unconfirmed = await unconfirmedEmployee();
    const waiting = await submit(unconfirmed);
    const [{ phone } = { phone: null }] = await db
      .select({ phone: users.phone })
      .from(users)
      .where(eq(users.id, employee.id));

    // #when
    const response = await sendJson(
      app,
      `${claimsPath()}?status=submitted`,
      admin(),
    );

    // #then
    const text = await response.text();
    const page = claimsPageSchema.parse(
      (JSON.parse(text) as { data: unknown }).data,
    );
    expect(
      Object.fromEntries(
        page.claims.map((claim) => [
          claim.id,
          claim.submittedBy.payoutPhoneConfirmed,
        ]),
      ),
    ).toEqual({ [ready.id]: true, [waiting.id]: false });
    expect(text).not.toContain(phone ?? "no phone");
    expect(text).not.toContain((phone ?? "no phone").slice(1));
  });

  it("shows the admin why a payment failed, and the employee only its status", async () => {
    // #given
    const claim = await submit();
    paycrest.state.nextCreateFailure = "refused";
    await paid(await approvalFor([claim.id]));

    // #when
    const forAdmin = await claimAs(claim.id, admin());
    const forEmployee = await claimAs(claim.id, employee);

    // #then
    expect(forAdmin).toMatchObject({
      status: "payout_failed",
      payout: { status: "failed" },
    });
    expect(forAdmin.payout?.failureReason).toContain(
      "The cash-out was refused",
    );
    expect(forEmployee).toMatchObject({
      status: "payout_failed",
      payout: null,
    });
  });
});

describe("claim approval routes keep companies apart", () => {
  it.each([
    [
      "POST /claims/approval",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/claims/approval`,
        body: { claimIds: [randomUUID()] },
      }),
    ],
    [
      "POST /claims/approval/:challengeId/confirm",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/claims/approval/${randomUUID()}/confirm`,
        body: { response: {} },
      }),
    ],
    [
      "POST /claims/:claimId/retry",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/claims/${randomUUID()}/retry`,
        body: {},
      }),
    ],
    [
      "POST /claims/:claimId/reject",
      (organizationId: string) => ({
        path: `/organizations/${organizationId}/claims/${randomUUID()}/reject`,
        body: { reason: "Not a business expense" },
      }),
    ],
  ])("%s", async (_route, target) => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => {
      const { path, body } = target(organizationId);
      return {
        path,
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
      };
    });
  });
});
