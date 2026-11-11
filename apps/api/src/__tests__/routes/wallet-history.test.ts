import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { WalletHistoryResponse } from "@expendi-business/shared";
import { walletHistoryResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { payouts, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmWithdrawal,
  requestWithdrawal,
} from "../../services/withdrawal/withdrawals.js";
import { randomTxHash } from "../helpers/chain.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakePaycrest,
  makeFakePrivyWallets,
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import {
  allowlistAddress,
  claimRequest,
  createPayingCompany,
  payClaims,
  USDC,
} from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
let runtime: AppRuntime;
let db: Database;
let app: App;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    paycrest: paycrest.layer,
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
});

function history(query = "", privyUserId?: string) {
  return app.request(
    `/organizations/${paying.company.organizationId}/wallet/history${query}`,
    { headers: bearer(privyUserId ?? paying.company.admin.privyUserId) },
  );
}

async function historyPage(query = ""): Promise<WalletHistoryResponse> {
  const response = await history(query);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { data: unknown };
  return walletHistoryResponseSchema.parse(body.data);
}

async function refund(payout: Payout, amount: bigint) {
  await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    (tx) =>
      tx.insert(walletTransactions).values({
        organizationId: paying.company.organizationId,
        walletId: paying.wallet.id,
        type: "refund",
        usdcAmount: amount,
        txHash: randomTxHash(),
        logIndex: 0,
        blockNumber: 2n,
        counterpartyAddress: randomAddress(),
        payoutId: payout.id,
      }),
  );
}

/**
 * A withdrawal as a company wallet on Base sent it, before NEAR became the
 * main chain: approved through the API, then recorded as sent and debited.
 */
async function withdraw(amount: bigint): Promise<string> {
  const address = randomAddress();
  const addressId = await allowlistAddress(runtime, paying, address, "Ops");
  const challenge = await runtime.runPromise(
    requestWithdrawal({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      requestId: randomUUID(),
      addressId,
      amountUsdc: amount,
    }),
  );
  const withdrawal = await runtime.runPromise(
    confirmWithdrawal({
      organizationId: paying.company.organizationId,
      userId: paying.company.admin.id,
      challengeId: challenge.challengeId,
      response: paying.passkey.sign(challenge.options, TEST_ORIGIN),
    }),
  );
  const txHash = randomTxHash();
  await runInScope(
    db,
    { organizationId: paying.company.organizationId },
    async (tx) => {
      await tx
        .update(payouts)
        .set({
          status: "paying",
          failureReason: null,
          fundingStartedAt: new Date(),
          depositAddress: address,
          amountToTransferUsdc: amount,
          txHash,
        })
        .where(eq(payouts.id, withdrawal.id));
      await tx.insert(walletTransactions).values({
        organizationId: paying.company.organizationId,
        walletId: paying.wallet.id,
        type: "withdrawal",
        usdcAmount: -amount,
        txHash,
        counterpartyAddress: address,
        payoutId: withdrawal.id,
      });
    },
  );
  return withdrawal.id;
}

/** A deposit, a paid claim, its refund and a withdrawal, in that order. */
async function seedHistory() {
  const [claim] = await payClaims(runtime, db, paying, [claimRequest()]);
  if (!claim) throw new Error("no claim payout");
  await refund(claim, 1n * USDC);
  const withdrawalId = await withdraw(5n * USDC);
  return { claim, withdrawalId };
}

describe("GET /organizations/:id/wallet/history", () => {
  it("lists deposits, payouts, refunds and withdrawals, newest first", async () => {
    // #given
    await seedHistory();

    // #when
    const page = await historyPage();

    // #then
    expect(page.items.map((item) => item.type)).toEqual([
      "withdrawal",
      "refund",
      "payout",
      "deposit",
    ]);
  });

  it("says which chain each row moved on, and a withdrawal's payee chain", async () => {
    // #given
    await seedHistory();

    // #when
    const page = await historyPage();

    // #then
    expect(
      page.items.map((item) => ({
        type: item.type,
        chain: item.chain,
        recipientChain: item.payout?.recipientChain,
      })),
    ).toEqual([
      { type: "withdrawal", chain: "base", recipientChain: "base" },
      { type: "refund", chain: "base", recipientChain: null },
      { type: "payout", chain: "base", recipientChain: null },
      { type: "deposit", chain: "base", recipientChain: undefined },
    ]);
  });

  it("shows a NEAR deposit with its hash exactly as the chain gave it", async () => {
    // #given
    const txHash = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx.insert(walletTransactions).values({
          organizationId: paying.company.organizationId,
          walletId: paying.wallet.id,
          type: "deposit",
          chain: "near",
          usdcAmount: 3n * USDC,
          txHash,
          receiptId: "6ZMcXvGrmnEBcZLTU4wbBBmbHvNUmWUm4ou2ipVbdC1D",
          logIndex: 0,
          transferIndex: 0,
          blockNumber: 150_000_000n,
          counterpartyAddress: "funder.near",
        }),
    );

    // #when
    const page = await historyPage();

    // #then
    expect(page.items[0]).toMatchObject({
      type: "deposit",
      chain: "near",
      txHash,
      counterpartyAddress: "funder.near",
    });
  });

  it("signs amounts: money in is positive, money out negative", async () => {
    // #given
    await seedHistory();

    // #when
    const page = await historyPage();

    // #then
    expect(page.items.map((item) => item.usdcAmount)).toEqual([
      "-5000000",
      "1000000",
      expect.stringMatching(/^-\d+$/),
      "100000000",
    ]);
  });

  it("shows the payout behind a payout and its refund, with the M-Pesa number masked", async () => {
    // #given
    const { claim } = await seedHistory();

    // #when
    const page = await historyPage();

    // #then
    const expected = {
      id: claim.id,
      subjectType: "claim",
      method: "mpesa_phone",
      recipientName: "Jane Wanjiku",
      recipientDetail: "•••• 5678",
      recipientChain: null,
      amountKesCents: "150000",
      status: "paying",
      subjectId: claim.subjectId,
      payrollRunId: null,
      approvalId: claim.approvalId,
      approvedAt: claim.approvedAt?.toISOString(),
      paidAt: null,
      rate: claim.rate,
      failureReason: null,
    };
    expect(page.items.slice(1, 3).map((item) => item.payout)).toEqual([
      expected,
      expected,
    ]);
  });

  it("ties payouts approved with one passkey together, and says why one failed", async () => {
    // #given two claims paid together, and one of them fails
    const [first, second] = await payClaims(runtime, db, paying, [
      claimRequest(),
      claimRequest(),
    ]);
    if (!first || !second) throw new Error("no claim payouts");
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(payouts)
          .set({
            status: "failed",
            failureReason: "The M-Pesa number is wrong.",
          })
          .where(eq(payouts.id, second.id)),
    );

    // #when
    const page = await historyPage();

    // #then
    const byPayout = new Map(
      page.items.flatMap((item) =>
        item.payout ? [[item.payout.id, item.payout] as const] : [],
      ),
    );
    expect({
      sameApproval:
        byPayout.get(first.id)?.approvalId ===
        byPayout.get(second.id)?.approvalId,
      approvalId: byPayout.get(first.id)?.approvalId,
      failed: byPayout.get(second.id)?.failureReason,
      subjects: [
        byPayout.get(first.id)?.subjectId,
        byPayout.get(second.id)?.subjectId,
      ],
    }).toEqual({
      sameApproval: true,
      approvalId: first.approvalId,
      failed: "The M-Pesa number is wrong.",
      subjects: [first.subjectId, second.subjectId],
    });
  });

  it("never returns a full M-Pesa number", async () => {
    // #given
    await seedHistory();

    // #when
    const body = await (await history()).text();

    // #then
    expect(body).not.toContain("712345678");
  });

  it("shows a withdrawal's address, label and status", async () => {
    // #given
    const { withdrawalId } = await seedHistory();

    // #when
    const [withdrawal] = (await historyPage()).items;

    // #then
    expect(withdrawal?.payout).toMatchObject({
      id: withdrawalId,
      subjectType: "withdrawal",
      method: "usdc",
      recipientName: "Ops",
      recipientDetail: withdrawal?.counterpartyAddress,
      status: "paying",
    });
  });

  it("shows a deposit's sender and transaction, with no payout", async () => {
    // #given
    await seedHistory();

    // #when
    const deposit = (await historyPage()).items.at(-1);

    // #then
    expect({
      type: deposit?.type,
      onChain: /^0x[0-9a-f]{64}$/.test(deposit?.txHash ?? ""),
      payout: deposit?.payout,
    }).toEqual({ type: "deposit", onChain: true, payout: null });
  });

  it("pages through the history without gaps or repeats", async () => {
    // #given
    await seedHistory();
    const all = (await historyPage()).items.map((item) => item.id);

    // #when
    const first = await historyPage("?limit=3");
    const second = await historyPage(`?limit=3&before=${first.nextCursor}`);

    // #then
    expect({
      ids: [...first.items, ...second.items].map((item) => item.id),
      lastCursor: second.nextCursor,
    }).toEqual({ ids: all, lastCursor: null });
  });

  it("is empty for a company with no wallet yet", async () => {
    // #given
    const { companyA } = await createIsolationFixture(db);

    // #when
    const response = await app.request(
      `/organizations/${companyA.organizationId}/wallet/history`,
      { headers: bearer(companyA.admin.privyUserId) },
    );

    // #then
    expect(await response.json()).toEqual({
      success: true,
      data: { items: [], nextCursor: null },
    });
  });

  it("refuses a cursor that isn't a ledger row ID", async () => {
    // #when
    const response = await history("?before=not-a-uuid");

    // #then
    expect(response.status).toBe(400);
  });

  it("returns nothing for another company's cursor", async () => {
    // #given
    const other = await createPayingCompany(runtime, db);
    const [theirDeposit] = await runInScope(
      db,
      { organizationId: other.company.organizationId },
      (tx) => tx.select({ id: walletTransactions.id }).from(walletTransactions),
    );

    // #when
    const page = await historyPage(`?before=${theirDeposit?.id ?? ""}`);

    // #then
    expect(page.items).toEqual([]);
  });

  it("is for admins only", async () => {
    // #given
    const employee = await createUser(db);
    await addMember(db, paying.company, employee, { role: "employee" });

    // #when
    const response = await history("", employee.privyUserId);

    // #then
    expect(response.status).toBe(403);
  });

  it("keeps companies apart", async () => {
    // #given
    const fixture = await createIsolationFixture(db);

    // #then
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/wallet/history`,
    }));
  });
});
