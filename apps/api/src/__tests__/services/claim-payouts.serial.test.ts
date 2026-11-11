import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ClaimApproval } from "@expendi-business/shared";
import {
  claimApprovalSchema,
  claimDetailSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { approvePayouts } from "../../services/payout/approve.js";
import { confirmOnchainPayouts } from "../../services/payout/onchain.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import {
  APPROVAL_LAPSE_MS,
  PAYING_STUCK_MS,
  reconcilePaycrestPayouts,
} from "../../services/payout/sync.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
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
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  allowlistAddress,
  createPayingCompany,
  readPayout,
  updatePayout,
  USDC,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";

// Serial: reconciliation and the on-chain confirmation job sweep every
// company's payouts, so run in parallel they could move other files'.

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let paying: PayingCompany;
let categoryId: string;
let employee: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
    fileStorage: storage.layer,
    baseRpc: rpc.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  paying = await createPayingCompany(runtime, db);
  categoryId = await addCategory(db, paying.company, "Meals");
  employee = await createUser(db);
  await addMember(db, paying.company, employee);
  await db
    .update(users)
    .set({
      phone: `+2547${randomInt(10_000_000, 100_000_000)}`,
      phoneVerifiedAt: new Date(),
      fullName: "Jane Wanjiku",
    })
    .where(eq(users.id, employee.id));
});

const claimsPath = () =>
  `/organizations/${paying.company.organizationId}/claims`;

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function submitClaim(): Promise<string> {
  const upload = await uploadReceipt(app, storage, paying.company, employee);
  const response = await sendJson(app, claimsPath(), employee, {
    method: "POST",
    body: claimRequest({ receiptFileIds: [upload.receiptFileId], categoryId }),
  });
  expect(response.status).toBe(201);
  return claimDetailSchema.parse(await dataOf(response)).id;
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Approval extends Omit<ClaimApproval, "options"> {
  readonly options: SignOptions;
}

async function approvalFor(claimId: string): Promise<Approval> {
  const response = await sendJson(
    app,
    `${claimsPath()}/approval`,
    paying.company.admin,
    { method: "POST", body: { claimIds: [claimId] } },
  );
  expect(response.status).toBe(201);
  const data = await dataOf(response);
  return {
    ...claimApprovalSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
}

/** Approve & pay for one claim, through the routes; the payout ends paying. */
async function payingClaim(): Promise<{ claimId: string; payout: Payout }> {
  const claimId = await submitClaim();
  const approval = await approvalFor(claimId);
  const response = await sendJson(
    app,
    `${claimsPath()}/approval/${approval.challengeId}/confirm`,
    paying.company.admin,
    {
      method: "POST",
      body: { response: paying.passkey.sign(approval.options, TEST_ORIGIN) },
    },
  );
  expect(response.status).toBe(200);
  const payout = await readPayout(
    db,
    paying.company,
    approval.claims[0]?.payoutId ?? "",
  );
  expect(payout.status).toBe("paying");
  return { claimId, payout };
}

function setOrder(payout: Payout, status: string): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, { ...order, status });
}

async function claimStatus(claimId: string) {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ status: expenses.status })
        .from(expenses)
        .where(eq(expenses.id, claimId)),
  );
  return row?.status;
}

const reconcile = () => runtime.runPromise(reconcilePaycrestPayouts(500));

describe("a claim follows its payout through reconciliation", () => {
  it("is paid once Paycrest settles the order", async () => {
    // #given
    const { claimId, payout } = await payingClaim();
    setOrder(payout, "settled");

    // #when
    await reconcile();

    // #then
    expect(await claimStatus(claimId)).toBe("paid");
  });

  it("fails once Paycrest refunds the order", async () => {
    // #given
    const { claimId, payout } = await payingClaim();
    setOrder(payout, "refunded");

    // #when
    await reconcile();

    // #then
    expect(await claimStatus(claimId)).toBe("payout_failed");
  });

  it("stays paying while its payout is under review", async () => {
    // #given
    const { claimId, payout } = await payingClaim();
    setOrder(payout, "expired");

    // #when
    await reconcile();

    // #then
    expect({
      payout: (await readPayout(db, paying.company, payout.id)).status,
      claim: await claimStatus(claimId),
    }).toEqual({ payout: "needs_review", claim: "paying" });
  });

  it("stays paying when Paycrest hasn't returned the order for two hours", async () => {
    // #given
    const { claimId, payout } = await payingClaim();
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - PAYING_STUCK_MS - 60_000),
    });
    paycrest.state.failGetOrder = true;

    // #when
    await reconcile();

    // #then
    expect({
      payout: (await readPayout(db, paying.company, payout.id)).status,
      claim: await claimStatus(claimId),
    }).toEqual({ payout: "needs_review", claim: "paying" });
  });

  it("fails when its approval lapsed before funding started; nothing was sent", async () => {
    // #given an approval whose funding never started
    const claimId = await submitClaim();
    const approval = await approvalFor(claimId);
    await runtime.runPromise(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );
    const payoutId = approval.claims[0]?.payoutId ?? "";
    await updatePayout(db, paying.company, payoutId, {
      approvedAt: new Date(Date.now() - APPROVAL_LAPSE_MS - 60_000),
    });
    const approved = await claimStatus(claimId);

    // #when
    await reconcile();

    // #then
    expect({
      approved,
      payout: (await readPayout(db, paying.company, payoutId)).status,
      claim: await claimStatus(claimId),
      sends: privy.state.sends.length,
    }).toEqual({
      approved: "paying",
      payout: "failed",
      claim: "payout_failed",
      sends: 0,
    });
  });
});

describe("the claim's hooks on USDC payouts", () => {
  /** A claim payout to an allowlisted address, made with the engine directly. */
  async function usdcClaimPayout(claimId: string, address: string) {
    const [payout] = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [
          {
            subjectType: "claim",
            subjectId: claimId,
            idempotencyKey: `claim:${claimId}:1`,
            recipient: {
              method: "usdc",
              chain: "base",
              address,
              accountName: "Jane",
            },
            amountUsdc: 12n * USDC,
          },
        ],
      }),
    );
    if (!payout) throw new Error("nothing prepared");
    return payout;
  }

  it("refuses to approve a claim payout that doesn't pay the claimant's M-Pesa number", async () => {
    // #given
    const claimId = await submitClaim();
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address);
    const payout = await usdcClaimPayout(claimId, address);
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        payoutIds: [payout.id],
      }),
    );

    // #when
    const exit = await runtime.runPromiseExit(
      approvePayouts({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: approval.challengeId,
        response: paying.passkey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect({
      reason: failure && "reason" in failure ? failure.reason : null,
      payout: (await readPayout(db, paying.company, payout.id)).status,
      claim: await claimStatus(claimId),
    }).toEqual({
      reason: "subject_not_payable",
      payout: "awaiting_approval",
      claim: "submitted",
    });
  });

  it("is paid when the on-chain confirmation job marks its payout paid", async () => {
    // #given a claim paying through a sent USDC payout, set up by hand
    const claimId = await submitClaim();
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address);
    const payout = await usdcClaimPayout(claimId, address);
    const txHash = randomTxHash();
    const approvedAt = new Date();
    await updatePayout(db, paying.company, payout.id, {
      status: "paying",
      approvalId: randomUUID(),
      approvedBy: paying.company.admin.id,
      approvedAt,
      fundingStartedAt: approvedAt,
      depositAddress: address,
      amountToTransferUsdc: 12n * USDC,
      txHash,
    });
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(expenses)
          .set({
            status: "paying",
            payoutId: payout.id,
            approvedBy: paying.company.admin.id,
            approvedAt,
          })
          .where(eq(expenses.id, claimId)),
    );
    rpc.state.receipts.set(
      txHash,
      transferReceipt(
        [{ from: paying.wallet.address, to: address, amount: 12n * USDC }],
        { txHash },
      ),
    );

    // #when
    await runtime.runPromise(confirmOnchainPayouts(500));

    // #then
    expect({
      payout: (await readPayout(db, paying.company, payout.id)).status,
      claim: await claimStatus(claimId),
    }).toEqual({ payout: "paid", claim: "paid" });
  });
});
