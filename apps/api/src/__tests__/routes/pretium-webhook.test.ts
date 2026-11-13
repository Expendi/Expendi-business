import { randomUUID } from "node:crypto";
import pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { fundPayout } from "../../services/payout/fund.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import {
  makeFakeBaseRpc,
  makeFakePretium,
  makeFakePrivyWallets,
  signPretiumBody,
} from "../helpers/fakes.js";
import { reachableModules } from "../helpers/module-graph.js";
import {
  claimRequest,
  createPayingCompany,
  readPayout,
  updatePayout,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const privy = makeFakePrivyWallets();
const pretium = makeFakePretium();
const rpc = makeFakeBaseRpc();
const runtime = makeTestRuntime({
  privyWallets: privy.layer,
  pretium: pretium.layer,
  baseRpc: rpc.layer,
});
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: PayingCompany;
let payout: Payout;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  privy.state.reset();
  pretium.state.reset();
  paying = await createPayingCompany(runtime, db);
  await mineCompanySends(privy, rpc.state.receipts, db, paying.company);
  const [prepared] = await runtime.runPromise(
    preparePayouts({
      organizationId: paying.company.organizationId,
      actor: { type: "user", id: paying.company.admin.id },
      requests: [claimRequest()],
    }),
  );
  if (!prepared) throw new Error("nothing prepared");
  await updatePayout(db, paying.company, prepared.id, {
    provider: "pretium",
    status: "approved",
    approvalId: randomUUID(),
    approvedBy: paying.company.admin.id,
    approvedAt: new Date(),
  });
  payout = await runtime.runPromise(
    fundPayout({
      organizationId: paying.company.organizationId,
      payoutId: prepared.id,
    }),
  );
  if (payout.status !== "paying" || !payout.providerOrderId) {
    throw new Error("payout isn't paying with a transaction code");
  }
});

const code = () => payout.providerOrderId ?? "";

/** Pretium's callback body; it only prompts a fresh status read. */
function callback(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "COMPLETE",
    transaction_code: code(),
    receipt_number: "SKW1",
    public_name: "JANE WANJIKU",
    message: "Paid",
    ...overrides,
  });
}

async function deliver(
  body: string,
  signature: string | null = signPretiumBody(body),
): Promise<Response> {
  return app.request("/webhooks/pretium", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null && { "x-signature-key": signature }),
    },
    body,
  });
}

const status = async () =>
  (await readPayout(db, paying.company, payout.id)).status;

async function auditCount(action: string): Promise<number> {
  const { rows } = await owner.query<{ count: string }>(
    "SELECT count(*) FROM audit_log WHERE entity_type = 'payout' AND entity_id = $1 AND action = $2",
    [payout.id, action],
  );
  return Number(rows[0]?.count);
}

/** When a Pretium signature failure was last raised, if ever. */
const lastSignatureFailure = async (): Promise<Date | null> => {
  const { rows } = await owner.query<{ last: Date | null }>(
    "SELECT max(last_seen_at) AS last FROM ops_alerts WHERE kind = 'webhook_signature_failure' AND subject_key = 'pretium'",
  );
  return rows[0]?.last ?? null;
};

describe("POST /webhooks/pretium", () => {
  it("syncs the payout from Pretium's status once on a signed callback", async () => {
    // #given
    pretium.state.settle(code(), "COMPLETE", "SKW1");
    const reads = pretium.state.statusCalls.length;

    // #when
    const response = await deliver(callback());

    // #then
    const paid = await readPayout(db, paying.company, payout.id);
    expect({
      http: response.status,
      status: paid.status,
      receipt: paid.providerReference,
      reads: pretium.state.statusCalls.length - reads,
    }).toEqual({ http: 200, status: "paid", receipt: "SKW1", reads: 1 });
  });

  it("changes nothing more when the same callback arrives again", async () => {
    // #given
    pretium.state.settle(code(), "COMPLETE", "SKW1");
    const body = callback();

    // #when
    const first = await deliver(body);
    const second = await deliver(body);

    // #then
    expect({
      http: [first.status, second.status],
      status: await status(),
      paidAudits: await auditCount("payout.paid"),
    }).toEqual({ http: [200, 200], status: "paid", paidAudits: 1 });
  });

  it("refuses a bad signature, raises an alert and changes nothing", async () => {
    // #given
    pretium.state.settle(code(), "COMPLETE", "SKW1");
    const body = callback();
    const before = new Date();
    const reads = pretium.state.statusCalls.length;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      // #when
      const response = await deliver(body, signPretiumBody(`${body} `));

      // #then
      expect({
        http: response.status,
        status: await status(),
        alerted:
          ((await lastSignatureFailure())?.getTime() ?? 0) >=
          before.getTime() - 1_000,
        reads: pretium.state.statusCalls.length - reads,
      }).toEqual({ http: 401, status: "paying", alerted: true, reads: 0 });
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses a callback with no signature", async () => {
    // #when
    const response = await deliver(callback(), null);

    // #then
    expect({ http: response.status, status: await status() }).toEqual({
      http: 401,
      status: "paying",
    });
  });

  it("ignores a transaction it doesn't know: the account is shared", async () => {
    // #when
    const response = await deliver(
      callback({ transaction_code: "TXSOMEONEELSE" }),
    );

    // #then
    expect({ http: response.status, body: await response.json() }).toEqual({
      http: 200,
      body: { ignored: true },
    });
  });

  it("ignores a release callback and one without a transaction code", async () => {
    // #given
    pretium.state.settle(code(), "COMPLETE", "SKW1");

    // #when
    const released = await deliver(callback({ is_released: true }));
    const codeless = await deliver(callback({ transaction_code: undefined }));

    // #then
    expect({
      bodies: [await released.json(), await codeless.json()],
      status: await status(),
    }).toEqual({
      bodies: [{ ignored: true }, { ignored: true }],
      status: "paying",
    });
  });

  it("doesn't trust the callback's status over Pretium's", async () => {
    // #given Pretium still reports the transaction pending

    // #when the callback claims it is complete
    const response = await deliver(callback({ status: "COMPLETE" }));

    // #then
    expect({ http: response.status, status: await status() }).toEqual({
      http: 200,
      status: "paying",
    });
  });

  it("never changes a paid payout on a late FAILED callback", async () => {
    // #given
    pretium.state.settle(code(), "COMPLETE", "SKW1");
    await deliver(callback());

    // #when
    pretium.state.settle(code(), "FAILED");
    const response = await deliver(callback({ status: "FAILED" }));

    // #then
    expect({
      http: response.status,
      status: await status(),
      refunds: pretium.state.refundCalls.length,
    }).toEqual({ http: 200, status: "paid", refunds: 0 });
  });

  it("answers 500 when Pretium's status can't be read, so the job settles it", async () => {
    // #given
    pretium.state.failStatus = true;
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);

    try {
      // #when
      const response = await deliver(callback());

      // #then
      expect({ http: response.status, status: await status() }).toEqual({
        http: 500,
        status: "paying",
      });
    } finally {
      error.mockRestore();
    }
  });
});

describe("the code behind POST /webhooks/pretium", () => {
  it("only reads: it never reaches code that funds, tells Pretium to pay or refunds", () => {
    // #given
    const modules = reachableModules("routes/pretium-webhook.ts");

    // #then
    expect({
      sync: modules.has("services/payout/pretium-sync.ts"),
      moneyMoving: [...modules.keys()].filter((module) =>
        /^services\/(payout\/(fund|pretium-fund|approve|retry|onchain|payout-service)|wallet\/privy-wallets)\.ts$/.test(
          module,
        ),
      ),
      callers: [...modules]
        .filter(([, source]) =>
          // Comment lines may name a call (the Gateway's `refund()`)
          // without making it.
          source
            .split("\n")
            .some(
              (line) =>
                !/^\s*(\/\/|\/\*|\*)/.test(line) &&
                /\.(sendUsdc|createOrder|pay|refund)\s*\(/.test(line),
            ),
        )
        .map(([module]) => module),
    }).toEqual({ sync: true, moneyMoving: [], callers: [] });
  });
});
