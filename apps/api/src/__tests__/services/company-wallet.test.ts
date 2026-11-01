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
import { ensureCompanyWallet } from "../../services/wallet/company-wallet.js";
import { createCompany } from "../helpers/db.js";
import {
  makeFakeAlchemyWebhook,
  makeFakePrivyWallets,
  randomAddress,
  TEST_WALLET_SETTINGS,
} from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const alchemy = makeFakeAlchemyWebhook();
let runtime: AppRuntime;
let db: Database;
let company: TestCompany;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({
    privyWallets: privy.layer,
    alchemyWebhook: alchemy.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  privy.state.reset();
  alchemy.state.watched.length = 0;
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

describe("ensureCompanyWallet", () => {
  it("creates an active wallet owned by the management key, with the API as signer", async () => {
    // #when
    const exit = await ensure();

    // #then
    const [created] = [...privy.state.wallets.values()];
    expect(created?.input).toMatchObject({
      externalId: company.organizationId,
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
    });
    expect(Exit.isSuccess(exit) && exit.value).toMatchObject({
      status: "active",
      address: created?.address,
      privyWalletId: created?.id,
    });
  });

  it("gives the wallet a policy owned by the management key, capped at the default", async () => {
    // #when
    await ensure();

    // #then
    const [policy] = [...privy.state.policies.values()];
    expect(policy?.input).toMatchObject({
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      perTransactionMaxUsdc: TEST_WALLET_SETTINGS.defaultPerTransactionMaxUsdc,
    });
  });

  it("starts watching the address for deposits", async () => {
    // #when
    const exit = await ensure();

    // #then
    const wallet = Exit.isSuccess(exit) ? exit.value : null;
    expect(alchemy.state.watched).toEqual([wallet?.address]);
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
    const callsBefore = { ...privy.state.calls };

    // #when
    await ensure();

    // #then
    expect(privy.state.calls).toEqual(callsBefore);
  });

  it("creates exactly one wallet under concurrent calls", async () => {
    // #when
    const exits = await Promise.all(Array.from({ length: 5 }, ensure));

    // #then
    const addresses = new Set(
      exits.flatMap((exit) =>
        Exit.isSuccess(exit) ? [exit.value.address] : [],
      ),
    );
    expect({
      rows: (await walletRows()).length,
      privyWallets: privy.state.wallets.size,
      addresses: addresses.size,
    }).toEqual({ rows: 1, privyWallets: 1, addresses: 1 });
  });

  it("resumes after the wallet step failed, reusing the saved policy", async () => {
    // #given
    privy.state.failNext("createWallet");
    const failed = await ensure();

    // #when
    const retried = await ensure();

    // #then
    expect({
      failedFirst: Exit.isFailure(failed),
      succeeded: Exit.isSuccess(retried),
      policiesCreated: privy.state.policies.size,
      walletsCreated: privy.state.wallets.size,
    }).toEqual({
      failedFirst: true,
      succeeded: true,
      policiesCreated: 1,
      walletsCreated: 1,
    });
  });

  it("adopts a wallet Privy already made for this company instead of making another", async () => {
    // #given an earlier attempt created the wallet, but its ID was never saved
    privy.state.failNext("createWallet");
    await ensure();
    const [row] = await walletRows();
    const policyId = row?.privyPolicyId ?? "";
    const orphan = {
      id: "wallet-orphan",
      address: randomAddress(),
      ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
      policyIds: [policyId],
      signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
    };
    privy.state.seedWallet(orphan, {
      externalId: company.organizationId,
      displayName: "orphan",
      policyId,
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
      idempotencyKey: "expired-long-ago",
    });
    const createsBefore = privy.state.calls.createWallet;

    // #when
    const exit = await ensure();

    // #then
    expect({
      privyWalletId: Exit.isSuccess(exit) ? exit.value.privyWalletId : null,
      newCreates: privy.state.calls.createWallet - createsBefore,
    }).toEqual({ privyWalletId: "wallet-orphan", newCreates: 0 });
  });

  it("refuses a Privy wallet that isn't owned by the management key", async () => {
    // #given
    privy.state.failNext("createWallet");
    await ensure();
    const [row] = await walletRows();
    const policyId = row?.privyPolicyId ?? "";
    privy.state.seedWallet(
      {
        id: "wallet-wrong-owner",
        address: randomAddress(),
        ownerId: null,
        policyIds: [policyId],
        signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
      },
      {
        externalId: company.organizationId,
        displayName: "wrong",
        policyId,
        ownerQuorumId: "someone-else",
        signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
        idempotencyKey: "other",
      },
    );

    // #when
    const exit = await ensure();

    // #then
    const [after] = await walletRows();
    const failure = Exit.isFailure(exit)
      ? Option.getOrNull(Cause.failureOption(exit.cause))
      : null;
    expect({ failure: failure?._tag, status: after?.status }).toEqual({
      failure: "WalletMisconfigured",
      status: "creating",
    });
  });

  it("retries watching the address if Alchemy was down", async () => {
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
