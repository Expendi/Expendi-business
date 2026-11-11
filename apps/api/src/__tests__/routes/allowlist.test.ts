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

async function listedWithChains(): Promise<
  { chain: string; address: string }[]
> {
  const response = await app.request(base(), {
    headers: bearer(paying.company.admin.privyUserId),
  });
  const body = (await response.json()) as {
    data: { chain: string; address: string }[];
  };
  return body.data.map(({ chain, address }) => ({ chain, address }));
}

/** An EIP-55 test vector, and the same address with one letter's case flipped. */
const BASE_CHECKSUMMED = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
const BASE_BAD_CHECKSUM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd";
const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/**
 * Valid on two chains at once: lowercase base58 that decodes to 32 bytes is
 * a Solana address, and also a NEAR named account.
 */
const SOLANA_AND_NEAR = "kar457p4ye36ts5g6t48f4r4f39jsa8kc7dp754extm";

describe("the address allowlist", () => {
  it("adds an address once the admin's passkey confirms it", async () => {
    // #given
    const address = randomAddress();
    const change = { action: "add", chain: "base", address, label: "Treasury" };
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
    const change = {
      action: "add",
      chain: "base",
      address: randomAddress(),
      label: "Ops",
    };

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
    const confirmed = {
      action: "add",
      chain: "base",
      address: randomAddress(),
      label: "A",
    };
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
    const change = {
      action: "add",
      chain: "base",
      address: randomAddress(),
      label: "A",
    };
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
    const added = {
      action: "add",
      chain: "base",
      address: randomAddress(),
      label: "Old",
    };
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

  it.each([
    ["a NEAR implicit account", "near", "ab".repeat(32)],
    ["a named NEAR account", "near", "treasury.acme.near"],
    ["a Solana address", "solana", SOLANA_ADDRESS],
  ])("adds %s exactly as given", async (_name, chain, address) => {
    // #given
    const change = { action: "add", chain, address, label: "Treasury" };

    // #when
    const response = await confirm(await requestChange(change), change);

    // #then
    const body = (await response.json()) as { data: unknown };
    expect(body.data).toMatchObject({ chain, address, label: "Treasury" });
    expect(await listedWithChains()).toEqual([{ chain, address }]);
  });

  it("lowercases a Base address, and only after checking its checksum", async () => {
    // #given
    const change = {
      action: "add",
      chain: "base",
      address: ` ${BASE_CHECKSUMMED} `,
      label: "Treasury",
    };

    // #when
    await confirm(await requestChange(change), change);

    // #then
    expect(await listedWithChains()).toEqual([
      { chain: "base", address: BASE_CHECKSUMMED.toLowerCase() },
    ]);
  });

  it("audits the chain with the address", async () => {
    // #given
    const change = {
      action: "add",
      chain: "solana",
      address: SOLANA_ADDRESS,
      label: "Ops",
    };

    // #when
    await confirm(await requestChange(change), change);

    // #then
    const { rows } = await owner.query<{ after: unknown }>(
      "SELECT after FROM audit_log WHERE organization_id = $1 AND action = 'withdrawal_address.added'",
      [paying.company.organizationId],
    );
    expect(rows[0]?.after).toMatchObject({
      chain: "solana",
      address: SOLANA_ADDRESS,
    });
  });

  it("refuses the same address on another chain than the one confirmed", async () => {
    // #given an address that is valid on Solana and on NEAR
    const address = SOLANA_AND_NEAR;
    const confirmed = { action: "add", chain: "solana", address, label: "A" };
    const challenge = await requestChange(confirmed);

    // #when the signature is presented with another chain
    const response = await confirm(challenge, { ...confirmed, chain: "near" });

    // #then
    expect({
      status: response.status,
      listed: await listedWithChains(),
    }).toEqual({ status: 403, listed: [] });
  });

  it.each([
    [
      "a Base address written in another case",
      "base",
      BASE_CHECKSUMMED,
      BASE_CHECKSUMMED.toLowerCase(),
    ],
    ["a NEAR account", "near", "acme.near", "acme.near"],
    ["a Solana address", "solana", SOLANA_ADDRESS, SOLANA_ADDRESS],
  ])(
    "refuses %s that is already allowed",
    async (_name, chain, first, again) => {
      // #given
      const added = { action: "add", chain, address: first, label: "First" };
      await confirm(await requestChange(added), added);

      // #when
      const response = await post(`${base()}/changes`, {
        action: "add",
        chain,
        address: again,
        label: "Again",
      });

      // #then
      const body = (await response.json()) as { error: { message: string } };
      expect({ status: response.status, message: body.error.message }).toEqual({
        status: 400,
        message: "That address is already allowed.",
      });
    },
  );

  it("allows the same characters on two chains as two addresses", async () => {
    // #given
    const address = SOLANA_AND_NEAR;
    const onSolana = {
      action: "add",
      chain: "solana",
      address,
      label: "Solana",
    };
    await confirm(await requestChange(onSolana), onSolana);
    const onNear = { action: "add", chain: "near", address, label: "NEAR" };

    // #when
    const response = await confirm(await requestChange(onNear), onNear);

    // #then
    expect(response.status).toBe(200);
    expect(await listedWithChains()).toEqual([
      { chain: "solana", address },
      { chain: "near", address },
    ]);
  });

  it.each([
    [
      "something that isn't an address",
      "base",
      "not-an-address",
      "That Base address isn't valid.",
    ],
    [
      "a Base address with a bad checksum",
      "base",
      BASE_BAD_CHECKSUM,
      "That Base address isn't valid.",
    ],
    [
      "a NEAR account on Base",
      "base",
      "acme.near",
      "That Base address isn't valid.",
    ],
    [
      "a NEAR account with a capital letter",
      "near",
      "Acme.near",
      "That NEAR account isn't valid.",
    ],
    [
      "a NEAR account that is too long",
      "near",
      "a".repeat(65),
      "That NEAR account isn't valid.",
    ],
    [
      "a Solana address on NEAR",
      "near",
      SOLANA_ADDRESS,
      "That NEAR account isn't valid.",
    ],
    [
      "a Solana address in lowercase",
      "solana",
      SOLANA_ADDRESS.toLowerCase(),
      "That Solana address isn't valid.",
    ],
    [
      "base58 that stands for 31 bytes",
      "solana",
      "3guQgf9mkU1JiELnxmxNhoxCPZpy6n4YUcwuWp8av8",
      "That Solana address isn't valid.",
    ],
    [
      "a Base address on Solana",
      "solana",
      BASE_CHECKSUMMED,
      "That Solana address isn't valid.",
    ],
  ])("rejects %s", async (_name, chain, address, message) => {
    // #when
    const response = await post(`${base()}/changes`, {
      action: "add",
      chain,
      address,
      label: "Bad",
    });

    // #then
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(400);
    expect(body.error.message).toContain(message);
    expect(await listedWithChains()).toEqual([]);
  });

  it.each([
    ["no chain", { action: "add", address: BASE_CHECKSUMMED, label: "Bad" }],
    [
      "a chain Expendi doesn't pay on",
      {
        action: "add",
        chain: "ethereum",
        address: BASE_CHECKSUMMED,
        label: "Bad",
      },
    ],
  ])("rejects an address with %s", async (_name, change) => {
    // #when
    const response = await post(`${base()}/changes`, change);

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
      { action: "add", chain: "base", address: randomAddress(), label: "Mine" },
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
