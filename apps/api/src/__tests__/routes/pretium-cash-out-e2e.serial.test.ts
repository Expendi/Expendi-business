import { eq } from "drizzle-orm";
import pg from "pg";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { CashOutProvider } from "@expendi-business/shared";
import {
  billPaymentSchema,
  cashOutProviderPreparedSchema,
  claimApprovalSchema,
  claimDetailSchema,
} from "@expendi-business/shared";

import type { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { IntentQuote, Payout } from "../../db/schema/index.js";
import type { NearPayingCompany } from "../helpers/near-payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { advanceOutboundQuotes } from "../../services/payout/outbound-quotes.js";
import { reconcilePretiumPayouts } from "../../services/payout/pretium-fund.js";
import { reconcilePaycrestPayouts } from "../../services/payout/sync.js";
import { PRETIUM_BASE_SETTLEMENT_ADDRESS } from "../../services/pretium/settlement.js";
import { creditUsdcDeposits } from "../../services/wallet/deposits.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import { insertBill, insertPayee, readBill } from "../helpers/bills.js";
import { randomTxHash, transferReceipt } from "../helpers/chain.js";
import { claimFlow } from "../helpers/claim-flow.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import {
  makeFakeFileStorage,
  randomAddress,
  signPaycrestBody,
  signPretiumBody,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createNearPayingCompany,
  makeNearPayoutWorld,
  readQuotes,
} from "../helpers/near-payouts.js";
import { ledgerBalance, readPayout, USDC } from "../helpers/payouts.js";
import { bearer } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

/**
 * A Pretium cash-out end to end, through the routes and the jobs, for a
 * company whose money is on NEAR: staff choose the provider, an admin
 * approves, the Base hop delivers, the transit wallet sends, Base confirms,
 * Pretium is told and pays or refunds. Only the providers and chains are
 * fakes. Changes the platform-wide provider and runs every company's jobs,
 * so it runs on its own (vitest.serial.config.ts).
 */
const storage = makeFakeFileStorage();
const world = makeNearPayoutWorld({ fileStorage: storage.layer });
const { runtime, privy, paycrest, pretium, base } = world;
let db: Database;
let app: App;
let owner: pg.Pool;
let staff: TestStaff;
let paying: NearPayingCompany;

const PATH = "/internal/controls/cash-out-provider";
const PINNED = PRETIUM_BASE_SETTLEMENT_ADDRESS.toLowerCase();
const NEUTRAL = /paycrest|pretium/i;
/** A claim of KES 1,500.50, as Pretium pays it: whole shillings. */
const SHILLINGS = 1_501n;

type SignOptions = Parameters<SoftwarePasskey["sign"]>[0];

async function resetPlatform(): Promise<void> {
  await owner.query(
    "UPDATE platform_settings SET active_cash_out_provider = 'paycrest', payouts_paused = false",
  );
}

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  staff = await createStaff(owner, { role: "ops_admin" });
});

afterAll(async () => {
  await resetPlatform();
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paycrest.state.reset();
  pretium.state.reset();
  await resetPlatform();
  paying = await createNearPayingCompany(world, db);
  await mineCompanySends(privy, base.state.receipts, db, paying.company);
});

afterEach(async () => {
  await resetPlatform();
});

async function dataOf(response: Response): Promise<unknown> {
  return ((await response.json()) as { data: unknown }).data;
}

async function staffPost(path: string, body: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: {
      ...bearer(staff.privyUserId),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/** Staff change the provider through the Controls page's two steps. */
async function switchTo(provider: CashOutProvider): Promise<void> {
  const prepared = await staffPost(`${PATH}/prepare`, {
    provider,
    reason: "Moving cash-outs in an end-to-end test.",
  });
  expect(prepared.status).toBe(201);
  const { token } = cashOutProviderPreparedSchema.parse(await dataOf(prepared));
  const confirmed = await staffPost(`${PATH}/confirm`, { token });
  expect(confirmed.status).toBe(200);
}

const flow = () => claimFlow({ app, db, storage, paycrest }, paying);

/** An employee's claim, submitted and approved by the admin. */
async function approvedClaim(
  claims = flow(),
): Promise<{ claimId: string; payout: Payout }> {
  const { user } = await claims.employee();
  const claim = await claims.submit(user);
  const payout = await claims.approveAndPay(claim.id);
  return { claimId: claim.id, payout };
}

const reread = (payout: Pick<Payout, "id">) =>
  readPayout(db, paying.company, payout.id);

const hops = async (): Promise<IntentQuote[]> =>
  (await readQuotes(db, paying.company)).filter(
    (quote) => quote.purpose === "base_hop",
  );

/**
 * 1Click delivers every hop of the company's: the transit wallet holds
 * what they deliver between them, and each reports success.
 */
async function deliverHops(): Promise<void> {
  const delivered = await hops();
  world.setBaseUsdc(
    paying.transitAddress,
    delivered.reduce((sum, hop) => sum + hop.amountOut, 0n),
  );
  for (const hop of delivered) {
    world.oneClick.state.setStatus(hop.depositAddress, {
      status: "SUCCESS",
      depositedAmount: hop.amountIn,
      amountIn: hop.minAmountIn ?? hop.amountIn,
      amountOut: hop.amountOut,
      destinationChainTxHashes: [randomTxHash()],
    });
  }
}

const outboundJob = () => runtime.runPromise(advanceOutboundQuotes(500));
const pretiumJob = () => runtime.runPromise(reconcilePretiumPayouts(500));
const paycrestJob = () => runtime.runPromise(reconcilePaycrestPayouts(500));

const transitSends = () =>
  privy.state.sends.filter(
    (send) => send.privyWalletId === paying.transitPrivyWalletId,
  );

const paysFor = (payout: Pick<Payout, "id">) =>
  pretium.state.payRequests.filter(
    (request) => request.reference === payout.id,
  );

/**
 * What reached the providers for this company's payouts only: the jobs run
 * across every company, and other serial files leave rows behind.
 */
async function providerCallsForCompany() {
  const rows = await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) => tx.select({ id: payouts.id }).from(payouts),
  );
  const ids = new Set(rows.map((row) => row.id));
  return {
    pays: pretium.state.payRequests.filter((request) =>
      ids.has(request.reference),
    ),
    orders: paycrest.state.created.filter((order) => ids.has(order.reference)),
  };
}

async function ledgerOf(payout: Pick<Payout, "id">) {
  return runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx
        .select({
          type: walletTransactions.type,
          usdcAmount: walletTransactions.usdcAmount,
          txHash: walletTransactions.txHash,
        })
        .from(walletTransactions)
        .where(eq(walletTransactions.payoutId, payout.id)),
  );
}

async function claimStatus(claimId: string): Promise<string> {
  const response = await sendJson(
    app,
    `${flow().claimsPath}/${claimId}`,
    paying.company.admin,
  );
  expect(response.status).toBe(200);
  return claimDetailSchema.parse(await dataOf(response)).status;
}

/** Pretium's signed callback; it only prompts a fresh status read. */
async function pretiumCallback(transactionCode: string): Promise<number> {
  const body = JSON.stringify({
    status: "COMPLETE",
    transaction_code: transactionCode,
    receipt_number: "SKP1",
    public_name: "JANE WANJIKU",
    message: "Paid",
  });
  const response = await app.request("/webhooks/pretium", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-key": signPretiumBody(body),
    },
    body,
  });
  return response.status;
}

/** Paycrest settles an order and says so by signed webhook. */
async function paycrestSettles(orderId: string): Promise<number> {
  const order = paycrest.state.orders.get(orderId);
  if (!order) throw new Error(`no Paycrest order ${orderId}`);
  paycrest.state.orders.set(orderId, {
    ...order,
    status: "settled",
    paymentReference: "SKC1",
  });
  const body = JSON.stringify({
    event: "payment_order.settled",
    webhookVersion: "1",
    data: { id: orderId, status: "settled" },
  });
  const response = await app.request("/webhooks/paycrest", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-paycrest-signature": signPaycrestBody(body),
    },
    body,
  });
  return response.status;
}

/** Staff switch to Pretium, an admin approves a claim, and the hop delivers. */
async function sentToPretium(): Promise<{
  claimId: string;
  payout: Payout;
}> {
  await switchTo("pretium");
  const { claimId, payout } = await approvedClaim();
  expect({
    status: payout.status,
    provider: payout.provider,
    sends: transitSends().length,
  }).toEqual({ status: "approved", provider: "pretium", sends: 0 });
  await deliverHops();
  await outboundJob();
  return { claimId, payout: await reread(payout) };
}

describe("a claim cashed out through Pretium", () => {
  it("is sent to the pinned address, confirmed on Base, told to Pretium once, and paid on its callback", async () => {
    // #when
    const { claimId, payout: sent } = await sentToPretium();
    await pretiumJob();
    await pretiumJob();

    // #then one transfer of the exact amount went to the pinned address,
    // Base shows it, and Pretium was told about it once
    const amount = sent.amountToTransferUsdc ?? 0n;
    const receipt = base.state.receipts.get(sent.txHash ?? "");
    const recipient = sent.recipient;
    if (recipient.method !== "mpesa_phone") throw new Error("not M-Pesa");
    expect({
      status: sent.status,
      sends: transitSends().map((send) => ({
        to: send.to,
        amount: send.amount,
      })),
      mined: receipt?.status,
      pays: paysFor(sent),
    }).toEqual({
      status: "paying",
      sends: [{ to: PRETIUM_BASE_SETTLEMENT_ADDRESS, amount }],
      mined: "0x1",
      pays: [
        {
          recipient: {
            type: "MOBILE",
            shortcode: recipient.phone.slice(1),
            mobileNetwork: "Safaricom",
          },
          amountShillings: SHILLINGS,
          transactionHash: sent.txHash,
          reference: sent.id,
        },
      ],
    });

    // #when Pretium pays and calls back
    pretium.state.settle(sent.providerOrderId ?? "", "COMPLETE", "SKP1");
    const answered = await pretiumCallback(sent.providerOrderId ?? "");

    // #then
    const paid = await reread(sent);
    expect({
      answered,
      status: paid.status,
      receipt: paid.providerReference,
      ledger: await ledgerOf(sent),
      balance: await ledgerBalance(db, paying.company),
      claim: await claimStatus(claimId),
      pays: paysFor(sent).length,
    }).toEqual({
      answered: 200,
      status: "paid",
      receipt: "SKP1",
      ledger: [{ type: "payout", usdcAmount: -amount, txHash: sent.txHash }],
      balance: 100n * USDC - amount,
      claim: "paid",
      pays: 1,
    });
  });

  it("is refunded once when Pretium fails it, fails with the USDC back, and is retried under the provider active then", async () => {
    // #given a cash-out Pretium was told about, then reported FAILED
    const { claimId, payout: sent } = await sentToPretium();
    const refundHash = randomTxHash();
    pretium.state.nextRefundOutcome = { kind: "success", hash: refundHash };
    pretium.state.settle(sent.providerOrderId ?? "", "FAILED");

    // #when the job runs again and again
    await pretiumJob();
    await pretiumJob();
    await pretiumJob();

    // #then the refund was asked for once, by the transfer's hash
    const waiting = await reread(sent);
    expect({
      status: waiting.status,
      refunds: pretium.state.refundCalls.filter((hash) => hash === sent.txHash),
      refundTxHash: waiting.refundTxHash,
    }).toEqual({
      status: "paying",
      refunds: [sent.txHash],
      refundTxHash: refundHash,
    });

    // #when the refund arrives at the transit wallet with the named hash
    const amount = sent.amountToTransferUsdc ?? 0n;
    base.state.receipts.set(
      refundHash,
      transferReceipt([{ from: PINNED, to: paying.transitAddress, amount }], {
        txHash: refundHash,
      }),
    );
    await runtime.runPromise(
      creditUsdcDeposits([refundHash], {
        type: "system",
        id: "alchemy-webhook",
      }),
    );
    await pretiumJob();

    // #then it is credited, and the cash-out failed in words that name no
    // provider
    const failed = await reread(sent);
    expect({
      status: failed.status,
      neutral: !NEUTRAL.test(failed.failureReason ?? ""),
      ledger: await ledgerOf(sent),
      balance: await ledgerBalance(db, paying.company),
      claim: await claimStatus(claimId),
      refunds: pretium.state.refundCalls.filter((hash) => hash === sent.txHash)
        .length,
    }).toEqual({
      status: "failed",
      neutral: true,
      ledger: expect.arrayContaining([
        { type: "payout", usdcAmount: -amount, txHash: sent.txHash },
        { type: "refund", usdcAmount: amount, txHash: refundHash },
      ]) as unknown,
      balance: 100n * USDC,
      claim: "payout_failed",
      refunds: 1,
    });

    // #when staff move back to Paycrest and the admin retries
    await switchTo("paycrest");
    const retried = await sendJson(
      app,
      `${flow().claimsPath}/${claimId}/retry`,
      paying.company.admin,
      { method: "POST" },
    );

    // #then the retry is prepared under Paycrest
    expect(retried.status).toBe(201);
    const approval = claimApprovalSchema.parse(await dataOf(retried));
    const retry = await readPayout(
      db,
      paying.company,
      approval.claims[0]?.payoutId ?? "",
    );
    expect({ status: retry.status, provider: retry.provider }).toEqual({
      status: "awaiting_approval",
      provider: "paycrest",
    });
  });
});

describe("changing the provider while cash-outs are under way", () => {
  it("lets an approved Paycrest cash-out finish with Paycrest, and sends one still awaiting approval through Pretium", async () => {
    // #given one claim approved under Paycrest, its hop under way, and
    // another whose approval was asked for but not yet given
    const claims = flow();
    const { payout: underPaycrest } = await approvedClaim(claims);
    const { user } = await claims.employee("Amina Otieno");
    const waiting = await claims.submit(user);
    const asked = await sendJson(
      app,
      `${claims.claimsPath}/approval`,
      paying.company.admin,
      { method: "POST", body: { claimIds: [waiting.id] } },
    );
    expect(asked.status).toBe(201);
    const askedData = await dataOf(asked);
    const approval = claimApprovalSchema.parse(askedData);
    const options = (askedData as { options: SignOptions }).options;

    // #when staff change to Pretium, the admin approves the second, and
    // both hops deliver
    await switchTo("pretium");
    const confirmed = await sendJson(
      app,
      `${claims.claimsPath}/approval/${approval.challengeId}/confirm`,
      paying.company.admin,
      {
        method: "POST",
        body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
      },
    );
    expect(confirmed.status).toBe(200);
    await deliverHops();
    await outboundJob();

    // #then the first went to a Paycrest order, the second to Pretium
    const first = await reread(underPaycrest);
    const second = await reread({ id: approval.claims[0]?.payoutId ?? "" });
    expect({
      first: {
        provider: first.provider,
        status: first.status,
        orders: paycrest.state.created.filter(
          (order) => order.reference === first.id,
        ).length,
        pays: paysFor(first).length,
      },
      second: {
        provider: second.provider,
        status: second.status,
        orders: paycrest.state.created.filter(
          (order) => order.reference === second.id,
        ).length,
        pays: paysFor(second).length,
      },
    }).toEqual({
      first: { provider: "paycrest", status: "paying", orders: 1, pays: 0 },
      second: { provider: "pretium", status: "paying", orders: 0, pays: 1 },
    });

    // #when each provider pays
    const paycrestAnswered = await paycrestSettles(first.providerOrderId ?? "");
    pretium.state.settle(second.providerOrderId ?? "", "COMPLETE", "SKP1");
    const pretiumAnswered = await pretiumCallback(second.providerOrderId ?? "");
    await paycrestJob();
    await pretiumJob();

    // #then both are paid, each by its own provider
    expect({
      answered: [paycrestAnswered, pretiumAnswered],
      first: (await reread(first)).status,
      second: (await reread(second)).status,
    }).toEqual({ answered: [200, 200], first: "paid", second: "paid" });
  });
});

describe("a bank Pretium can't pay", () => {
  it("is refused before anything is sent while Pretium is active, and paid once staff change back to Paycrest", async () => {
    // #given a bill to a Prime Bank account, with Pretium active
    await switchTo("pretium");
    const payeeId = await insertPayee(db, paying.company, {
      name: "Acme Supplies Ltd",
      method: "bank",
      bankCode: "PRIEKENX",
      bankAccountNumber: "0123456789",
      accountName: "Acme Supplies Ltd",
      detailsChangedAt: new Date("2026-01-01T00:00:00Z"),
    });
    const billId = await insertBill(db, paying.company, {
      payeeId,
      categoryId: await addCategory(db, paying.company, "Supplies"),
      amountKes: 250_000n,
      dueOn: "2026-11-13",
      status: "due",
    });
    const billsPath = `/organizations/${paying.company.organizationId}/bills`;
    const prepare = () =>
      sendJson(app, `${billsPath}/payment`, paying.company.admin, {
        method: "POST",
        body: { billIds: [billId] },
      });

    // #when the admin asks to pay it
    const refused = await prepare();

    // #then
    const refusal = (await refused.json()) as { error?: { message: string } };
    expect({
      status: refused.status,
      message: refusal.error?.message,
      hops: (await hops()).length,
      sends: transitSends().length,
      pays: (await providerCallsForCompany()).pays.length,
      orders: (await providerCallsForCompany()).orders.length,
    }).toEqual({
      status: 400,
      message:
        "That bank can't be paid right now. Choose another bank or another way to pay.",
      hops: 0,
      sends: 0,
      pays: 0,
      orders: 0,
    });

    // #when staff change back to Paycrest and the admin pays it
    await switchTo("paycrest");
    const prepared = await prepare();
    expect(prepared.status).toBe(201);
    const data = await dataOf(prepared);
    const payment = billPaymentSchema.parse(data);
    const options = (data as { options: SignOptions }).options;
    const confirmed = await sendJson(
      app,
      `${billsPath}/payment/${payment.challengeId}/confirm`,
      paying.company.admin,
      {
        method: "POST",
        body: { response: paying.passkey.sign(options, TEST_ORIGIN) },
      },
    );
    expect(confirmed.status).toBe(200);
    await deliverHops();
    await outboundJob();
    const funded = await reread({ id: payment.bills[0]?.payoutId ?? "" });
    const answered = await paycrestSettles(funded.providerOrderId ?? "");

    // #then Paycrest paid the bank
    expect({
      provider: funded.provider,
      answered,
      payout: (await reread(funded)).status,
      bill: (await readBill(db, paying.company, billId)).status,
      institution: (await providerCallsForCompany()).orders.map(
        (order) => order.destination.recipient.institution,
      ),
      pays: (await providerCallsForCompany()).pays.length,
    }).toEqual({
      provider: "paycrest",
      answered: 200,
      payout: "paid",
      bill: "paid",
      institution: ["PRIEKENX"],
      pays: 0,
    });
  });
});

describe("Pretium reporting another settlement address", () => {
  it("fails a cash-out with nothing sent, and can't be made active while it does", async () => {
    // #given Pretium active, then reporting an address that isn't pinned
    await switchTo("pretium");
    pretium.state.settlementAddress = randomAddress();

    // #when a claim is approved and its hop delivers
    const { payout } = await approvedClaim();
    await deliverHops();
    await outboundJob();

    // #then funding failed before any transfer, in words that name no
    // provider
    const failed = await reread(payout);
    expect({
      status: failed.status,
      neutral: !NEUTRAL.test(failed.failureReason ?? ""),
      sends: transitSends().length,
      pays: (await providerCallsForCompany()).pays.length,
      debits: (await ledgerOf(payout)).length,
    }).toEqual({
      status: "failed",
      neutral: true,
      sends: 0,
      pays: 0,
      debits: 0,
    });

    // #when staff move back to Paycrest, then try Pretium again
    await switchTo("paycrest");
    const again = await staffPost(`${PATH}/prepare`, {
      provider: "pretium",
      reason: "Trying Pretium again in an end-to-end test.",
    });

    // #then
    const error = ((await again.json()) as { error: { message: string } })
      .error;
    const { rows } = await owner.query<{ provider: string }>(
      "SELECT active_cash_out_provider AS provider FROM platform_settings",
    );
    expect({
      status: again.status,
      message: error.message,
      active: rows[0]?.provider,
    }).toEqual({
      status: 409,
      message: expect.stringMatching(
        /^Pretium isn't ready to take cash-outs/,
      ) as string,
      active: "paycrest",
    });
  });
});
