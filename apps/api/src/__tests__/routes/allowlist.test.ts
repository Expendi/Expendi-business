import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { addMember, createUser } from "../helpers/db.js";
import { randomAddress, TEST_ORIGIN } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime();
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paying = await createPayingCompany(runtime, db);
});

const base = () =>
  `/organizations/${paying.company.organizationId}/withdrawal-addresses`;

function post(path: string, body: unknown, privyUserId?: string) {
  return app.request(path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...bearer(privyUserId ?? paying.company.admin.privyUserId),
    },
    body: JSON.stringify(body),
  });
}

interface Challenge {
  readonly challengeId: string;
  readonly options: Parameters<SoftwarePasskey["sign"]>[0];
}

async function requestChange(change: unknown): Promise<Challenge> {
  const response = await post(`${base()}/changes`, change);
  const body = (await response.json()) as { data: Challenge };
  return body.data;
}

function confirm(
  challenge: Challenge,
  change: unknown,
  key: SoftwarePasskey = paying.passkey,
) {
  return post(`${base()}/changes/${challenge.challengeId}/confirm`, {
    change,
    response: key.sign(challenge.options, TEST_ORIGIN),
  });
}

async function listed(): Promise<string[]> {
  const response = await app.request(base(), {
    headers: bearer(paying.company.admin.privyUserId),
  });
  const body = (await response.json()) as { data: { address: string }[] };
  return body.data.map((row) => row.address);
}

describe("the address allowlist", () => {
  it("adds an address once the admin's passkey confirms it", async () => {
    // #given
    const address = randomAddress();
    const change = { action: "add", address, label: "Treasury" };
    const challenge = await requestChange(change);

    // #when
    const response = await confirm(challenge, change);

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 200,
      listed: [address],
    });
  });

  it("audits the addition", async () => {
    // #given
    const change = { action: "add", address: randomAddress(), label: "Ops" };

    // #when
    await confirm(await requestChange(change), change);

    // #then
    const { rows } = await owner.query<{ actor_id: string }>(
      "SELECT actor_id FROM audit_log WHERE organization_id = $1 AND action = 'withdrawal_address.added'",
      [paying.company.organizationId],
    );
    expect(rows).toEqual([{ actor_id: paying.company.admin.id }]);
  });

  it("refuses a different address than the one confirmed", async () => {
    // #given
    const confirmed = { action: "add", address: randomAddress(), label: "A" };
    const challenge = await requestChange(confirmed);

    // #when the signature is presented with another address
    const swapped = { ...confirmed, address: randomAddress() };
    const response = await confirm(challenge, swapped);

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 403,
      listed: [],
    });
  });

  it("refuses a signature from another passkey", async () => {
    // #given
    const change = { action: "add", address: randomAddress(), label: "A" };
    const challenge = await requestChange(change);

    // #when
    const response = await confirm(challenge, change, SoftwarePasskey.create());

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 403,
      listed: [],
    });
  });

  it("removes an address with a passkey confirmation, and audits it", async () => {
    // #given
    const added = { action: "add", address: randomAddress(), label: "Old" };
    const addResponse = await confirm(await requestChange(added), added);
    const { data } = (await addResponse.json()) as { data: { id: string } };
    const removal = { action: "remove", addressId: data.id };

    // #when
    const response = await confirm(await requestChange(removal), removal);

    // #then
    const { rows } = await owner.query(
      "SELECT 1 FROM audit_log WHERE organization_id = $1 AND action = 'withdrawal_address.removed'",
      [paying.company.organizationId],
    );
    expect({
      status: response.status,
      listed: await listed(),
      audited: rows.length,
    }).toEqual({ status: 200, listed: [], audited: 1 });
  });

  it("rejects something that isn't a Base address", async () => {
    // #when
    const response = await post(`${base()}/changes`, {
      action: "add",
      address: "not-an-address",
      label: "Bad",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an employee", async () => {
    // #given
    const employee = await createUser(db);
    await addMember(db, paying.company, employee, { role: "employee" });

    // #when
    const response = await post(
      `${base()}/changes`,
      { action: "add", address: randomAddress(), label: "Mine" },
      employee.privyUserId,
    );

    // #then
    expect(response.status).toBe(403);
  });

  it("is isolated between companies", async () => {
    const fixture = await createIsolationFixture(db);
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/withdrawal-addresses`,
    }));
  });
});
