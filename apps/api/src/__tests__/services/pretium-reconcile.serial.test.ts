import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { Payout } from "../../db/schema/index.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { DatabaseService } from "../../db/client.js";
import { payouts } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { fundPayout } from "../../services/payout/fund.js";
import { preparePayouts } from "../../services/payout/payout-service.js";
import { reconcilePretiumPayouts } from "../../services/payout/pretium-fund.js";
import { reconcilePretiumJob } from "../../station/reconcile-pretium.js";
import { mineCompanySends } from "../helpers/base-mining.js";
import {
  makeFakeBaseRpc,
  makeFakePretium,
  makeFakePrivyWallets,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  readPayout,
  updatePayout,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

// Serial: the job reconciles every company's Pretium payouts.

const privy = makeFakePrivyWallets();
const pretium = makeFakePretium();
const rpc = makeFakeBaseRpc();
const runtime = makeTestRuntime({
  privyWallets: privy.layer,
  pretium: pretium.layer,
  baseRpc: rpc.layer,
});
let db: Database;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
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
});

async function funded(): Promise<Payout> {
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
  return runtime.runPromise(
    fundPayout({
      organizationId: paying.company.organizationId,
      payoutId: prepared.id,
    }),
  );
}

const reconcile = () => runtime.runPromise(reconcilePretiumPayouts(500));
const reread = (payout: Payout) => readPayout(db, paying.company, payout.id);

describe("the Pretium reconciliation job", () => {
  it("never tells Pretium twice, however often it runs, and hands a lost request to a person", async () => {
    // #given the request to Pretium was lost on its way
    pretium.state.nextPayOutcome = "ambiguous_lost";
    const payout = await funded();

    // #when the job runs three times, then after the window
    const summaries = [await reconcile(), await reconcile(), await reconcile()];
    const within = (await reread(payout)).status;
    await updatePayout(db, paying.company, payout.id, {
      orderRequestedAt: new Date(Date.now() - 11 * 60_000),
    });
    await reconcile();

    // #then
    expect({
      within,
      status: (await reread(payout)).status,
      pays: pretium.state.payRequests.filter(
        (request) => request.reference === payout.id,
      ).length,
      errors: summaries.map((summary) => summary.errors),
      checked: summaries.every((summary) => summary.checked >= 1),
    }).toEqual({
      within: "paying",
      status: "needs_review",
      pays: 1,
      errors: [0, 0, 0],
      checked: true,
    });
  });

  it("marks a payout paid once Pretium reports it complete", async () => {
    // #given
    const payout = await funded();
    pretium.state.settle(payout.providerOrderId ?? "", "COMPLETE", "SKJ1");

    // #when
    const summary = await reconcile();

    // #then
    const paid = await reread(payout);
    expect({
      status: paid.status,
      receipt: paid.providerReference,
      changed: summary.changed >= 1,
      errors: summary.errors,
    }).toEqual({ status: "paid", receipt: "SKJ1", changed: true, errors: 0 });
  });

  it("asks for a refund on the run after the sync saw FAILED, once", async () => {
    // #given
    const payout = await funded();
    pretium.state.settle(payout.providerOrderId ?? "", "FAILED");

    // #when
    await reconcile();
    await reconcile();
    await reconcile();

    // #then
    expect({
      status: (await reread(payout)).status,
      refunds: pretium.state.refundCalls.filter(
        (hash) => hash === payout.txHash,
      ),
    }).toEqual({ status: "paying", refunds: [payout.txHash] });
  });

  it("records its heartbeat even when there is nothing to do", async () => {
    // #given no Pretium payout is in flight or awaiting funding, including
    // any other serial file left behind
    const { rows: inFlight } = await owner.query<{
      payout_id: string;
      organization_id: string;
    }>(
      `SELECT payout_id, organization_id FROM pretium_payouts_to_reconcile(10000)
       UNION SELECT payout_id, organization_id FROM pretium_cash_outs_awaiting_funding(10000)`,
    );
    for (const ref of inFlight) {
      await runInScope(db, { organizationId: ref.organization_id }, (tx) =>
        tx
          .update(payouts)
          .set({ status: "needs_review", failureReason: "cleared by test" })
          .where(eq(payouts.id, ref.payout_id)),
      );
    }
    await owner.query(
      "DELETE FROM station_heartbeats WHERE job = 'reconcile-pretium'",
    );

    // #when
    const summary = await runtime.runPromise(reconcilePretiumJob.run);

    // #then
    const { rows } = await owner.query<{ job: string }>(
      "SELECT job FROM station_heartbeats WHERE job = 'reconcile-pretium'",
    );
    expect({
      summary,
      rows,
      name: reconcilePretiumJob.name,
      everyMs: reconcilePretiumJob.everyMs,
    }).toEqual({
      summary: { checked: 0, changed: 0, errors: 0 },
      rows: [{ job: "reconcile-pretium" }],
      name: "reconcile-pretium",
      everyMs: 60_000,
    });
  });
});
