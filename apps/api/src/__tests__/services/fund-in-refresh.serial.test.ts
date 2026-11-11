import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../db/client.js";
import type { OneClickStatus } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { FundInView } from "../../services/intents/fund-in.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  createFundIn,
  getFundIn,
  refreshOpenFundIns,
} from "../../services/intents/fund-in.js";
import {
  createFundedCompany,
  ledgerOf,
  readQuote,
  saveQuote,
} from "../helpers/money-in.js";
import { randomNearTxHash } from "../helpers/near.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let funded: FundedCompany;
let fundIn: FundInView;

beforeAll(async () => {
  runtime = makeTestRuntime({ oneClick: oneClick.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
  fundIn = await runtime.runPromise(
    createFundIn({
      organizationId: funded.company.organizationId,
      actor: { type: "user", id: funded.company.admin.id },
      chain: "arbitrum",
      amount: 40_000_000n,
    }),
  );
});

afterAll(async () => {
  await runtime.dispose();
});

const refresh = () => runtime.runPromise(refreshOpenFundIns());

const quote = () => readQuote(db, funded, fundIn.id);

const shown = () =>
  runtime.runPromise(getFundIn(funded.company.organizationId, fundIn.id));

const deadlinePassed = () =>
  runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
    tx
      .update(intentQuotes)
      .set({ deadline: new Date(Date.now() - 60_000) })
      .where(eq(intentQuotes.id, fundIn.id)),
  );

describe("refreshOpenFundIns", () => {
  it.each<[OneClickStatus, string, string]>([
    ["SUCCESS", "succeeded", "completed"],
    ["REFUNDED", "refunded", "returning"],
    ["FAILED", "failed", "failed"],
  ])(
    "settles a fund-in 1Click reports as %s",
    async (status, expected, expectedShown) => {
      // #given
      oneClick.state.setStatus(fundIn.depositAddress, { status });

      // #when
      await refresh();

      // #then
      const saved = await quote();
      expect({
        status: saved.status,
        settled: saved.settledAt !== null,
        oneClickStatus: saved.oneClickStatus,
        shown: (await shown()).status,
      }).toEqual({
        status: expected,
        settled: true,
        oneClickStatus: status,
        shown: expectedShown,
      });
    },
  );

  it("asks for refunds into the company's own NEAR Intents account, so nobody gives a refund address", async () => {
    // #when
    const saved = await quote();

    // #then
    const asked = oneClick.state.quotes.get(fundIn.depositAddress)?.request;
    expect({
      askedRefundTo: asked?.refundTo,
      askedRefundType: asked?.refundType,
      refundTo: saved.refundTo,
      refundType: saved.refundType,
      depositType: saved.depositType,
    }).toEqual({
      askedRefundTo: funded.accountId,
      askedRefundType: "INTENTS",
      refundTo: funded.accountId,
      refundType: "INTENTS",
      depositType: "ORIGIN_CHAIN",
    });
  });

  it.each<[string, "succeeded" | "depositing" | "refunded", string]>([
    ["delivered", "succeeded", "returned"],
    ["still on its way", "depositing", "returning"],
    ["refunded again", "refunded", "returning"],
  ])(
    "shows a refunded fund-in whose return is %s as %s",
    async (_, returnStatus, expectedShown) => {
      // #given
      oneClick.state.setStatus(fundIn.depositAddress, { status: "REFUNDED" });
      await refresh();
      const back = await saveQuote(runtime, db, funded, "fund_in_return", {
        row: {
          status: returnStatus,
          ...(returnStatus !== "depositing" && { settledAt: new Date() }),
        },
      });
      await runInScope(
        db,
        { organizationId: funded.company.organizationId },
        (tx) =>
          tx
            .update(intentQuotes)
            .set({ returnQuoteId: back.id })
            .where(eq(intentQuotes.id, fundIn.id)),
      );

      // #when
      const status = (await shown()).status;

      // #then
      expect(status).toBe(expectedShown);
    },
  );

  it("still shows a fund-in refunded on its own chain, from before refunds went to NEAR Intents, as refunded", async () => {
    // #given
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(intentQuotes)
          .set({
            status: "refunded",
            settledAt: new Date(),
            refundType: "ORIGIN_CHAIN",
          })
          .where(eq(intentQuotes.id, fundIn.id)),
    );

    // #when
    const status = (await shown()).status;

    // #then
    expect(status).toBe("refunded");
  });

  it("never credits the ledger: that is the deposit watcher's, when the USDC arrives", async () => {
    // #given
    oneClick.state.setStatus(fundIn.depositAddress, {
      status: "SUCCESS",
      destinationChainTxHashes: [randomNearTxHash()],
      amountOut: fundIn.amountOut,
    });

    // #when
    await refresh();

    // #then
    expect(await ledgerOf(db, funded)).toEqual([]);
  });

  it("marks a fund-in as on its way once 1Click sees the deposit", async () => {
    // #given
    oneClick.state.setStatus(fundIn.depositAddress, {
      status: "PROCESSING",
      depositedAmount: 40_000_000n,
    });

    // #when
    await refresh();

    // #then
    const saved = await quote();
    expect({
      status: saved.status,
      settledAt: saved.settledAt,
      depositedAmount: saved.depositedAmount,
      shown: (await shown()).status,
    }).toEqual({
      status: "depositing",
      settledAt: null,
      depositedAmount: 40_000_000n,
      shown: "processing",
    });
  });

  it("expires a fund-in whose deadline passed with nothing deposited", async () => {
    // #given
    await deadlinePassed();

    // #when
    await refresh();

    // #then
    expect({
      status: (await quote()).status,
      shown: (await shown()).status,
    }).toEqual({ status: "expired", shown: "expired" });
  });

  it("keeps a fund-in open past its deadline while 1Click is still handling a deposit", async () => {
    // #given
    await deadlinePassed();
    oneClick.state.setStatus(fundIn.depositAddress, { status: "PROCESSING" });

    // #when
    await refresh();

    // #then
    expect((await quote()).status).toBe("depositing");
  });

  it("leaves a fund-in awaiting its deposit before the deadline", async () => {
    // #when
    await refresh();

    // #then
    const saved = await quote();
    expect({
      status: saved.status,
      oneClickStatus: saved.oneClickStatus,
      checked: saved.oneClickCheckedAt !== null,
      shown: (await shown()).status,
    }).toEqual({
      status: "quoted",
      oneClickStatus: "PENDING_DEPOSIT",
      checked: true,
      shown: "awaiting_deposit",
    });
  });

  it("leaves the fund-in as it was when 1Click doesn't answer, and tries again next run", async () => {
    // #given
    oneClick.state.setStatus(fundIn.depositAddress, { status: "SUCCESS" });
    oneClick.state.failNextStatus(1_000);
    const failed = await refresh();
    const afterFailure = (await quote()).status;
    oneClick.state.failNextStatus(0);

    // #when
    await refresh();

    // #then
    expect({
      unanswered: failed.unanswered >= 1,
      afterFailure,
      status: (await quote()).status,
    }).toEqual({
      unanswered: true,
      afterFailure: "quoted",
      status: "succeeded",
    });
  });

  it("leaves quotes that aren't fund-ins to whoever runs them", async () => {
    // #given
    const hop = await saveQuote(runtime, db, funded, "base_hop", {
      row: { status: "depositing" },
    });
    oneClick.state.setStatus(hop.depositAddress, { status: "SUCCESS" });

    // #when
    await refresh();

    // #then
    const saved = await readQuote(db, funded, hop.id);
    expect({
      status: saved.status,
      oneClickStatus: saved.oneClickStatus,
    }).toEqual({ status: "depositing", oneClickStatus: null });
  });
});
