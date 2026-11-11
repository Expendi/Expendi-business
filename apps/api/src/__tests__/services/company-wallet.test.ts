import { eq } from "drizzle-orm";
import { Cause, Exit, Option } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany } from "../helpers/db.js";
import { DatabaseService } from "../../db/client.js";
import { wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ensureCompanyWallet,
  transitExternalId,
} from "../../services/wallet/company-wallet.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  makeFakeAlchemyWebhook,
  makeFakePrivyWallets,
  randomAddress,
  TEST_WALLET_SETTINGS,
} from "../helpers/fakes.js";
import { makeFakeNearRelayer, randomNearAccount } from "../helpers/near.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const alchemy = makeFakeAlchemyWebhook();
const relayer = makeFakeNearRelayer();
let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    alchemyWebhook: alchemy.layer,
    nearRelayer: relayer.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  privy.state.reset();
  alchemy.state.watched.length = 0;
  relayer.state.activated.length = 0;
  company = await createCompany(db);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const ensure = () =>
  runtime.runPromiseExit(
    ensureCompanyWallet({
      organizationId: company.organizationId,
      actor: { type: "user", id: company.admin.id },
    }),
  );

const walletRows = () =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .select()
      .from(wallets)
      .where(eq(wallets.organizationId, company.organizationId)),
  );

const failureTag = (exit: Awaited<ReturnType<typeof ensure>>) =>
  Exit.isFailure(exit)
    ? (Option.getOrNull(Cause.failureOption(exit.cause))?._tag ?? "defect")
    : null;

const seededNearWalletInput = () => ({
  externalId: company.organizationId,
  displayName: "seeded",
  ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
  signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
  idempotencyKey: "expired-long-ago",
});

describe("ensureCompanyWallet", () => {
  it("creates an active company wallet on NEAR, owned by the management key, with the API as signer", async () => {
    // #when
    const exit = await ensure();

    // #then
    const [created] = [...privy.state.nearWallets.values()];
    expect(created?.input).toMatchObject({
      externalId: company.organizationId,
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
    });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      status: "active",
      chain: "near",
      address: created?.address,
      privyWalletId: created?.id,
    });
  });

  it("creates the transit wallet on Base under its own external ID, bound by the policy", async () => {
    // #when
    const exit = await ensure();

    // #then
    const [transit] = [...privy.state.wallets.values()];
    const [policy] = [...privy.state.policies.values()];
    expect(transit?.input).toMatchObject({
      externalId: transitExternalId(company.organizationId),
      policyId: policy?.id,
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
    });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      transitAddress: transit?.address,
      transitPrivyWalletId: transit?.id,
      privyPolicyId: policy?.id,
    });
  });

  it("gives the transit wallet a policy owned by the management key, capped at the default", async () => {
    // #when
    await ensure();

    // #then
    const [policy] = [...privy.state.policies.values()];
    expect(policy?.input).toMatchObject({
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      perTransactionMaxUsdc: TEST_WALLET_SETTINGS.defaultPerTransactionMaxUsdc,
    });
  });

  it("has the gas relayer make the company wallet's account usable on chain", async () => {
    // #when
    const exit = await ensure();

    // #then
    const wallet = Exit.isSuccess(exit) ? exit.value : null;
    expect(relayer.state.activated).toEqual([wallet?.address]);
    expect(wallet?.onchainActivatedAt).toBeInstanceOf(Date);
  });

  it("watches the transit address on Base, not the NEAR account", async () => {
    // #when
    const exit = await ensure();

    // #then
    const wallet = Exit.isSuccess(exit) ? exit.value : null;
    expect(alchemy.state.watched).toEqual([wallet?.transitAddress]);
    expect(wallet?.depositsWatchedAt).toBeInstanceOf(Date);
  });

  it("audits the creation", async () => {
    // #when
    const exit = await ensure();

    // #then
    const wallet = Exit.isSuccess(exit) ? exit.value : null;
    const entries = await auditEntries("wallet.created");
    expect(entries).toEqual([
      expect.objectContaining({
        actorType: "user",
        actorId: company.admin.id,
        entityId: wallet?.id,
      }),
    ]);
  });

  it("does nothing more when the wallet already exists", async () => {
    // #given
    await ensure();
    const before = {
      calls: { ...privy.state.calls },
      activations: relayer.state.activated.length,
      watched: alchemy.state.watched.length,
    };

    // #when
    await ensure();

    // #then
    expect({
      calls: privy.state.calls,
      activations: relayer.state.activated.length,
      watched: alchemy.state.watched.length,
    }).toEqual(before);
  });

  it("creates exactly one company wallet and one transit wallet under concurrent calls", async () => {
    // #when
    const exits = await Promise.all(Array.from({ length: 5 }, ensure));

    // #then
    const accounts = new Set(
      exits.flatMap((exit) =>
        Exit.isSuccess(exit) ? [exit.value.address] : [],
      ),
    );
    expect({
      succeeded: exits.filter(Exit.isSuccess).length,
      rows: (await walletRows()).length,
      companyWallets: privy.state.nearWallets.size,
      transitWallets: privy.state.wallets.size,
      policies: privy.state.policies.size,
      accounts: accounts.size,
      audited: (await auditEntries("wallet.created")).length,
    }).toEqual({
      succeeded: 5,
      rows: 1,
      companyWallets: 1,
      transitWallets: 1,
      policies: 1,
      accounts: 1,
      audited: 1,
    });
  });

  it("resumes after the company wallet step failed", async () => {
    // #given
    privy.state.failNext("createNearWallet");
    const failed = await ensure();

    // #when
    const retried = await ensure();

    // #then
    expect({
      failedFirst: Exit.isFailure(failed),
      status: Exit.isSuccess(retried) ? retried.value.status : null,
      companyWallets: privy.state.nearWallets.size,
    }).toEqual({ failedFirst: true, status: "active", companyWallets: 1 });
  });

  it("resumes after the transit wallet step failed, reusing the saved company wallet and policy", async () => {
    // #given
    privy.state.failNext("createWallet");
    const failed = await ensure();
    const [stopped] = await walletRows();

    // #when
    const retried = await ensure();

    // #then
    expect({
      failedFirst: Exit.isFailure(failed),
      savedCompanyWallet: stopped?.privyWalletId,
      savedPolicy: stopped?.privyPolicyId,
      finalCompanyWallet: Exit.isSuccess(retried)
        ? retried.value.privyWalletId
        : null,
      companyWalletCreates: privy.state.calls.createNearWallet,
      policyCreates: privy.state.calls.createPolicy,
      transitWallets: privy.state.wallets.size,
    }).toEqual({
      failedFirst: true,
      savedCompanyWallet: [...privy.state.nearWallets.values()][0]?.id,
      savedPolicy: [...privy.state.policies.values()][0]?.id,
      finalCompanyWallet: stopped?.privyWalletId,
      companyWalletCreates: 1,
      policyCreates: 1,
      transitWallets: 1,
    });
  });

  it("stays creating while the account isn't usable on chain, and resumes without touching Privy again", async () => {
    // #given
    relayer.state.failNext();
    const failed = await ensure();
    const [stopped] = await walletRows();
    const callsBefore = { ...privy.state.calls };

    // #when
    const retried = await ensure();

    // #then
    expect({
      failure: failureTag(failed),
      stoppedAs: stopped?.status,
      stoppedWithBothWallets:
        stopped?.privyWalletId !== null &&
        stopped?.transitPrivyWalletId !== null,
      activatedOnChain: stopped?.onchainActivatedAt,
      status: Exit.isSuccess(retried) ? retried.value.status : null,
      privyCallsOnRetry: privy.state.calls,
      activations: relayer.state.activated.length,
    }).toEqual({
      failure: "NearRelayerError",
      stoppedAs: "creating",
      stoppedWithBothWallets: true,
      activatedOnChain: null,
      status: "active",
      privyCallsOnRetry: callsBefore,
      activations: 1,
    });
  });

  it("adopts a company wallet Privy already made for this company instead of making another", async () => {
    // #given an earlier attempt created the wallet, but its ID was never saved
    const orphan = {
      id: "near-wallet-orphan",
      address: randomNearAccount(),
      ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
      policyIds: [],
      signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
    };
    privy.state.seedNearWallet(orphan, seededNearWalletInput());

    // #when
    const exit = await ensure();

    // #then
    expect({
      privyWalletId: Exit.isSuccess(exit) ? exit.value.privyWalletId : null,
      address: Exit.isSuccess(exit) ? exit.value.address : null,
      creates: privy.state.calls.createNearWallet,
    }).toEqual({
      privyWalletId: "near-wallet-orphan",
      address: orphan.address,
      creates: 0,
    });
  });

  it("adopts a transit wallet Privy already made for this company instead of making another", async () => {
    // #given
    privy.state.failNext("createWallet");
    await ensure();
    const [row] = await walletRows();
    const policyId = row?.privyPolicyId ?? "";
    privy.state.seedWallet(
      {
        id: "wallet-orphan",
        address: randomAddress(),
        ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
        policyIds: [policyId],
        signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
      },
      {
        externalId: transitExternalId(company.organizationId),
        displayName: "orphan",
        policyId,
        ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
        signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
        idempotencyKey: "expired-long-ago",
      },
    );
    const createsBefore = privy.state.calls.createWallet;

    // #when
    const exit = await ensure();

    // #then
    expect({
      transitPrivyWalletId: Exit.isSuccess(exit)
        ? exit.value.transitPrivyWalletId
        : null,
      newCreates: privy.state.calls.createWallet - createsBefore,
    }).toEqual({ transitPrivyWalletId: "wallet-orphan", newCreates: 0 });
  });

  it.each([
    [
      "isn't owned by the management key",
      { ownerId: null, signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId] },
    ],
    [
      "doesn't have the API as a signer",
      { ownerId: TEST_WALLET_SETTINGS.managementQuorumId, signerIds: [] },
    ],
    [
      "isn't an implicit NEAR account",
      {
        ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
        signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
        address: "company.near",
      },
    ],
  ])("refuses a Privy company wallet that %s", async (_name, wrong) => {
    // #given
    privy.state.seedNearWallet(
      {
        id: "near-wallet-wrong",
        address: randomNearAccount(),
        policyIds: [],
        ...wrong,
      },
      seededNearWalletInput(),
    );

    // #when
    const exit = await ensure();

    // #then
    const [after] = await walletRows();
    expect({
      failure: failureTag(exit),
      status: after?.status,
      saved: after?.privyWalletId,
      activations: relayer.state.activated.length,
    }).toEqual({
      failure: "WalletMisconfigured",
      status: "creating",
      saved: null,
      activations: 0,
    });
  });

  it("refuses a Privy transit wallet that doesn't carry the company's policy", async () => {
    // #given
    privy.state.seedWallet(
      {
        id: "wallet-no-policy",
        address: randomAddress(),
        ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
        policyIds: [],
        signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
      },
      {
        externalId: transitExternalId(company.organizationId),
        displayName: "wrong",
        policyId: "some-other-policy",
        ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
        signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
        idempotencyKey: "other",
      },
    );

    // #when
    const exit = await ensure();

    // #then
    const [after] = await walletRows();
    expect({
      failure: failureTag(exit),
      status: after?.status,
      saved: after?.transitPrivyWalletId,
    }).toEqual({
      failure: "WalletMisconfigured",
      status: "creating",
      saved: null,
    });
  });

  it("retries watching the transit address if Alchemy was down", async () => {
    // #given
    alchemy.state.failNext();
    const first = await ensure();

    // #when
    const second = await ensure();

    // #then
    expect({
      firstFailed: Exit.isFailure(first),
      watched: alchemy.state.watched.length,
      watchedAt: Exit.isSuccess(second)
        ? second.value.depositsWatchedAt instanceof Date
        : false,
    }).toEqual({ firstFailed: true, watched: 1, watchedAt: true });
  });

  it("leaves a wallet made on Base before the move as it is", async () => {
    // #given
    const legacy = await createActiveWallet(db, company);

    // #when
    const exit = await ensure();

    // #then
    expect({
      wallet: Exit.isSuccess(exit) && {
        chain: exit.value.chain,
        address: exit.value.address,
        transitAddress: exit.value.transitAddress,
      },
      privyCalls: Object.values(privy.state.calls).reduce(
        (total, count) => total + count,
        0,
      ),
      activations: relayer.state.activated.length,
    }).toEqual({
      wallet: { chain: "base", address: legacy.address, transitAddress: null },
      privyCalls: 0,
      activations: 0,
    });
  });

  it("finishes a wallet whose setup began before the move, on NEAR", async () => {
    // #given a row the old setup left with only its policy
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx.insert(wallets).values({
        organizationId: company.organizationId,
        chain: "base",
        perTransactionMaxUsdc: 1_000_000n,
        privyPolicyId: "policy-from-before",
      }),
    );

    // #when
    const exit = await ensure();

    // #then
    const [transit] = [...privy.state.wallets.values()];
    expect({
      wallet: Exit.isSuccess(exit) && {
        chain: exit.value.chain,
        status: exit.value.status,
        privyPolicyId: exit.value.privyPolicyId,
      },
      transitPolicy: transit?.input.policyId,
      policyCreates: privy.state.calls.createPolicy,
    }).toEqual({
      wallet: {
        chain: "near",
        status: "active",
        privyPolicyId: "policy-from-before",
      },
      transitPolicy: "policy-from-before",
      policyCreates: 0,
    });
  });
});

/** The app role can't read the audit log, so read it as the owner. */
async function auditEntries(action: string) {
  const { rows } = await owner.query<{
    actor_type: string;
    actor_id: string;
    entity_id: string | null;
  }>(
    "SELECT actor_type, actor_id, entity_id FROM audit_log WHERE organization_id = $1 AND action = $2",
    [company.organizationId, action],
  );
  return rows.map((row) => ({
    actorType: row.actor_type,
    actorId: row.actor_id,
    entityId: row.entity_id,
  }));
}
