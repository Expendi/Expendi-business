import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TransferLogInput } from "../helpers/chain.js";
import type { TestCompany, TestWallet } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { walletTransactions } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { USDC_BASE_ADDRESS } from "../../services/chain/base.js";
import { transferReceipt } from "../helpers/chain.js";
import { createActiveWallet, createCompany } from "../helpers/db.js";
import {
  makeFakeBaseRpc,
  randomAddress,
  signAlchemyBody,
} from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const WETH_BASE = "0x4200000000000000000000000000000000000006";

const rpc = makeFakeBaseRpc();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let company: TestCompany;
let wallet: TestWallet;
let deliveries = 0;

beforeAll(async () => {
  runtime = makeTestRuntime({ baseRpc: rpc.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  company = await createCompany(db);
  wallet = await createActiveWallet(db, company);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

interface ActivityInput {
  readonly hash: string;
  readonly to?: string;
  readonly contract?: string;
  readonly category?: string;
  readonly removed?: boolean;
}

function addressActivity(
  activity: readonly ActivityInput[],
  network = "BASE_MAINNET",
): string {
  deliveries += 1;
  return JSON.stringify({
    webhookId: "wh_test",
    id: `whevt_${deliveries}`,
    createdAt: new Date().toISOString(),
    type: "ADDRESS_ACTIVITY",
    event: {
      network,
      activity: activity.map((entry) => ({
        fromAddress: randomAddress(),
        toAddress: entry.to ?? wallet.address,
        hash: entry.hash,
        category: entry.category ?? "token",
        asset: "USDC",
        rawContract: { address: entry.contract ?? USDC_BASE_ADDRESS },
        log: { removed: entry.removed ?? false },
      })),
    },
  });
}

/** Puts the transaction on the fake chain and returns its hash. */
function mined(
  transfers: readonly TransferLogInput[],
  status?: string,
): string {
  const receipt = transferReceipt(transfers, status ? { status } : {});
  rpc.state.receipts.set(receipt.transactionHash, receipt);
  return receipt.transactionHash;
}

/** `signature: null` sends no signature header at all. */
async function deliver(
  body: string,
  signature: string | null = signAlchemyBody(body),
): Promise<Response> {
  return app.request("/webhooks/alchemy", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null && { "x-alchemy-signature": signature }),
    },
    body,
  });
}

function ledger() {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .select({
        type: walletTransactions.type,
        usdcAmount: walletTransactions.usdcAmount,
        txHash: walletTransactions.txHash,
        logIndex: walletTransactions.logIndex,
      })
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, wallet.id)),
  );
}

describe("POST /webhooks/alchemy", () => {
  it("credits a USDC deposit to the company wallet, as the receipt reports it", async () => {
    // #given
    const hash = mined([
      { to: wallet.address, amount: 20_000_000n, logIndex: 4 },
    ]);

    // #when
    const response = await deliver(addressActivity([{ hash }]));

    // #then
    expect({ status: response.status, ledger: await ledger() }).toEqual({
      status: 200,
      ledger: [
        { type: "deposit", usdcAmount: 20_000_000n, txHash: hash, logIndex: 4 },
      ],
    });
  });

  it("credits a deposit once when Alchemy delivers it twice", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 5_000_000n }]);
    await deliver(addressActivity([{ hash }]));

    // #when
    const response = await deliver(addressActivity([{ hash }]));

    // #then
    expect({ status: response.status, rows: (await ledger()).length }).toEqual({
      status: 200,
      rows: 1,
    });
  });

  it("audits the deposit as a system action", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 1_000_000n }]);

    // #when
    await deliver(addressActivity([{ hash }]));

    // #then
    const { rows } = await owner.query<{
      actor_type: string;
      actor_id: string;
    }>(
      "SELECT actor_type, actor_id FROM audit_log WHERE organization_id = $1 AND action = 'wallet.deposit_received'",
      [company.organizationId],
    );
    expect(rows).toEqual([
      { actor_type: "system", actor_id: "alchemy-webhook" },
    ]);
  });

  it("doesn't credit another token, even if the delivery calls it USDC", async () => {
    // #given
    const hash = mined([
      { to: wallet.address, amount: 20_000_000n, contract: WETH_BASE },
    ]);

    // #when
    const response = await deliver(addressActivity([{ hash }]));

    // #then
    expect({ status: response.status, ledger: await ledger() }).toEqual({
      status: 200,
      ledger: [],
    });
  });

  it("ignores deliveries from any network but Base", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 20_000_000n }]);

    // #when
    const response = await deliver(addressActivity([{ hash }], "ETH_MAINNET"));

    // #then
    expect({ status: response.status, ledger: await ledger() }).toEqual({
      status: 200,
      ledger: [],
    });
  });

  it("doesn't credit a reverted transaction", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 20_000_000n }], "0x0");

    // #when
    await deliver(addressActivity([{ hash }]));

    // #then
    expect(await ledger()).toEqual([]);
  });

  it("doesn't credit a transfer reported as removed by a reorg", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 20_000_000n }]);

    // #when
    await deliver(addressActivity([{ hash, removed: true }]));

    // #then
    expect(await ledger()).toEqual([]);
  });

  it("credits only the company wallet's share of a multi-transfer transaction", async () => {
    // #given
    const hash = mined([
      { to: randomAddress(), amount: 7_000_000n, logIndex: 0 },
      { to: wallet.address, amount: 3_000_000n, logIndex: 1 },
    ]);

    // #when
    await deliver(addressActivity([{ hash }]));

    // #then
    expect(await ledger()).toEqual([
      { type: "deposit", usdcAmount: 3_000_000n, txHash: hash, logIndex: 1 },
    ]);
  });

  it("credits each company's wallet in its own ledger", async () => {
    // #given
    const other = await createCompany(db);
    const otherWallet = await createActiveWallet(db, other);
    const hash = mined([
      { to: wallet.address, amount: 1_000_000n, logIndex: 0 },
      { to: otherWallet.address, amount: 2_000_000n, logIndex: 1 },
    ]);

    // #when
    await deliver(addressActivity([{ hash }]));

    // #then
    const otherLedger = await runInScope(
      db,
      { organizationId: other.organizationId },
      (tx) =>
        tx
          .select({ usdcAmount: walletTransactions.usdcAmount })
          .from(walletTransactions),
    );
    expect({
      mine: (await ledger()).map((row) => row.usdcAmount),
      theirs: otherLedger.map((row) => row.usdcAmount),
    }).toEqual({ mine: [1_000_000n], theirs: [2_000_000n] });
  });

  it("rejects a bad signature and credits nothing", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 20_000_000n }]);
    const body = addressActivity([{ hash }]);

    // #when
    const response = await deliver(body, signAlchemyBody(`${body}tampered`));

    // #then
    expect({ status: response.status, ledger: await ledger() }).toEqual({
      status: 401,
      ledger: [],
    });
  });

  it("rejects a delivery with no signature", async () => {
    // #given
    const body = addressActivity([{ hash: mined([]) }]);

    // #when
    const response = await deliver(body, null);

    // #then
    expect(response.status).toBe(401);
  });

  it("rejects malformed JSON", async () => {
    // #when
    const response = await deliver("{not json");

    // #then
    expect(response.status).toBe(400);
  });

  it("asks Alchemy to retry when the receipt isn't available yet", async () => {
    // #given an unmined transaction
    const hash = `0x${"0".repeat(63)}1`;

    // #when
    const response = await deliver(addressActivity([{ hash }]));

    // #then
    expect(response.status).toBe(500);
  });

  it("asks Alchemy to retry when the RPC fails, then credits on the retry", async () => {
    // #given
    const hash = mined([{ to: wallet.address, amount: 9_000_000n }]);
    const body = addressActivity([{ hash }]);
    rpc.state.failNext();
    const failed = await deliver(body);

    // #when
    const retried = await deliver(body);

    // #then
    expect({
      failed: failed.status,
      retried: retried.status,
      rows: (await ledger()).length,
    }).toEqual({ failed: 500, retried: 200, rows: 1 });
  });

  it("acknowledges other webhook types without doing anything", async () => {
    // #given
    const body = JSON.stringify({ type: "MINED_TRANSACTION", id: "whevt_x" });

    // #when
    const response = await deliver(body);

    // #then
    expect(response.status).toBe(200);
  });
});
