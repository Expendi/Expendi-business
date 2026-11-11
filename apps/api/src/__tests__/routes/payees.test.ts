import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  CreatePayeeRequest,
  CreatePayeeResponse,
  Payee,
  PayeeChangeChallenge,
  PayeeDetailsInput,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  memberships,
  payees,
  payrollRuns,
  users,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  confirmAllowlistChange,
  requestAllowlistChange,
} from "../../services/allowlist/allowlist.js";
import { insertBill } from "../helpers/bills.js";
import { addCategory } from "../helpers/claims.js";
import { addMember, createUser } from "../helpers/db.js";
import {
  makeFakeEmailSender,
  randomAddress,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { ageDetailsChange } from "../helpers/payees.js";
import { allowlistAddress, createPayingCompany } from "../helpers/payouts.js";
import { bearer, makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const email = makeFakeEmailSender();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let paying: PayingCompany;

beforeAll(async () => {
  runtime = makeTestRuntime({ emailSender: email.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(async () => {
  paying = await createPayingCompany(runtime, db);
  email.state.reset();
});

const base = () => `/organizations/${paying.company.organizationId}/payees`;

async function send(
  method: string,
  path: string,
  body?: unknown,
  privyUserId = paying.company.admin.privyUserId,
): Promise<Response> {
  return app.request(path, {
    method,
    headers: { "content-type": "application/json", ...bearer(privyUserId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function dataOf<T>(response: Response): Promise<T> {
  const body = (await response.json()) as { data: T };
  return body.data;
}

async function requestCreate(
  payee: CreatePayeeRequest,
): Promise<PayeeChangeChallenge> {
  return dataOf<PayeeChangeChallenge>(await send("POST", base(), payee));
}

function confirm(
  challenge: PayeeChangeChallenge,
  change: unknown = challenge.change,
  key: SoftwarePasskey = paying.passkey,
) {
  return send("POST", `${base()}/changes/${challenge.challengeId}/confirm`, {
    change,
    response: key.sign(challenge.options, TEST_ORIGIN),
  });
}

/** Adds the payee, confirming with the passkey when the API asks for it. */
async function create(payee: CreatePayeeRequest): Promise<Payee> {
  const result = await dataOf<CreatePayeeResponse>(
    await send("POST", base(), payee),
  );
  return result.status === "created"
    ? result.payee
    : dataOf<Payee>(await confirm(result));
}

async function listed(query = ""): Promise<string[]> {
  const rows = await dataOf<Payee[]>(await send("GET", `${base()}${query}`));
  return rows.map((row) => row.name);
}

async function payeeAudit(action: string) {
  const { rows } = await owner.query<{
    actor_id: string;
    before: unknown;
    after: unknown;
  }>(
    "SELECT actor_id, before, after FROM audit_log WHERE organization_id = $1 AND action = $2 ORDER BY occurred_at",
    [paying.company.organizationId, action],
  );
  return rows;
}

const till = (
  tillNumber = "123456",
): Extract<PayeeDetailsInput, { method: "mpesa_till" }> => ({
  method: "mpesa_till",
  tillNumber,
  accountName: "Mama Mboga Stores",
});

const bank: Extract<PayeeDetailsInput, { method: "bank" }> = {
  method: "bank",
  bankCode: "EQBLKENA",
  accountNumber: "0123456789",
  accountName: "Acme Supplies Ltd",
};

async function addEmployee(role: "employee" | "admin" = "employee") {
  const user = await createUser(db);
  const membershipId = await addMember(db, paying.company, user, { role });
  return { user, membershipId };
}

describe("adding a payee", () => {
  it("adds a payee without payment details at once, and audits it", async () => {
    // #when
    const response = await send("POST", base(), {
      kind: "supplier",
      name: "Acme Supplies",
    });

    // #then
    const audit = await payeeAudit("payee.created");
    expect({
      status: response.status,
      data: await dataOf<{ status: string; payee: Payee }>(response),
      audited: audit.map((row) => row.after),
      emails: email.state.sent.length,
    }).toMatchObject({
      status: 200,
      data: {
        status: "created",
        payee: { name: "Acme Supplies", details: null, detailsChangedAt: null },
      },
      audited: [{ kind: "supplier", name: "Acme Supplies", details: null }],
      emails: 0,
    });
  });

  it("adds a payee paid outside Expendi without a passkey", async () => {
    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Figma",
      details: { method: "outside" },
    });

    // #then
    expect(
      await dataOf<{ status: string; payee: Payee }>(response),
    ).toMatchObject({
      status: "created",
      payee: { details: { method: "outside" }, detailsChangedAt: null },
    });
  });

  it("asks for the passkey before saving payment details, and saves nothing until then", async () => {
    // #when
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till(),
    });

    // #then
    expect({
      status: challenge.status,
      hasChallenge: typeof challenge.options.challenge,
      listed: await listed(),
    }).toEqual({
      status: "confirmation_required",
      hasChallenge: "string",
      listed: [],
    });
  });

  it("saves the details once the passkey confirms them, and starts the 24-hour hold", async () => {
    // #given
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till(),
    });

    // #when
    const response = await confirm(challenge);

    // #then
    const payee = await dataOf<Payee>(response);
    const changedAt = Date.parse(payee.detailsChangedAt ?? "");
    expect({
      status: response.status,
      details: payee.details,
      holdHours:
        (Date.parse(payee.secondConfirmationUntil ?? "") - changedAt) /
        3_600_000,
      changedRecently: Date.now() - changedAt < 60_000,
    }).toEqual({
      status: 200,
      details: {
        method: "mpesa_till",
        tillNumber: "123456",
        accountName: "Mama Mboga Stores",
      },
      holdHours: 24,
      changedRecently: true,
    });
  });

  it("refuses a confirmation for different details than the ones confirmed", async () => {
    // #given
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till("123456"),
    });

    // #when the signature is presented with another Till
    const response = await confirm(challenge, {
      action: "create",
      payee: { kind: "supplier", name: "Mama Mboga", details: till("654321") },
    });

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 403,
      listed: [],
    });
  });

  it("refuses a signature from another passkey", async () => {
    // #given
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till(),
    });

    // #when
    const response = await confirm(
      challenge,
      challenge.change,
      SoftwarePasskey.create(),
    );

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 403,
      listed: [],
    });
  });

  it("refuses a passkey confirmation given for an allowlist change", async () => {
    // #given
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till(),
    });
    const allowlistChallenge = await runtime.runPromise(
      requestAllowlistChange({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        change: {
          action: "add",
          chain: "base",
          address: randomAddress(),
          label: "Ops",
        },
      }),
    );

    // #when
    const response = await send(
      "POST",
      `${base()}/changes/${allowlistChallenge.challengeId}/confirm`,
      {
        change: challenge.change,
        response: paying.passkey.sign(allowlistChallenge.options, TEST_ORIGIN),
      },
    );

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 403,
      listed: [],
    });
  });

  it("refuses to use a confirmation twice", async () => {
    // #given
    const challenge = await requestCreate({
      kind: "supplier",
      name: "Mama Mboga",
      details: till(),
    });
    await confirm(challenge);

    // #when
    const replay = await confirm(challenge);

    // #then
    expect({ status: replay.status, listed: await listed() }).toEqual({
      status: 403,
      listed: ["Mama Mboga"],
    });
  });

  it("audits the new payee with its account number masked", async () => {
    // #when
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });

    // #then
    const audit = await payeeAudit("payee.created");
    expect({
      after: audit.map((row) => row.after),
      leaks: JSON.stringify(audit).includes("0123456789"),
    }).toMatchObject({
      after: [
        {
          name: "Acme",
          details: {
            method: "bank",
            bankCode: "EQBLKENA",
            accountNumber: "****6789",
            accountName: "Acme Supplies Ltd",
          },
          approvalId: expect.any(String) as string,
        },
      ],
      leaks: false,
    });
    expect(payee.details).toEqual({ ...bank });
  });

  it("emails every active admin, with the account number masked", async () => {
    // #given another active admin, an invited admin and an employee
    const { user: secondAdmin } = await addEmployee("admin");
    const invited = await createUser(db);
    await addMember(db, paying.company, invited, {
      role: "admin",
      status: "invited",
    });
    await addEmployee("employee");

    // #when
    await create({ kind: "supplier", name: "Acme", details: bank });

    // #then
    const sent = email.state.sent;
    expect({
      to: sent.map((message) => message.to).sort(),
      mentionsEnding: sent.every((message) =>
        message.text.includes("ending 6789"),
      ),
      leaks: sent.some((message) =>
        JSON.stringify(message).includes("0123456789"),
      ),
    }).toEqual({
      to: [paying.company.admin.email, secondAdmin.email].sort(),
      mentionsEnding: true,
      leaks: false,
    });
  });

  it("keeps the payee when the email fails", async () => {
    // #given
    email.state.failNext(5);

    // #when
    const response = await confirm(
      await requestCreate({ kind: "supplier", name: "Acme", details: bank }),
    );

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 200,
      listed: ["Acme"],
    });
  });
});

describe("validation", () => {
  it("normalises an M-Pesa number to E.164 before it's confirmed", async () => {
    // #when
    const challenge = await requestCreate({
      kind: "personnel",
      name: "Otieno",
      details: {
        method: "mpesa_phone",
        phone: "0712 345 678",
        accountName: "Otieno Ouma",
      },
    });

    // #then
    expect(challenge.change).toMatchObject({
      payee: { details: { phone: "+254712345678" } },
    });
  });

  it.each<[string, PayeeDetailsInput]>([
    [
      "a number that isn't Kenyan",
      { method: "mpesa_phone", phone: "+255712345678", accountName: "Juma" },
    ],
    ["a Till that isn't numeric", { ...till(), tillNumber: "12a456" }],
    [
      "a Paybill that isn't numeric",
      {
        method: "mpesa_paybill",
        paybillNumber: "KPLC",
        accountReference: "123",
        accountName: "Kenya Power",
      },
    ],
    ["a bank Paycrest can't pay", { ...bank, bankCode: "NOTABANK" }],
    ["a missing account name", { ...bank, accountName: " " }],
    [
      "a Base address with a bad checksum",
      {
        method: "usdc",
        chain: "base",
        address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAEd",
      },
    ],
  ])("rejects %s", async (_case, details) => {
    // #when
    const response = await send("POST", base(), {
      kind: "supplier",
      name: "Someone",
      details,
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("lists the banks Paycrest can pay, without mobile money", async () => {
    // #when
    const banks = await dataOf<{ code: string }[]>(
      await send("GET", `${base()}/banks`),
    );

    // #then
    expect(banks.map((bankRow) => bankRow.code)).toEqual([
      "KCBLKENX",
      "EQBLKENA",
    ]);
  });
});

const SOLANA_ADDRESS = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
/**
 * Valid on two chains at once: lowercase base58 that decodes to 32 bytes is
 * a Solana address, and also a NEAR named account.
 */
const SOLANA_AND_NEAR = "kar457p4ye36ts5g6t48f4r4f39jsa8kc7dp754extm";
/** Another valid Solana address: the same letters, some in another case. */
const SOLANA_OTHER_CASE = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1V";

describe("USDC payees", () => {
  it("refuses an address that isn't on the allowlist, and says how to add it", async () => {
    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", chain: "base", address: randomAddress() },
    });

    // #then
    const body = (await response.json()) as { error: { message: string } };
    expect({
      status: response.status,
      pointsToAllowlist: body.error.message.includes("allowlist"),
    }).toEqual({ status: 409, pointsToAllowlist: true });
  });

  it("accepts an allowlisted address given checksummed, and stores it lowercased", async () => {
    // #given
    const checksummed = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
    await allowlistAddress(runtime, paying, checksummed.toLowerCase());

    // #when
    const payee = await create({
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", chain: "base", address: checksummed },
    });

    // #then
    expect(payee.details).toEqual({
      method: "usdc",
      chain: "base",
      address: checksummed.toLowerCase(),
    });
  });

  it.each([
    ["a NEAR account", "near", "treasury.acme.near"],
    ["a Solana address", "solana", SOLANA_ADDRESS],
  ] as const)(
    "pays %s on its own chain, exactly as allowlisted",
    async (_name, chain, address) => {
      // #given
      await allowlistAddress(runtime, paying, address, "Treasury", chain);

      // #when
      const payee = await create({
        kind: "vendor",
        name: "Cloud host",
        details: { method: "usdc", chain, address },
      });

      // #then
      expect(payee.details).toEqual({ method: "usdc", chain, address });
      const [row] = await runInScope(
        db,
        { organizationId: paying.company.organizationId },
        (tx) =>
          tx
            .select({ chain: payees.usdcChain, address: payees.usdcAddress })
            .from(payees)
            .where(eq(payees.id, payee.id)),
      );
      expect(row).toEqual({ chain, address });
    },
  );

  it("refuses an address that is allowlisted on another chain only", async () => {
    // #given an address that is valid on Solana and on NEAR
    const address = SOLANA_AND_NEAR;
    await allowlistAddress(runtime, paying, address, "Treasury", "solana");

    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", chain: "near", address },
    });

    // #then
    expect(response.status).toBe(409);
  });

  it("refuses a Solana address allowlisted in another case", async () => {
    // #given
    await allowlistAddress(runtime, paying, SOLANA_ADDRESS, "Ops", "solana");

    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Cloud host",
      details: {
        method: "usdc",
        chain: "solana",
        address: SOLANA_OTHER_CASE,
      },
    });

    // #then
    expect(response.status).toBe(409);
  });

  it.each([
    [
      "a NEAR account with a capital letter",
      "near",
      "Acme.near",
      "NEAR account",
    ],
    [
      "a Solana address in lowercase",
      "solana",
      SOLANA_ADDRESS.toLowerCase(),
      "Solana address",
    ],
    ["a NEAR account as a Base address", "base", "acme.near", "Base address"],
  ])("says what is wrong with %s", async (_name, chain, address, named) => {
    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", chain, address },
    });

    // #then
    const body = (await response.json()) as { error: { message: string } };
    expect(response.status).toBe(400);
    expect(body.error.message).toContain(named);
  });

  it("refuses a USDC payee without a payee chain", async () => {
    // #when
    const response = await send("POST", base(), {
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", address: randomAddress() },
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses the confirmation if the address left the allowlist meanwhile", async () => {
    // #given
    const address = randomAddress();
    const addressId = await allowlistAddress(runtime, paying, address);
    const challenge = await requestCreate({
      kind: "vendor",
      name: "Cloud host",
      details: { method: "usdc", chain: "base", address },
    });
    const removal = { action: "remove", addressId } as const;
    const removeChallenge = await runtime.runPromise(
      requestAllowlistChange({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        change: removal,
      }),
    );
    await runtime.runPromise(
      confirmAllowlistChange({
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        challengeId: removeChallenge.challengeId,
        response: paying.passkey.sign(removeChallenge.options, TEST_ORIGIN),
        change: removal,
      }),
    );

    // #when
    const response = await confirm(challenge);

    // #then
    expect({ status: response.status, listed: await listed() }).toEqual({
      status: 409,
      listed: [],
    });
  });
});

describe("employee payees", () => {
  it("links the payee to the person and stores no number for them", async () => {
    // #given
    const { membershipId } = await addEmployee();

    // #when
    const payee = await create({
      kind: "employee",
      name: "Wanjiru",
      membershipId,
      details: { method: "mpesa_phone", accountName: "Wanjiru Kamau" },
    });

    // #then
    const [row] = await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .select({ phone: payees.phone })
          .from(payees)
          .where(eq(payees.id, payee.id)),
    );
    expect({
      membershipId: payee.membershipId,
      details: payee.details,
      payoutPhoneConfirmed: payee.payoutPhoneConfirmed,
      storedPhone: row?.phone,
    }).toEqual({
      membershipId,
      details: { method: "mpesa_phone", accountName: "Wanjiru Kamau" },
      payoutPhoneConfirmed: false,
      storedPhone: null,
    });
  });

  it("lets an admin give an employee a bank account", async () => {
    // #given
    const { membershipId } = await addEmployee();

    // #when
    const payee = await create({
      kind: "employee",
      name: "Wanjiru",
      membershipId,
      details: bank,
    });

    // #then
    expect(payee.details).toMatchObject({ method: "bank" });
  });

  it.each<[string, PayeeDetailsInput]>([
    [
      "a number other than their confirmed one",
      { method: "mpesa_phone", phone: "0712345678", accountName: "Wanjiru" },
    ],
    ["a Till", till()],
  ])("refuses paying an employee to %s", async (_case, details) => {
    // #given
    const { membershipId } = await addEmployee();

    // #when
    const response = await send("POST", base(), {
      kind: "employee",
      name: "Wanjiru",
      membershipId,
      details,
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses someone from another company", async () => {
    // #given
    const other = await createPayingCompany(runtime, db);
    const user = await createUser(db);
    const membershipId = await addMember(db, other.company, user);

    // #when
    const response = await send("POST", base(), {
      kind: "employee",
      name: "Stranger",
      membershipId,
    });

    // #then
    expect(response.status).toBe(404);
  });

  it("refuses an accountant, who isn't paid as an employee", async () => {
    // #given
    const accountant = await addMember(
      db,
      paying.company,
      await createUser(db),
      { role: "accountant" },
    );

    // #when
    const response = await send("POST", base(), {
      kind: "employee",
      name: "Grace",
      membershipId: accountant,
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses a second payee for the same person", async () => {
    // #given
    const { membershipId } = await addEmployee();
    await send("POST", base(), { kind: "employee", name: "A", membershipId });

    // #when
    const response = await send("POST", base(), {
      kind: "employee",
      name: "B",
      membershipId,
    });

    // #then
    expect(response.status).toBe(409);
  });

  it("shows whether the employee has confirmed a number, never the number", async () => {
    // #given
    const { user, membershipId } = await addEmployee();
    await db
      .update(users)
      .set({ phone: "+254733000111", phoneVerifiedAt: new Date() })
      .where(eq(users.id, user.id));

    // #when
    const response = await send("POST", base(), {
      kind: "employee",
      name: "Wanjiru",
      membershipId,
    });

    // #then
    const body = await response.text();
    expect({
      confirmed: (JSON.parse(body) as { data: { payee: Payee } }).data.payee
        .payoutPhoneConfirmed,
      leaks: body.includes("733000111"),
    }).toEqual({ confirmed: true, leaks: false });
  });
});

describe("changing payment details", () => {
  async function requestDetails(payeeId: string, details: PayeeDetailsInput) {
    const response = await send("POST", `${base()}/${payeeId}/details`, {
      details,
    });
    return {
      response,
      challenge: await dataOf<PayeeChangeChallenge>(response),
    };
  }

  async function detailsOf(payeeId: string) {
    return (await dataOf<Payee>(await send("GET", `${base()}/${payeeId}`)))
      .details;
  }

  it("needs the passkey: the old details stay until it confirms", async () => {
    // #given
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });

    // #when
    const { response, challenge } = await requestDetails(payee.id, {
      ...bank,
      accountNumber: "9999888877",
    });

    // #then
    expect({
      status: response.status,
      challenge: challenge.status,
      details: await detailsOf(payee.id),
    }).toEqual({
      status: 200,
      challenge: "confirmation_required",
      details: bank,
    });
  });

  it("changes them once confirmed and restarts the 24-hour hold", async () => {
    // #given details set two days ago
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });
    await ageDetailsChange(db, paying.company, payee.id, 48);
    const { challenge } = await requestDetails(payee.id, {
      ...bank,
      accountNumber: "9999888877",
    });

    // #when
    const changed = await dataOf<Payee>(await confirm(challenge));

    // #then
    expect({
      accountNumber:
        changed.details?.method === "bank" && changed.details.accountNumber,
      changedRecently:
        Date.now() - Date.parse(changed.detailsChangedAt ?? "") < 60_000,
      onHold: changed.secondConfirmationUntil !== null,
    }).toEqual({
      accountNumber: "9999888877",
      changedRecently: true,
      onHold: true,
    });
  });

  it("audits the change before and after, masked, and emails every admin", async () => {
    // #given
    const { user: secondAdmin } = await addEmployee("admin");
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });
    email.state.reset();
    const { challenge } = await requestDetails(payee.id, {
      method: "mpesa_paybill",
      paybillNumber: "888880",
      accountReference: "ACC-55554444",
      accountName: "Acme Supplies Ltd",
    });

    // #when
    await confirm(challenge);

    // #then
    const audit = await payeeAudit("payee.details_changed");
    expect({
      audit: audit.map(({ before, after }) => ({ before, after })),
      leaks: /0123456789|55554444/.test(JSON.stringify(audit)),
      emailed: email.state.sent.map((message) => message.to).sort(),
      subjects: [
        ...new Set(email.state.sent.map((message) => message.subject)),
      ],
    }).toMatchObject({
      audit: [
        {
          before: { details: { method: "bank", accountNumber: "****6789" } },
          after: {
            details: {
              method: "mpesa_paybill",
              paybillNumber: "888880",
              accountReference: "****4444",
            },
            approvalId: expect.any(String) as string,
          },
        },
      ],
      leaks: false,
      emailed: [paying.company.admin.email, secondAdmin.email].sort(),
      subjects: ["Payment details changed for Acme"],
    });
  });

  it("refuses a confirmation for different details than the ones confirmed", async () => {
    // #given
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });
    const { challenge } = await requestDetails(payee.id, {
      ...bank,
      accountNumber: "9999888877",
    });

    // #when an attacker swaps in their own account
    const response = await confirm(challenge, {
      action: "change_details",
      payeeId: payee.id,
      details: { ...bank, accountNumber: "1111222233" },
    });

    // #then
    expect({
      status: response.status,
      details: await detailsOf(payee.id),
    }).toEqual({ status: 403, details: bank });
  });

  it("refuses the details the payee already has", async () => {
    // #given
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });

    // #when
    const { response } = await requestDetails(payee.id, bank);

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses to change an archived payee", async () => {
    // #given
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });
    await send("POST", `${base()}/${payee.id}/archive`);

    // #when
    const { response } = await requestDetails(payee.id, till());

    // #then
    expect(response.status).toBe(409);
  });
});

describe("edits without a passkey", () => {
  it("renames a payee and changes its kind, audited", async () => {
    // #given
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });

    // #when
    const response = await send("PATCH", `${base()}/${payee.id}`, {
      name: "Acme Ltd",
      kind: "vendor",
    });

    // #then
    const audit = await payeeAudit("payee.updated");
    expect({
      payee: await dataOf<Payee>(response),
      audit: audit.map(({ before, after }) => ({ before, after })),
    }).toMatchObject({
      payee: { name: "Acme Ltd", kind: "vendor", details: bank },
      audit: [
        {
          before: { name: "Acme", kind: "supplier" },
          after: { name: "Acme Ltd", kind: "vendor" },
        },
      ],
    });
  });

  it("keeps an employee payee an employee", async () => {
    // #given
    const { membershipId } = await addEmployee();
    const payee = await create({ kind: "employee", name: "W", membershipId });

    // #when
    const response = await send("PATCH", `${base()}/${payee.id}`, {
      kind: "supplier",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("archives a payee, audited, and leaves it out of the list", async () => {
    // #given
    const payee = await create({ kind: "supplier", name: "Acme" });

    // #when
    const response = await send("POST", `${base()}/${payee.id}/archive`);

    // #then
    expect({
      archived: (await dataOf<Payee>(response)).archived,
      active: await listed(),
      archivedList: await listed("?archived=true"),
      audited: (await payeeAudit("payee.archived")).length,
    }).toEqual({
      archived: true,
      active: [],
      archivedList: ["Acme"],
      audited: 1,
    });
  });

  it("filters the list by kind and method", async () => {
    // #given
    await create({ kind: "supplier", name: "Acme", details: bank });
    await create({
      kind: "vendor",
      name: "Figma",
      details: { method: "outside" },
    });
    await create({ kind: "statutory", name: "KRA" });

    // #when
    const lists = {
      vendors: await listed("?kind=vendor"),
      banks: await listed("?method=bank"),
      all: await listed(),
    };

    // #then
    expect(lists).toEqual({
      vendors: ["Figma"],
      banks: ["Acme"],
      all: ["Acme", "Figma", "KRA"],
    });
  });

  it("rejects an unknown filter value", async () => {
    // #when
    const response = await send("GET", `${base()}?kind=friend`);

    // #then
    expect(response.status).toBe(400);
  });
});

describe("restoring a payee", () => {
  async function archived(payee: CreatePayeeRequest): Promise<Payee> {
    const created = await create(payee);
    await send("POST", `${base()}/${created.id}/archive`);
    return created;
  }

  it("brings an archived payee back with the same details, audited", async () => {
    // #given
    const payee = await archived({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });

    // #when
    const response = await send("POST", `${base()}/${payee.id}/restore`);

    // #then
    const restored = await dataOf<Payee>(response);
    expect({
      status: response.status,
      archived: restored.archived,
      details: restored.details,
      active: await listed(),
      archivedList: await listed("?archived=true"),
      audit: (await payeeAudit("payee.restored")).map(
        ({ actor_id, before, after }) => ({ actor_id, before, after }),
      ),
    }).toEqual({
      status: 200,
      archived: false,
      details: bank,
      active: ["Acme"],
      archivedList: [],
      audit: [
        {
          actor_id: paying.company.admin.id,
          before: { archived: true },
          after: { archived: false },
        },
      ],
    });
  });

  it("changes nothing for a payee that isn't archived", async () => {
    // #given
    const payee = await create({ kind: "supplier", name: "Acme" });

    // #when
    const response = await send("POST", `${base()}/${payee.id}/restore`);

    // #then
    expect({
      status: response.status,
      archived: (await dataOf<Payee>(response)).archived,
      audited: (await payeeAudit("payee.restored")).length,
    }).toEqual({ status: 200, archived: false, audited: 0 });
  });

  it("refuses an employee's payee once they have another one", async () => {
    // #given
    const { membershipId } = await addEmployee();
    const first = await archived({ kind: "employee", name: "W", membershipId });
    await create({ kind: "employee", name: "Wanjiru", membershipId });

    // #when
    const response = await send("POST", `${base()}/${first.id}/restore`);

    // #then
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("already a payee");
  });

  it("refuses an employee's payee once they've left the company", async () => {
    // #given
    const { membershipId } = await addEmployee();
    const payee = await archived({ kind: "employee", name: "W", membershipId });
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(memberships)
          .set({ status: "removed" })
          .where(eq(memberships.id, membershipId)),
    );

    // #when
    const response = await send("POST", `${base()}/${payee.id}/restore`);

    // #then
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("left the company");
  });

  it("refuses an accountant, who reads payees but can't change them", async () => {
    // #given
    const accountant = await createUser(db);
    await addMember(db, paying.company, accountant, { role: "accountant" });
    const payee = await archived({ kind: "supplier", name: "Acme" });

    // #when
    const response = await send(
      "POST",
      `${base()}/${payee.id}/restore`,
      undefined,
      accountant.privyUserId,
    );

    // #then
    expect(response.status).toBe(403);
    expect(await listed("?archived=true")).toEqual(["Acme"]);
  });

  it("answers 404 for a payee that isn't the company's", async () => {
    // #when
    const statuses = await Promise.all(
      [randomUUID(), "not-a-uuid"].map((id) =>
        send("POST", `${base()}/${id}/restore`).then((r) => r.status),
      ),
    );

    // #then
    expect(statuses).toEqual([404, 404]);
  });
});

describe("what the list shows about a payee", () => {
  it("shows an employee payee's person, and whether they're still in the team", async () => {
    // #given
    const stays = await addEmployee();
    await db
      .update(users)
      .set({ fullName: "Wanjiru Kamau" })
      .where(eq(users.id, stays.user.id));
    const leaves = await addEmployee();
    await create({
      kind: "employee",
      name: "Wanjiru",
      membershipId: stays.membershipId,
    });
    await create({
      kind: "employee",
      name: "Otieno",
      membershipId: leaves.membershipId,
    });
    await create({ kind: "supplier", name: "Acme" });
    await runInScope(
      db,
      { organizationId: paying.company.organizationId },
      (tx) =>
        tx
          .update(memberships)
          .set({ status: "removed" })
          .where(eq(memberships.id, leaves.membershipId)),
    );

    // #when
    const rows = await dataOf<Payee[]>(await send("GET", base()));

    // #then
    expect(
      Object.fromEntries(rows.map((row) => [row.name, row.member])),
    ).toEqual({
      Acme: null,
      Otieno: { name: null, email: leaves.user.email, inTeam: false },
      Wanjiru: {
        name: "Wanjiru Kamau",
        email: stays.user.email,
        inTeam: true,
      },
    });
  });

  it("counts each payee's bills, whatever their status, but never salaries", async () => {
    // #given
    const categoryId = await addCategory(db, paying.company, "Rent");
    const supplier = await create({ kind: "supplier", name: "Acme" });
    await create({ kind: "vendor", name: "Figma" });
    const { membershipId } = await addEmployee();
    const employeePayee = await create({
      kind: "employee",
      name: "Wanjiru",
      membershipId,
    });
    await insertBill(db, paying.company, {
      payeeId: supplier.id,
      categoryId,
    });
    await insertBill(db, paying.company, {
      payeeId: supplier.id,
      categoryId,
      status: "cancelled",
      cancelledReason: "Duplicate",
      cancelledBy: paying.company.admin.id,
      cancelledAt: new Date(),
    });
    const [run] = await runInScope(
      db,
      {
        organizationId: paying.company.organizationId,
        userId: paying.company.admin.id,
        role: "admin",
      },
      (tx) =>
        tx
          .insert(payrollRuns)
          .values({
            organizationId: paying.company.organizationId,
            payDate: "2026-11-28",
            totalKes: 6_000_000n,
            salariesKes: 6_000_000n,
            capKes: 7_200_000n,
          })
          .returning({ id: payrollRuns.id }),
    );
    await insertBill(db, paying.company, {
      payeeId: employeePayee.id,
      categoryId,
      payrollRunId: run?.id,
      overviewHeading: "salaries",
    });

    // #when
    const rows = await dataOf<Payee[]>(await send("GET", base()));

    // #then
    expect(
      Object.fromEntries(rows.map((row) => [row.name, row.billCount])),
    ).toEqual({ Acme: 2, Figma: 0, Wanjiru: 0 });
  });
});

describe("access", () => {
  it("refuses employees on every payee route", async () => {
    // #given
    const { user } = await addEmployee();
    const payee = await create({
      kind: "supplier",
      name: "Acme",
      details: bank,
    });
    const calls: [string, string, unknown?][] = [
      ["GET", base()],
      ["GET", `${base()}/banks`],
      ["GET", `${base()}/${payee.id}`],
      ["POST", base(), { kind: "supplier", name: "Mine" }],
      ["PATCH", `${base()}/${payee.id}`, { name: "Mine" }],
      ["POST", `${base()}/${payee.id}/details`, { details: till() }],
      ["POST", `${base()}/${payee.id}/archive`],
      ["POST", `${base()}/${payee.id}/restore`],
      ["POST", `${base()}/changes/${randomUUID()}/confirm`, {}],
    ];

    // #when
    const statuses = await Promise.all(
      calls.map(([method, path, body]) =>
        send(method, path, body, user.privyUserId).then((r) => r.status),
      ),
    );

    // #then
    expect(statuses).toEqual(calls.map(() => 403));
  });

  it("is isolated between companies on every route", async () => {
    const fixture = await createIsolationFixture(db);
    const json = (method: string, body: unknown): RequestInit => ({
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const routes: ((organizationId: string) => {
      path: string;
      init?: RequestInit;
    })[] = [
      (id) => ({ path: `/organizations/${id}/payees` }),
      (id) => ({ path: `/organizations/${id}/payees/banks` }),
      (id) => ({ path: `/organizations/${id}/payees/${randomUUID()}` }),
      (id) => ({
        path: `/organizations/${id}/payees`,
        init: json("POST", { kind: "supplier", name: "Acme" }),
      }),
      (id) => ({
        path: `/organizations/${id}/payees/${randomUUID()}`,
        init: json("PATCH", { name: "Acme" }),
      }),
      (id) => ({
        path: `/organizations/${id}/payees/${randomUUID()}/details`,
        init: json("POST", { details: till() }),
      }),
      (id) => ({
        path: `/organizations/${id}/payees/${randomUUID()}/archive`,
        init: { method: "POST" },
      }),
      (id) => ({
        path: `/organizations/${id}/payees/${randomUUID()}/restore`,
        init: { method: "POST" },
      }),
      (id) => ({
        path: `/organizations/${id}/payees/changes/${randomUUID()}/confirm`,
        init: json("POST", {}),
      }),
    ];
    for (const route of routes) {
      await expectRouteIsolation(app, fixture, route);
    }
  });

  it("keeps each company's payees apart in the database", async () => {
    // #given
    const fixture = await createIsolationFixture(db);
    for (const company of [fixture.companyA, fixture.companyB]) {
      await app.request(`/organizations/${company.organizationId}/payees`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...bearer(company.admin.privyUserId),
        },
        body: JSON.stringify({ kind: "supplier", name: "Acme" }),
      });
    }

    // #then
    await expectTableIsolation(fixture, "payees");
  });
});
