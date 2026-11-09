import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { CardActionRequest } from "@expendi-business/shared";
import { cardConfirmationSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import { makeFakeLithic, TEST_ORIGIN } from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const lithic = makeFakeLithic();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

beforeAll(async () => {
  runtime = makeTestRuntime({ lithic: lithic.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterEach(async () => {
  await owner.query("UPDATE platform_settings SET payouts_paused = false");
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const PROGRAM = {
  legalName: "Twiga Foods Limited",
  kraPin: "P051234567X",
  addressLine1: "Waiyaki Way",
  city: "Nairobi",
  postalCode: "00100",
  phone: "+254700000001",
  contactFirstName: "Amina",
  contactLastName: "Otieno",
  contactEmail: "amina@twiga.example",
  contactPhone: "+254700000002",
};

describe("a platform-wide pause", () => {
  async function companyWithCards(): Promise<{
    readonly paying: PayingCompany;
    readonly issue: CardActionRequest;
    readonly load: CardActionRequest;
  }> {
    const paying = await createPayingCompany(runtime, db);
    const { company } = paying;
    const turnedOn = await sendJson(
      app,
      `/organizations/${company.organizationId}/cards/program`,
      company.admin,
      { method: "POST", body: PROGRAM },
    );
    expect(turnedOn.status).toBe(201);
    const member = await createUser(db);
    const membershipId = await addMember(db, company, member);
    const defaultCategoryId = await addCategory(db, company, "Software");
    return {
      paying,
      issue: {
        type: "issue_card",
        membershipId,
        nickname: "Marketing",
        monthlyLimitUsd: "100",
        defaultCategoryId,
      },
      load: { type: "load_balance", amountUsd: "50" },
    };
  }

  it("blocks new cards and Card loads, before the passkey and after", async () => {
    // #given
    const { paying, issue, load } = await companyWithCards();
    const { company, passkey } = paying;
    const path = (rest: string) =>
      `/organizations/${company.organizationId}/cards${rest}`;
    const start = (action: CardActionRequest) =>
      sendJson(app, path("/confirmations"), company.admin, {
        method: "POST",
        body: action,
      });
    const challengeFor = async (action: CardActionRequest) => {
      const response = await start(action);
      expect(response.status).toBe(201);
      const { data } = (await response.json()) as { data: unknown };
      return cardConfirmationSchema.parse(data);
    };
    const finish = (
      action: CardActionRequest,
      challenge: Awaited<ReturnType<typeof challengeFor>>,
    ) =>
      sendJson(
        app,
        path(`/confirmations/${challenge.challengeId}`),
        company.admin,
        {
          method: "POST",
          body: {
            action,
            response: passkey.sign(challenge.options, TEST_ORIGIN),
          },
        },
      );
    const issueChallenge = await challengeFor(issue);
    const loadChallenge = await challengeFor(load);

    // #when
    await owner.query("UPDATE platform_settings SET payouts_paused = true");
    const atConfirm = [
      await finish(issue, issueChallenge),
      await finish(load, loadChallenge),
    ];
    const atStart = await Promise.all([start(issue), start(load)]);

    // #then
    expect(
      [...atConfirm, ...atStart].map((response) => response.status),
    ).toEqual([409, 409, 409, 409]);
    expect(lithic.state.cards.size).toBe(0);
  });
});
