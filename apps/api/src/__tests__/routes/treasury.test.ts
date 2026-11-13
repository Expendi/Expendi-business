import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  approvalChallengeSchema,
  treasuryStatusSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { wallets } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import { turnOnTreasury } from "../../services/treasury/turn-on.js";
import { PrivyWallets } from "../../services/wallet/privy-wallets.js";
import { sendJson } from "../helpers/claims.js";
import {
  addMember,
  createActiveNearWallet,
  createActiveWallet,
  createCompany,
  createUser,
} from "../helpers/db.js";
import {
  makeFakeEmailSender,
  makeFakePrivyWallets,
  randomAddress,
  TEST_ORIGIN,
  TEST_WALLET_SETTINGS,
} from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const VAULT_ID = "ry2qt6co7rkpwkr5mqudloo4";

const privy = makeFakePrivyWallets();
const email = makeFakeEmailSender();

let runtime: AppRuntime;
let app: App;
let unconfiguredRuntime: AppRuntime;
let unconfiguredApp: App;
let db: Database;
let owner: pg.Pool;

beforeAll(async () => {
  const fakes = { privyWallets: privy.layer, emailSender: email.layer };
  runtime = makeTestRuntime(fakes, { PRIVY_EARN_VAULT_ID: VAULT_ID });
  unconfiguredRuntime = makeTestRuntime(fakes, {
    PRIVY_EARN_VAULT_ID: undefined,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  unconfiguredApp = createApp({ runtime: unconfiguredRuntime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([
    runtime.dispose(),
    unconfiguredRuntime.dispose(),
    owner.end(),
  ]);
});

interface Setup {
  readonly company: TestCompany;
  readonly walletId: string;
  readonly passkey: SoftwarePasskey;
}

async function enrol(user: TestUser): Promise<SoftwarePasskey> {
  const passkey = SoftwarePasskey.create();
  const options = await runtime.runPromise(startPasskeyEnrolment(user.id));
  await runtime.runPromise(
    finishPasskeyEnrolment(user.id, passkey.register(options, TEST_ORIGIN)),
  );
  return passkey;
}

/** A company with an active wallet on NEAR and an admin who has a passkey. */
async function setUp(): Promise<Setup> {
  const company = await createCompany(db);
  const wallet = await createActiveNearWallet(
    db,
    company,
    privy.state.addNearWallet(),
  );
  return {
    company,
    walletId: wallet.id,
    passkey: await enrol(company.admin),
  };
}

const treasuryPath = (company: TestCompany, rest = "") =>
  `/organizations/${company.organizationId}/treasury${rest}`;

const bodyOf = async (response: Response): Promise<unknown> =>
  ((await response.json()) as { data?: unknown }).data;

async function start(
  target: App,
  company: TestCompany,
  user: Pick<TestUser, "privyUserId">,
) {
  return sendJson(target, treasuryPath(company, "/confirmations"), user, {
    method: "POST",
  });
}

/** Both steps as the admin: ask for the passkey, then finish with it. */
async function turnOn(
  setup: Setup,
  target: App = app,
  user: Pick<TestUser, "privyUserId"> = setup.company.admin,
): Promise<Response> {
  const started = await start(target, setup.company, user);
  expect(started.status, await started.clone().text()).toBe(201);
  const challenge = approvalChallengeSchema.parse(await bodyOf(started));
  return sendJson(target, treasuryPath(setup.company), user, {
    method: "POST",
    body: {
      challengeId: challenge.challengeId,
      response: setup.passkey.sign(challenge.options, TEST_ORIGIN),
    },
  });
}

const statusOf = async (
  company: TestCompany,
  user: Pick<TestUser, "privyUserId">,
  target: App = app,
) => bodyOf(await sendJson(target, treasuryPath(company), user));

const walletRow = async (company: TestCompany) => {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select()
        .from(wallets)
        .where(eq(wallets.organizationId, company.organizationId)),
  );
  if (!row) throw new Error("wallet row not found");
  return row;
};

const auditActions = async (company: TestCompany) => {
  const { rows } = await owner.query<{ action: string; after: unknown }>(
    `SELECT action, after FROM audit_log
      WHERE organization_id = $1 AND action = 'treasury.turned_on'`,
    [company.organizationId],
  );
  return rows;
};

const treasuryWallets = () =>
  [...privy.state.wallets.values()].filter((wallet) =>
    wallet.input.externalId.startsWith("treasury-"),
  );

beforeEach(() => {
  privy.state.reset();
  email.state.reset();
});

describe("GET /organizations/:organizationId/treasury", () => {
  it("says unavailable while no vault is configured, and off once one is", async () => {
    // #given
    const { company } = await setUp();

    // #then
    expect(await statusOf(company, company.admin, unconfiguredApp)).toEqual({
      status: "unavailable",
    });
    expect(await statusOf(company, company.admin)).toEqual({ status: "off" });
  });

  it("shows an accountant the status and refuses an employee", async () => {
    // #given
    const { company } = await setUp();
    const accountant = await createUser(db);
    await addMember(db, company, accountant, { role: "accountant" });
    const employee = await createUser(db);
    await addMember(db, company, employee, { role: "employee" });

    // #when
    const asEmployee = await sendJson(app, treasuryPath(company), employee);

    // #then
    expect(await statusOf(company, accountant)).toEqual({ status: "off" });
    expect(asEmployee.status).toBe(403);
  });
});

describe("GET /organizations/:organizationId/treasury once Treasury is on", () => {
  it("shows an empty account's figures, in the shared schema, to an admin and an accountant", async () => {
    // #given
    const setup = await setUp();
    await turnOn(setup);
    const accountant = await createUser(db);
    await addMember(db, setup.company, accountant, { role: "accountant" });

    // #when
    const asAdmin = await statusOf(setup.company, setup.company.admin);
    const asAccountant = await statusOf(setup.company, accountant);

    // #then
    const row = await walletRow(setup.company);
    for (const seen of [asAdmin, asAccountant]) {
      const parsed = treasuryStatusSchema.parse(seen);
      expect(parsed).toEqual({
        status: "on",
        address: row.treasuryAddress,
        valueUsdc: "0",
        yieldUsdc: "0",
        rateBps: 519,
        kesEquivalent: { kesCents: "0", rate: "128.68" },
        openMove: null,
        asOf: expect.any(String) as string,
        saved: false,
      });
    }
  });

  it("refuses an employee once it is on", async () => {
    // #given
    const setup = await setUp();
    await turnOn(setup);
    const employee = await createUser(db);
    await addMember(db, setup.company, employee, { role: "employee" });

    // #when
    const response = await sendJson(app, treasuryPath(setup.company), employee);

    // #then
    expect(response.status).toBe(403);
  });

  it("answers with nothing to show, not an error, when Privy can't be reached", async () => {
    // #given
    const setup = await setUp();
    await turnOn(setup);
    privy.state.failNext("vaultPosition");
    privy.state.failNext("vaultDetails");

    // #when
    const response = await sendJson(
      app,
      treasuryPath(setup.company),
      setup.company.admin,
    );

    // #then
    expect({
      status: response.status,
      data: await bodyOf(response),
    }).toMatchObject({
      status: 200,
      data: { status: "on", valueUsdc: null, asOf: null, saved: true },
    });
  });
});

describe("turning Treasury on", () => {
  it("creates the wallet under the Treasury policy and shows its address", async () => {
    // #given
    const setup = await setUp();

    // #when
    const response = await turnOn(setup);

    // #then
    const row = await walletRow(setup.company);
    expect({ status: response.status, data: await bodyOf(response) }).toEqual({
      status: 200,
      data: {
        status: "on",
        address: row.treasuryAddress,
        valueUsdc: null,
        yieldUsdc: null,
        rateBps: null,
        kesEquivalent: null,
        openMove: null,
        asOf: null,
        saved: false,
      },
    });
    const [wallet] = treasuryWallets();
    expect(wallet).toMatchObject({
      id: row.treasuryPrivyWalletId,
      address: row.treasuryAddress,
      ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
      signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
      policyIds: [row.treasuryPrivyPolicyId],
      input: {
        externalId: `treasury-${setup.company.organizationId}`,
        displayName: `treasury-${setup.company.organizationId}`,
        idempotencyKey: `treasury-wallet-${setup.walletId}`,
      },
    });
    expect(
      privy.state.policies.get(`treasury-policy-${setup.walletId}`)?.input,
    ).toMatchObject({
      vaultId: VAULT_ID,
      ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
      perTransactionMaxUsdc: 5_000_000_000n,
    });
    expect(row.treasuryTurnedOnAt).toBeInstanceOf(Date);
    expect(row.treasuryTurnedOnBy).toBe(setup.company.admin.id);
    expect(await statusOf(setup.company, setup.company.admin)).toMatchObject({
      status: "on",
      address: row.treasuryAddress,
    });
  });

  it("audits it and emails every admin", async () => {
    // #given
    const setup = await setUp();
    const colleague = await createUser(db);
    await addMember(db, setup.company, colleague, { role: "admin" });
    const employee = await createUser(db);
    await addMember(db, setup.company, employee, { role: "employee" });

    // #when
    await turnOn(setup);

    // #then
    const row = await walletRow(setup.company);
    const audited = await auditActions(setup.company);
    expect(audited).toHaveLength(1);
    expect(audited[0]?.after).toMatchObject({
      treasuryAddress: row.treasuryAddress,
      vaultId: VAULT_ID,
    });
    expect(email.state.sent.map((message) => message.to).sort()).toEqual(
      [setup.company.admin.email, colleague.email].sort(),
    );
    expect(email.state.sent[0]?.subject).toBe("Treasury turned on");
  });

  it("makes one Privy wallet when turned on twice, and changes nothing the second time", async () => {
    // #given
    const setup = await setUp();
    await turnOn(setup);
    const first = await walletRow(setup.company);
    email.state.reset();

    // #when
    const again = await turnOn(setup);

    // #then
    expect(again.status).toBe(200);
    expect(await walletRow(setup.company)).toEqual(first);
    expect(privy.state.calls.createWallet).toBe(1);
    expect(privy.state.calls.createTreasuryPolicy).toBe(1);
    expect(treasuryWallets()).toHaveLength(1);
    expect(await auditActions(setup.company)).toHaveLength(1);
    expect(email.state.sent).toEqual([]);
  });

  it("resumes after a crash part-way without repeating what was saved", async () => {
    // #given the wallet can't be created the first time
    const setup = await setUp();
    privy.state.failNext("createWallet");

    // #when
    const failed = await turnOn(setup);
    const half = await walletRow(setup.company);
    const resumed = await turnOn(setup);

    // #then
    expect(failed.status).toBe(500);
    expect(half.treasuryPrivyPolicyId).not.toBeNull();
    expect(half.treasuryPrivyWalletId).toBeNull();
    expect(half.treasuryTurnedOnAt).toBeNull();
    expect(resumed.status).toBe(200);
    expect(privy.state.calls.createTreasuryPolicy).toBe(1);
    expect(treasuryWallets()).toHaveLength(1);
    expect((await walletRow(setup.company)).treasuryTurnedOnAt).not.toBeNull();
  });

  it("finds a wallet an earlier attempt made but never saved", async () => {
    // #given the wallet exists in Privy, its ID lost
    const setup = await setUp();
    await turnOn(setup);
    const created = await walletRow(setup.company);
    await runInScope(
      db,
      { organizationId: setup.company.organizationId },
      (tx) =>
        tx
          .update(wallets)
          .set({
            treasuryPrivyWalletId: null,
            treasuryAddress: null,
            treasuryTurnedOnAt: null,
            treasuryTurnedOnBy: null,
          })
          .where(eq(wallets.id, setup.walletId)),
    );

    // #when
    const resumed = await turnOn(setup);

    // #then
    expect(resumed.status).toBe(200);
    expect(privy.state.calls.createWallet).toBe(1);
    expect((await walletRow(setup.company)).treasuryAddress).toBe(
      created.treasuryAddress,
    );
  });
});

describe("a Treasury wallet that isn't set up as expected", () => {
  const correct = {
    ownerId: TEST_WALLET_SETTINGS.managementQuorumId,
    signerIds: [TEST_WALLET_SETTINGS.runtimeSignerId],
  };

  /** Puts a wallet in Privy under the company's Treasury external ID. */
  async function seedWallet(
    setup: Setup,
    changes: {
      ownerId?: string | null;
      policyIds?: string[];
      signerIds?: string[];
    },
  ) {
    const { policyId } = await runtime.runPromise(
      Effect.flatMap(PrivyWallets, (privyWallets) =>
        privyWallets.createTreasuryPolicy({
          name: "seed",
          vaultId: VAULT_ID,
          perTransactionMaxUsdc: 5_000_000_000n,
          ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
          idempotencyKey: `treasury-policy-${setup.walletId}`,
        }),
      ),
    );
    const externalId = `treasury-${setup.company.organizationId}`;
    const seededId = `seeded-${randomUUID()}`;
    privy.state.seedWallet(
      {
        id: seededId,
        address: randomAddress(),
        policyIds: [policyId],
        ...correct,
        ...changes,
      },
      {
        externalId,
        displayName: externalId,
        policyId,
        ownerQuorumId: TEST_WALLET_SETTINGS.managementQuorumId,
        signerQuorumId: TEST_WALLET_SETTINGS.runtimeSignerId,
        idempotencyKey: "seeded",
      },
    );
    return { id: seededId };
  }

  it("accepts the wallet when owner, policy and signer are right", async () => {
    // #given
    const setup = await setUp();
    const seeded = await seedWallet(setup, {});

    // #when
    const response = await turnOn(setup);

    // #then
    expect(response.status).toBe(200);
    expect((await walletRow(setup.company)).treasuryPrivyWalletId).toBe(
      seeded.id,
    );
    expect(privy.state.calls.createWallet).toBe(0);
  });

  it.each([
    ["the wrong owner", { ownerId: "kq-someone-else" }],
    ["no owner", { ownerId: null }],
    ["another policy", { policyIds: ["policy-other"] }],
    ["an extra policy", { policyIds: ["policy-other", "policy-extra"] }],
    ["no policy", { policyIds: [] }],
    ["the API not a signer", { signerIds: ["kq-someone-else"] }],
  ])(
    "refuses a wallet with %s and marks nothing on",
    async (_name, changes) => {
      // #given
      const setup = await setUp();
      await seedWallet(setup, changes);

      // #when
      const response = await turnOn(setup);

      // #then
      const row = await walletRow(setup.company);
      expect(response.status).toBe(500);
      expect(row.treasuryPrivyWalletId).toBeNull();
      expect(row.treasuryAddress).toBeNull();
      expect(row.treasuryTurnedOnAt).toBeNull();
      expect(await auditActions(setup.company)).toEqual([]);
      expect(email.state.sent).toEqual([]);
    },
  );
});

describe("when Treasury can't be turned on", () => {
  it("refuses while no vault is configured, creating nothing", async () => {
    // #given
    const setup = await setUp();

    // #when
    const started = await start(
      unconfiguredApp,
      setup.company,
      setup.company.admin,
    );
    const direct = await unconfiguredRuntime.runPromise(
      Effect.flip(
        turnOnTreasury({
          organizationId: setup.company.organizationId,
          actor: { type: "user", id: setup.company.admin.id },
        }),
      ),
    );

    // #then
    expect(started.status).toBe(503);
    expect(direct._tag).toBe("ServiceUnavailable");
    expect(privy.state.calls.createTreasuryPolicy).toBe(0);
    expect(privy.state.calls.createWallet).toBe(0);
  });

  it("refuses a company whose wallet is still on Base", async () => {
    // #given
    const company = await createCompany(db);
    await createActiveWallet(db, company);

    // #when
    const response = await start(app, company, company.admin);

    // #then
    expect(response.status).toBe(409);
    expect(privy.state.calls.createWallet).toBe(0);
  });

  it("refuses a company whose wallet isn't active yet, and one with no wallet", async () => {
    // #given
    const creating = await setUp();
    await runInScope(
      db,
      { organizationId: creating.company.organizationId },
      (tx) =>
        tx
          .update(wallets)
          .set({ status: "creating" })
          .where(eq(wallets.id, creating.walletId)),
    );
    const none = await createCompany(db);

    // #when
    const whileCreating = await start(
      app,
      creating.company,
      creating.company.admin,
    );
    const withNone = await start(app, none, none.admin);

    // #then
    expect([whileCreating.status, withNone.status]).toEqual([409, 409]);
  });
});

describe("who may turn Treasury on", () => {
  it("refuses an accountant and an employee at both steps", async () => {
    // #given
    const setup = await setUp();
    const accountant = await createUser(db);
    await addMember(db, setup.company, accountant, { role: "accountant" });
    const employee = await createUser(db);
    await addMember(db, setup.company, employee, { role: "employee" });
    const employeePasskey = await enrol(employee);
    const challenge = approvalChallengeSchema.parse(
      await bodyOf(await start(app, setup.company, setup.company.admin)),
    );
    const signed = (passkey: SoftwarePasskey) => ({
      challengeId: challenge.challengeId,
      response: passkey.sign(challenge.options, TEST_ORIGIN),
    });

    // #when
    const answers = await Promise.all(
      [accountant, employee].flatMap((user) => [
        start(app, setup.company, user),
        sendJson(app, treasuryPath(setup.company), user, {
          method: "POST",
          body: signed(user === employee ? employeePasskey : setup.passkey),
        }),
      ]),
    );

    // #then
    expect(answers.map((answer) => answer.status)).toEqual([
      403, 403, 403, 403,
    ]);
    expect(privy.state.calls.createWallet).toBe(0);
    expect((await walletRow(setup.company)).treasuryTurnedOnAt).toBeNull();
  });

  it("refuses a confirmation signed for another purpose or company", async () => {
    // #given
    const setup = await setUp();
    const other = await setUp();
    const challenge = approvalChallengeSchema.parse(
      await bodyOf(await start(app, other.company, other.company.admin)),
    );

    // #when the other company's admin's challenge is used on this company
    const response = await sendJson(
      app,
      treasuryPath(setup.company),
      setup.company.admin,
      {
        method: "POST",
        body: {
          challengeId: challenge.challengeId,
          response: setup.passkey.sign(challenge.options, TEST_ORIGIN),
        },
      },
    );

    // #then
    expect(response.status).toBe(403);
    expect((await walletRow(setup.company)).treasuryTurnedOnAt).toBeNull();
  });
});
