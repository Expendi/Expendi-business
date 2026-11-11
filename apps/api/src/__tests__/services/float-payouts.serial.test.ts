import { randomInt, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FloatApproval } from "@expendi-business/shared";
import { floatApprovalSchema } from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { floatMovements, floats, users } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { confirmOnchainPayouts } from "../../services/payout/onchain.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import {
  PAYING_STUCK_MS,
  reconcilePaycrestPayouts,
} from "../../services/payout/sync.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
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
const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let paying: PayingCompany;
let membershipId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
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
  paying = await createPayingCompany(runtime, db);
  const employee = await createUser(db);
  membershipId = await addMember(db, paying.company, employee);
  await db
    .update(users)
    .set({
      phone: `+2547${randomInt(10_000_000, 100_000_000)}`,
      phoneVerifiedAt: new Date(),
      fullName: "Jane Wanjiku",
    })
    .where(eq(users.id, employee.id));
});

const floatsPath = () =>
  `/organizations/${paying.company.organizationId}/floats`;

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];
interface Approval extends Omit<FloatApproval, "options"> {
  readonly options: SignOptions;
}

/** A float issued through the routes, its payment approved and paying. */
async function payingIssue(): Promise<{ approval: Approval; payout: Payout }> {
  const issued = await sendJson(app, floatsPath(), paying.company.admin, {
    method: "POST",
    body: { membershipId, amountKes: "1,000" },
  });
  expect(issued.status).toBe(201);
  const data = await dataOf(issued);
  const approval: Approval = {
    ...floatApprovalSchema.parse(data),
    options: (data as { options: SignOptions }).options,
  };
  const confirmed = await sendJson(
    app,
    `${floatsPath()}/approval/${approval.challengeId}/confirm`,
    paying.company.admin,
    {
      method: "POST",
      body: { response: paying.passkey.sign(approval.options, TEST_ORIGIN) },
    },
  );
  expect(confirmed.status).toBe(200);
  const payout = await readPayout(
    db,
    paying.company,
    approval.payment.payoutId,
  );
  expect(payout.status).toBe("paying");
  return { approval, payout };
}

function setOrder(payout: Payout, status: string): void {
  const order = paycrest.state.orders.get(payout.providerOrderId ?? "");
  if (!order) throw new Error("no order for payout");
  paycrest.state.orders.set(order.id, { ...order, status });
}

async function movementStatus(movementId: string) {
  const [row] = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({ status: floatMovements.status })
        .from(floatMovements)
        .where(eq(floatMovements.id, movementId)),
  );
  return row?.status;
}

const reconcile = () => runtime.runPromise(reconcilePaycrestPayouts(500));

describe("a float payment follows its payout through reconciliation", () => {
  it("is paid once Paycrest settles the order", async () => {
    // #given
    const { approval, payout } = await payingIssue();
    setOrder(payout, "settled");

    // #when
    await reconcile();

    // #then
    expect(await movementStatus(approval.movement.id)).toBe("paid");
  });

  it("fails once Paycrest refunds the order", async () => {
    // #given
    const { approval, payout } = await payingIssue();
    setOrder(payout, "refunded");

    // #when
    await reconcile();

    // #then
    expect(await movementStatus(approval.movement.id)).toBe("failed");
  });

  it("stays pending when Paycrest hasn't answered for two hours", async () => {
    // #given
    const { approval, payout } = await payingIssue();
    await updatePayout(db, paying.company, payout.id, {
      fundingStartedAt: new Date(Date.now() - PAYING_STUCK_MS - 60_000),
    });
    paycrest.state.failGetOrder = true;

    // #when
    await reconcile();

    // #then
    expect({
      payout: (await readPayout(db, paying.company, payout.id)).status,
      movement: await movementStatus(approval.movement.id),
    }).toEqual({ payout: "needs_review", movement: "pending" });
  });
});

describe("a float payment follows a USDC payout", () => {
  it("is paid when the on-chain confirmation job marks its payout paid", async () => {
    // #given a float payment sent as USDC, set up by hand
    const address = randomAddress();
    await allowlistAddress(runtime, paying, address);
    const floatId = randomUUID();
    const movementId = randomUUID();
    const [payout] = await runtime.runPromise(
      preparePayouts({
        organizationId: paying.company.organizationId,
        actor: { type: "user", id: paying.company.admin.id },
        requests: [
          {
            subjectType: "float",
            subjectId: movementId,
            idempotencyKey: `float:${movementId}:1`,
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
    await runInScope(
      db,
      {
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        role: "admin",
      },
      async (tx) => {
        await tx.insert(floats).values({
          id: floatId,
          organizationId: paying.company.organizationId,
          membershipId,
        });
        await tx.insert(floatMovements).values({
          id: movementId,
          organizationId: paying.company.organizationId,
          floatId,
          type: "issue",
          status: "pending",
          amountKes: payout.requestedKesCents,
          payoutId: payout.id,
          recordedBy: paying.company.admin.id,
        });
      },
    );
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
      movement: await movementStatus(movementId),
    }).toEqual({ payout: "paid", movement: "paid" });
  });
});
