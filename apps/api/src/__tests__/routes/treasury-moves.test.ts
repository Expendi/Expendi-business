import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  approvalChallengeSchema,
  treasuryMoveListSchema,
  treasuryMovePreviewSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { TestUser } from "../helpers/db.js";
import type { TreasuryCompany } from "../helpers/treasury-moves.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import { TEST_ORIGIN } from "../helpers/fakes.js";
import { makeNearPayoutWorld } from "../helpers/near-payouts.js";
import {
  createTreasuryCompany,
  USDC,
  VAULT_ID,
} from "../helpers/treasury-moves.js";

const world = makeNearPayoutWorld({ PRIVY_EARN_VAULT_ID: VAULT_ID });
const { runtime, privy } = world;
let app: App;
let db: Database;
let company: TreasuryCompany;
let accountant: TestUser;
let employee: TestUser;

beforeAll(async () => {
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

afterAll(async () => {
  await runtime.dispose();
});

beforeEach(async () => {
  privy.state.resetEarn();
  company = await createTreasuryCompany(world, db, {
    balance: 100n * USDC,
    perTransactionMaxUsdc: 30n * USDC,
  });
  accountant = await createUser(db);
  await addMember(db, company.company, accountant, { role: "accountant" });
  employee = await createUser(db);
  await addMember(db, company.company, employee, { role: "employee" });
});

const movesPath = (rest = "") =>
  `/organizations/${company.tenant.organizationId}/treasury/moves${rest}`;

const dataOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { data?: unknown }).data;

const request = (amountUsdc: bigint) => ({
  direction: "to_treasury",
  amountUsdc: amountUsdc.toString(),
});

/** Both steps as the admin: ask for the passkey, then finish with it. */
async function start(amountUsdc: bigint, confirmedAmount = amountUsdc) {
  const asked = await sendJson(
    app,
    movesPath("/confirmations"),
    company.company.admin,
    {
      method: "POST",
      body: request(confirmedAmount),
    },
  );
  expect(asked.status, await asked.clone().text()).toBe(201);
  const challenge = approvalChallengeSchema.parse(await dataOf(asked));
  return sendJson(app, movesPath(), company.company.admin, {
    method: "POST",
    body: {
      ...request(amountUsdc),
      challengeId: challenge.challengeId,
      response: company.passkey.sign(challenge.options, TEST_ORIGIN),
    },
  });
}

describe("POST /organizations/:id/treasury/moves/preview", () => {
  it("shows the parts, the cost and the time without moving anything", async () => {
    // #when
    const response = await sendJson(
      app,
      movesPath("/preview"),
      company.company.admin,
      { method: "POST", body: request(70n * USDC) },
    );

    // #then three parts within the 30 USDC cap, a cost, a time, and no move or quote saved
    const preview = treasuryMovePreviewSchema.parse(await dataOf(response));
    expect({
      status: response.status,
      parts: preview.parts,
      perPartMax: preview.perPartMaxUsdc,
      cost: preview.estimatedCostUsdc,
      available: preview.availableUsdc,
      slow: preview.estimatedSeconds > 0,
    }).toEqual({
      status: 200,
      parts: 3,
      perPartMax: (30n * USDC).toString(),
      cost: (3n * 4_465n).toString(),
      available: (100n * USDC).toString(),
      slow: true,
    });
    const history = treasuryMoveListSchema.parse(
      await dataOf(await sendJson(app, movesPath(), company.company.admin)),
    );
    expect(history.moves).toEqual([]);
  });

  it("is for admins only", async () => {
    // #then
    for (const user of [accountant, employee]) {
      const response = await sendJson(app, movesPath("/preview"), user, {
        method: "POST",
        body: request(20n * USDC),
      });
      expect(response.status).toBe(403);
    }
  });

  it("refuses an amount under 10 USDC and one the wallet can't cover", async () => {
    // #then
    const small = await sendJson(
      app,
      movesPath("/preview"),
      company.company.admin,
      {
        method: "POST",
        body: request(9n * USDC),
      },
    );
    const large = await sendJson(
      app,
      movesPath("/preview"),
      company.company.admin,
      {
        method: "POST",
        body: request(101n * USDC),
      },
    );
    expect([small.status, large.status]).toEqual([400, 409]);
  });
});

describe("starting a move over the routes", () => {
  it("starts with the passkey, answers 201 and shows the move to an accountant", async () => {
    // #when
    const response = await start(40n * USDC);

    // #then
    expect({ status: response.status, data: await dataOf(response) }).toEqual({
      status: 201,
      data: {
        id: expect.any(String) as string,
        direction: "to_treasury",
        status: "open",
        requestedUsdc: (40n * USDC).toString(),
        movedUsdc: null,
        costUsdc: null,
        failure: null,
        createdAt: expect.any(String) as string,
        settledAt: null,
      },
    });
    for (const user of [company.company.admin, accountant]) {
      const history = treasuryMoveListSchema.parse(
        await dataOf(await sendJson(app, movesPath(), user)),
      );
      expect(
        history.moves.map((move) => [move.status, move.requestedUsdc]),
      ).toEqual([["open", (40n * USDC).toString()]]);
    }
  });

  it("refuses a second move while one is open, as a 409", async () => {
    // #given an open move
    expect((await start(20n * USDC)).status).toBe(201);

    // #when another is asked for
    const asked = await sendJson(
      app,
      movesPath("/confirmations"),
      company.company.admin,
      {
        method: "POST",
        body: request(20n * USDC),
      },
    );

    // #then
    expect(asked.status).toBe(409);
  });

  it("refuses to start with a confirmation for another amount", async () => {
    // #when
    const response = await start(30n * USDC, 20n * USDC);

    // #then
    expect(response.status).toBe(403);
  });

  it("keeps an accountant and an employee out of the confirmation and the start", async () => {
    // #then
    for (const user of [accountant, employee]) {
      const asked = await sendJson(app, movesPath("/confirmations"), user, {
        method: "POST",
        body: request(20n * USDC),
      });
      const started = await sendJson(app, movesPath(), user, {
        method: "POST",
        body: request(20n * USDC),
      });
      expect([asked.status, started.status]).toEqual([403, 403]);
    }
    expect((await sendJson(app, movesPath(), employee)).status).toBe(403);
  });

  it("refuses moving back to the wallet for now", async () => {
    // #when
    const asked = await sendJson(
      app,
      movesPath("/confirmations"),
      company.company.admin,
      {
        method: "POST",
        body: { direction: "to_wallet", amountUsdc: (20n * USDC).toString() },
      },
    );

    // #then
    expect(asked.status).toBe(503);
  });
});
