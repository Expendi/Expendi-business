import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { FundInChain } from "@expendi-business/shared";
import { fundInSchema, fundInsResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestUser } from "../helpers/db.js";
import type { FundedCompany } from "../helpers/money-in.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { intentQuotes } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  ONE_CLICK_FUND_IN_USDC_ASSET_IDS,
  ONE_CLICK_USDC_ASSET_IDS,
} from "../../services/intents/one-click.js";
import {
  addMember,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import { createFundedCompany, readQuote } from "../helpers/money-in.js";
import { makeFakeOneClick } from "../helpers/one-click.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";

const oneClick = makeFakeOneClick();
let runtime: AppRuntime;
let db: Database;
let app: App;
let funded: FundedCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ oneClick: oneClick.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

beforeEach(async () => {
  funded = await createFundedCompany(db);
});

afterAll(async () => {
  await runtime.dispose();
});

const path = (organizationId: string, suffix = "") =>
  `/organizations/${organizationId}/wallet/fund-ins${suffix}`;

function start(
  body: unknown,
  as: TestUser = funded.company.admin,
  organizationId = funded.company.organizationId,
) {
  return app.request(path(organizationId), {
    method: "POST",
    headers: { ...bearer(as.privyUserId), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const read = (
  suffix = "",
  as: TestUser = funded.company.admin,
  organizationId = funded.company.organizationId,
) =>
  app.request(path(organizationId, suffix), {
    headers: bearer(as.privyUserId),
  });

const fromBase = (amount = "25000000") => ({ chain: "base", amount });

async function data(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data?: unknown };
  return body.data;
}

async function started(body: unknown = fromBase()) {
  return fundInSchema.parse(await data(await start(body)));
}

async function member(role: "accountant" | "employee"): Promise<TestUser> {
  const user = await createUser(db);
  await addMember(db, funded.company, user, { role });
  return user;
}

const savedFundIns = () =>
  runInScope(db, { organizationId: funded.company.organizationId }, (tx) =>
    tx
      .select({ id: intentQuotes.id })
      .from(intentQuotes)
      .where(eq(intentQuotes.organizationId, funded.company.organizationId)),
  );

describe("POST /organizations/:id/wallet/fund-ins", () => {
  it("gives the admin a deposit address for exactly the amount, awaiting the deposit", async () => {
    // #given
    const request = fromBase("25000000");

    // #when
    const response = await start(request);

    // #then
    const fundIn = fundInSchema.parse(await data(response));
    expect({ status: response.status, fundIn }).toEqual({
      status: 201,
      fundIn: {
        id: fundIn.id,
        chain: "base",
        amountIn: "25000000",
        amountOut: (25_000_000n - oneClick.state.costPerQuote).toString(),
        depositAddress: fundIn.depositAddress,
        deadline: fundIn.deadline,
        status: "awaiting_deposit",
        createdAt: fundIn.createdAt,
      },
    });
  });

  it.each<FundInChain>(["base", "ethereum", "arbitrum", "solana"])(
    "takes a firm quote from USDC on %s to the company wallet, refunding into the company's NEAR Intents account",
    async (chain) => {
      // #given
      const before = oneClick.state.quoteRequests.length;

      // #when
      await start({ chain, amount: "5000000" });

      // #then
      const [request] = oneClick.state.quoteRequests.slice(before);
      expect({
        dry: request?.dry,
        swapType: request?.swapType,
        originAsset: request?.originAsset,
        destinationAsset: request?.destinationAsset,
        amount: request?.amount,
        recipient: request?.recipient,
        refundTo: request?.refundTo,
        refundType: request?.refundType,
        deadlineAhead: (request?.deadline.getTime() ?? 0) > Date.now(),
      }).toEqual({
        dry: false,
        swapType: "EXACT_INPUT",
        originAsset: ONE_CLICK_FUND_IN_USDC_ASSET_IDS[chain],
        destinationAsset: ONE_CLICK_USDC_ASSET_IDS.near,
        amount: 5_000_000n,
        recipient: funded.accountId,
        refundTo: funded.accountId,
        refundType: "INTENTS",
        deadlineAhead: true,
      });
    },
  );

  it("ignores a refund address an older app still sends: refunds go to the company's NEAR Intents account", async () => {
    // #given
    const before = oneClick.state.quoteRequests.length;

    // #when
    const response = await start({
      ...fromBase(),
      refundAddress: "0x2222222222222222222222222222222222222222",
    });

    // #then
    const [request] = oneClick.state.quoteRequests.slice(before);
    expect({ status: response.status, refundTo: request?.refundTo }).toEqual({
      status: 201,
      refundTo: funded.accountId,
    });
  });

  it("saves the quote as a fund-in before showing its deposit address", async () => {
    // #given
    const fundIn = await started();

    // #when
    const quote = await readQuote(db, funded, fundIn.id);

    // #then
    expect({
      purpose: quote.purpose,
      status: quote.status,
      swapType: quote.swapType,
      depositAddress: quote.depositAddress,
      recipient: quote.recipient,
      walletId: quote.walletId,
    }).toEqual({
      purpose: "fund_in",
      status: "quoted",
      swapType: "EXACT_INPUT",
      depositAddress: fundIn.depositAddress,
      recipient: funded.accountId,
      walletId: funded.walletId,
    });
  });

  it.each([
    ["an amount of zero", { ...fromBase(), amount: "0" }],
    ["an amount that isn't base units", { ...fromBase(), amount: "2.5" }],
    ["a chain Expendi doesn't take", { ...fromBase(), chain: "tron" }],
  ])("refuses %s and asks 1Click nothing", async (_name, body) => {
    // #given
    const before = oneClick.state.quoteRequests.length;

    // #when
    const response = await start(body);

    // #then
    expect({
      status: response.status,
      quotes: oneClick.state.quoteRequests.length - before,
    }).toEqual({ status: 400, quotes: 0 });
  });

  it.each(["accountant", "employee"] as const)(
    "doesn't let an %s start a fund-in",
    async (role) => {
      // #given
      const user = await member(role);

      // #when
      const response = await start(fromBase(), user);

      // #then
      expect({
        status: response.status,
        saved: await savedFundIns(),
      }).toEqual({ status: 403, saved: [] });
    },
  );

  it("says the amount can't be funded in when 1Click refuses the quote, and saves nothing", async () => {
    // #given
    oneClick.state.failNextQuotes("refused");

    // #when
    const response = await start(fromBase());

    // #then
    expect({ status: response.status, saved: await savedFundIns() }).toEqual({
      status: 400,
      saved: [],
    });
  });

  it.each(["unknown", "untrusted"] as const)(
    "is unavailable when 1Click's quote is %s, and saves nothing",
    async (failure) => {
      // #given
      oneClick.state.failNextQuotes(failure);

      // #when
      const response = await start(fromBase());

      // #then
      expect({ status: response.status, saved: await savedFundIns() }).toEqual({
        status: 503,
        saved: [],
      });
    },
  );

  it("refuses a company whose wallet is still on Base", async () => {
    // #given
    const company = await createCompany(db);
    await createActiveWallet(db, company);

    // #when
    const response = await start(
      fromBase(),
      company.admin,
      company.organizationId,
    );

    // #then
    expect(response.status).toBe(409);
  });
});

describe("GET /organizations/:id/wallet/fund-ins", () => {
  it("lists the company's fund-ins newest first", async () => {
    // #given
    const first = await started();
    const second = await started({ chain: "solana", amount: "7000000" });

    // #when
    const response = await read();

    // #then
    const listed = fundInsResponseSchema.parse(await data(response));
    expect(listed.map((fundIn) => [fundIn.id, fundIn.chain])).toEqual([
      [second.id, "solana"],
      [first.id, "base"],
    ]);
  });

  it("lists at most the last 20", async () => {
    // #given
    for (let count = 0; count < 21; count += 1) await started();

    // #when
    const response = await read();

    // #then
    expect(fundInsResponseSchema.parse(await data(response))).toHaveLength(20);
  });

  it("lets an accountant see them, deposit address included", async () => {
    // #given
    const fundIn = await started();
    const accountant = await member("accountant");

    // #when
    const response = await read("", accountant);

    // #then
    expect(fundInsResponseSchema.parse(await data(response))).toEqual([fundIn]);
  });

  it("doesn't let an employee see them", async () => {
    // #given
    await started();
    const employee = await member("employee");

    // #when
    const response = await read("", employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("never lists another company's fund-ins", async () => {
    // #given
    await started();
    const other = await createFundedCompany(db);

    // #when
    const response = await read(
      "",
      other.company.admin,
      other.company.organizationId,
    );

    // #then
    expect(await data(response)).toEqual([]);
  });
});

describe("GET /organizations/:id/wallet/fund-ins/:fundInId", () => {
  it("returns one fund-in", async () => {
    // #given
    const fundIn = await started();

    // #when
    const response = await read(`/${fundIn.id}`);

    // #then
    expect(fundInSchema.parse(await data(response))).toEqual(fundIn);
  });

  it("shows a fund-in as processing once 1Click has seen its deposit", async () => {
    // #given
    const fundIn = await started();
    await runInScope(
      db,
      { organizationId: funded.company.organizationId },
      (tx) =>
        tx
          .update(intentQuotes)
          .set({ status: "depositing", oneClickStatus: "PROCESSING" })
          .where(eq(intentQuotes.id, fundIn.id)),
    );

    // #when
    const response = await read(`/${fundIn.id}`);

    // #then
    expect(fundInSchema.parse(await data(response)).status).toBe("processing");
  });

  it.each([
    ["an unknown ID", () => randomUUID()],
    ["something that isn't an ID", () => "latest"],
  ])("answers 404 for %s", async (_name, id) => {
    // #when
    const response = await read(`/${id()}`);

    // #then
    expect(response.status).toBe(404);
  });

  it("answers 404 for another company's fund-in", async () => {
    // #given
    const fundIn = await started();
    const other = await createFundedCompany(db);

    // #when
    const response = await read(
      `/${fundIn.id}`,
      other.company.admin,
      other.company.organizationId,
    );

    // #then
    expect(response.status).toBe(404);
  });
});
