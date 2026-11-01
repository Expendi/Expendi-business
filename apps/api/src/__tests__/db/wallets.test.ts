import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { NewWalletTransaction } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestWallet } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { DatabaseService } from "../../db/client.js";
import { wallets, walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { randomTxHash } from "../helpers/chain.js";
import { createActiveWallet } from "../helpers/db.js";
import { randomAddress } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let fixture: IsolationFixture;
let walletA: TestWallet;
let walletB: TestWallet;
let owner: pg.Pool;

function deposit(
  wallet: TestWallet,
  organizationId: string,
  overrides: Partial<NewWalletTransaction> = {},
): NewWalletTransaction {
  return {
    organizationId,
    walletId: wallet.id,
    type: "deposit",
    usdcAmount: 20_000_000n,
    txHash: randomTxHash(),
    logIndex: 0,
    blockNumber: 1n,
    ...overrides,
  };
}

const insertAs = (organizationId: string, row: NewWalletTransaction) =>
  runInScope(db, { organizationId }, (tx) =>
    tx.insert(walletTransactions).values(row),
  );

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  fixture = await createIsolationFixture(db);
  [walletA, walletB] = await Promise.all([
    createActiveWallet(db, fixture.companyA),
    createActiveWallet(db, fixture.companyB),
  ]);
  const { companyA, companyB } = fixture;
  await insertAs(
    companyA.organizationId,
    deposit(walletA, companyA.organizationId),
  );
  await insertAs(
    companyB.organizationId,
    deposit(walletB, companyB.organizationId),
  );
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

describe("wallets", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "wallets");
  });

  it("allows one wallet per company", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const second = runInScope(
      db,
      { organizationId: companyA.organizationId },
      (tx) =>
        tx.insert(wallets).values({
          organizationId: companyA.organizationId,
          perTransactionMaxUsdc: 1n,
        }),
    );

    // #then
    await expect(second).rejects.toMatchObject({
      cause: { constraint: "wallets_organization_id_unique" },
    });
  });

  it("refuses to mark a wallet active before its Privy IDs are saved", async () => {
    // #given
    const fresh = await createIsolationFixture(db);

    // #when
    const activate = runInScope(
      db,
      { organizationId: fresh.companyA.organizationId },
      (tx) =>
        tx.insert(wallets).values({
          organizationId: fresh.companyA.organizationId,
          perTransactionMaxUsdc: 1n,
          status: "active",
        }),
    );

    // #then
    await expect(activate).rejects.toMatchObject({
      cause: { constraint: "wallets_active_is_complete" },
    });
  });
});

describe("active_wallets_by_address", () => {
  const lookup = (addresses: readonly string[]) =>
    runInScope(db, {}, (tx) =>
      tx.execute<{ organization_id: string; address: string }>(
        sql`SELECT organization_id::text, address FROM active_wallets_by_address(ARRAY[${sql.join(
          addresses.map((address) => sql`${address}`),
          sql`, `,
        )}]::text[])`,
      ),
    );

  it("resolves only the addresses asked for, without a company in context", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const { rows } = await lookup([
      walletA.address.toUpperCase().replace("0X", "0x"),
    ]);

    // #then
    expect(rows).toEqual([
      { organization_id: companyA.organizationId, address: walletA.address },
    ]);
  });

  it("returns nothing for an unknown address", async () => {
    const { rows } = await lookup([randomAddress()]);
    expect(rows).toEqual([]);
  });

  it("can't be called with no company in context to read wallets directly", async () => {
    // #when
    const { rows } = await runInScope(db, {}, (tx) =>
      tx.execute(sql`SELECT id FROM wallets`),
    );

    // #then
    expect(rows).toEqual([]);
  });
});

describe("wallet_transactions", () => {
  it("is isolated between companies", async () => {
    await expectTableIsolation(fixture, "wallet_transactions");
  });

  it("credits one transfer log only once, even to another company", async () => {
    // #given
    const { companyA, companyB } = fixture;
    const txHash = randomTxHash();
    await insertAs(
      companyA.organizationId,
      deposit(walletA, companyA.organizationId, { txHash, logIndex: 3 }),
    );

    // #when
    const again = insertAs(
      companyB.organizationId,
      deposit(walletB, companyB.organizationId, {
        txHash: txHash.toUpperCase().replace("0X", "0x"),
        logIndex: 3,
      }),
    );

    // #then
    await expect(again).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_tx_log_unique" },
    });
  });

  it("can't record a row against another company's wallet", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const crossed = insertAs(
      companyA.organizationId,
      deposit(walletB, companyA.organizationId),
    );

    // #then
    await expect(crossed).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_wallet_organization_fk" },
    });
  });

  it.each([
    ["a negative deposit", { type: "deposit", usdcAmount: -1n }],
    ["a positive payout", { type: "payout", usdcAmount: 1n }],
    ["a zero refund", { type: "refund", usdcAmount: 0n }],
  ] as const)("rejects %s", async (_label, overrides) => {
    // #given
    const { companyA } = fixture;

    // #when
    const insert = insertAs(
      companyA.organizationId,
      deposit(walletA, companyA.organizationId, overrides),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_amount_sign" },
    });
  });

  it("rejects a deposit without its on-chain position", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const insert = insertAs(
      companyA.organizationId,
      deposit(walletA, companyA.organizationId, { logIndex: null }),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_deposit_is_onchain" },
    });
  });

  it.each(["UPDATE", "DELETE"] as const)(
    "rejects %s from the app role",
    async (operation) => {
      // #given
      const { companyA } = fixture;
      const statement =
        operation === "UPDATE"
          ? sql`UPDATE wallet_transactions SET usdc_amount = 1`
          : sql`DELETE FROM wallet_transactions`;

      // #when
      const change = runInScope(
        db,
        { organizationId: companyA.organizationId },
        (tx) => tx.execute(statement),
      );

      // #then
      await expect(change).rejects.toMatchObject({
        cause: { code: "42501" },
      });
    },
  );

  it.each([
    ["UPDATE", "UPDATE wallet_transactions SET usdc_amount = usdc_amount"],
    ["DELETE", "DELETE FROM wallet_transactions"],
    ["TRUNCATE", "TRUNCATE wallet_transactions"],
  ])(
    "rejects %s from the owner even with row security off",
    async (operation, statement) => {
      // #given row security (which already hides every row from the owner)
      // lifted inside a transaction that is rolled back, so only the trigger
      // stands in the way
      const client = await owner.connect();

      try {
        await client.query("BEGIN");
        await client.query(
          "ALTER TABLE wallet_transactions NO FORCE ROW LEVEL SECURITY",
        );

        // #when
        const change = client.query(statement);

        // #then
        await expect(change).rejects.toThrow(
          `wallet_transactions is append-only: ${operation} is not allowed`,
        );
      } finally {
        await client.query("ROLLBACK");
        client.release();
      }
    },
  );

  it("rejects an unknown wallet ID", async () => {
    // #given
    const { companyA } = fixture;

    // #when
    const insert = insertAs(
      companyA.organizationId,
      deposit(
        { id: randomUUID(), address: randomAddress() },
        companyA.organizationId,
      ),
    );

    // #then
    await expect(insert).rejects.toMatchObject({
      cause: { constraint: "wallet_transactions_wallet_organization_fk" },
    });
  });
});
