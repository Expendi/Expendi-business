import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { wallets, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { randomTxHash } from "../helpers/chain.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  makeFakePaycrest,
  makeFakePrivyWallets,
  randomAddress,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { randomNearAccount } from "../helpers/near.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;
let walletA: TestWallet;
const paycrest = makeFakePaycrest();
const privy = makeFakePrivyWallets();

beforeAll(async () => {
  runtime = makeTestRuntime({
    paycrest: paycrest.layer,
    privyWallets: privy.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
  walletA = await createActiveWallet(db, fixture.companyA);
  await createActiveWallet(db, fixture.companyB);
  const { organizationId } = fixture.companyA;
  await runInScope(db, { organizationId }, (tx) =>
    tx.insert(walletTransactions).values([
      {
        organizationId,
        walletId: walletA.id,
        type: "deposit",
        usdcAmount: 20_000_000n,
        txHash: randomTxHash(),
        logIndex: 0,
        blockNumber: 1n,
      },
      {
        organizationId,
        walletId: walletA.id,
        type: "withdrawal",
        usdcAmount: -7_500_000n,
      },
    ]),
  );
});

afterAll(async () => {
  await runtime.dispose();
});

const getWallet = (organizationId: string, privyUserId: string) =>
  app.request(`/organizations/${organizationId}/wallet`, {
    headers: bearer(privyUserId),
  });

describe("GET /organizations/:organizationId/wallet", () => {
  it("shows an admin the address, the ledger balance and what it can spend", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const response = await getWallet(
      companyA.organizationId,
      companyA.admin.privyUserId,
    );

    // #then
    expect({ status: response.status, body: await response.json() }).toEqual({
      status: 200,
      body: {
        success: true,
        data: {
          status: "active",
          address: walletA.address,
          chain: "base",
          usdcBalance: "12500000",
          availableUsdc: "12500000",
          kesEquivalent: { kesCents: "160850", rate: "128.68" },
          cashOutLimits: { minKesCents: "6500", maxKesCents: "30000000" },
        },
      },
    });
  });

  it("refuses an employee", async () => {
    // #given
    const { companyA } = fixture;
    const employee = await createUser(db);
    await addMember(db, companyA, employee, { role: "employee" });

    // #when
    const response = await getWallet(
      companyA.organizationId,
      employee.privyUserId,
    );

    // #then
    expect(response.status).toBe(403);
  });

  it.each([
    ["before the Privy wallet exists", { status: "creating" as const }],
    [
      "before its transit address is watched",
      {
        status: "active" as const,
        privyWalletId: "wallet-unwatched",
        address: randomNearAccount(),
        privyPolicyId: "policy-unwatched",
        transitPrivyWalletId: "transit-unwatched",
        transitAddress: randomAddress(),
        onchainActivatedAt: new Date(),
        depositsWatchedAt: null,
      },
    ],
  ])(
    "reports the wallet as creating %s, without calling Privy",
    async (_label, row) => {
      // #given
      const company = await createCompany(db);
      await runInScope(db, { organizationId: company.organizationId }, (tx) =>
        tx.insert(wallets).values({
          organizationId: company.organizationId,
          perTransactionMaxUsdc: 5_000_000_000n,
          ...row,
        }),
      );
      privy.state.reset();

      // #when
      const response = await getWallet(
        company.organizationId,
        company.admin.privyUserId,
      );

      // #then
      expect({ status: response.status, body: await response.json() }).toEqual({
        status: 200,
        body: { success: true, data: { status: "creating" } },
      });
      expect(new Set(Object.values(privy.state.calls))).toEqual(new Set([0]));
    },
  );

  it("returns 404 when the company has no wallet row at all", async () => {
    // #given
    const company = await createCompany(db);

    // #when
    const response = await getWallet(
      company.organizationId,
      company.admin.privyUserId,
    );

    // #then
    expect(response.status).toBe(404);
  });

  it("shows a zero balance for a new wallet", async () => {
    // #given
    const company = await createCompany(db);
    await createActiveWallet(db, company);

    // #when
    const response = await getWallet(
      company.organizationId,
      company.admin.privyUserId,
    );

    // #then
    expect(await response.json()).toMatchObject({
      data: { status: "active", usdcBalance: "0" },
    });
  });

  it("still shows the balance when Paycrest is down, without the KES equivalent", async () => {
    // #given
    const { companyA } = fixture;
    paycrest.state.failRate = true;

    // #when
    const response = await getWallet(
      companyA.organizationId,
      companyA.admin.privyUserId,
    );

    // #then
    paycrest.state.failRate = false;
    expect({
      status: response.status,
      body: await response.json(),
    }).toMatchObject({
      status: 200,
      body: {
        data: {
          status: "active",
          usdcBalance: "12500000",
          kesEquivalent: null,
        },
      },
    });
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/wallet`,
    }));
  });
});

describe("POST /organizations/:organizationId/wallet", () => {
  it("reports a finished wallet as active without creating another", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const response = await app.request(
      `/organizations/${companyA.organizationId}/wallet`,
      { method: "POST", headers: bearer(companyA.admin.privyUserId) },
    );

    // #then
    expect(await response.json()).toEqual({
      success: true,
      data: { status: "active", address: walletA.address },
    });
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/wallet`,
      init: { method: "POST" },
    }));
  });
});
