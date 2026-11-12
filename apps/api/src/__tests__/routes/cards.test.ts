import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect, Exit, Layer } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  AssignableRole,
  CardActionRequest,
  CardActionResult,
  ExpendiCard,
  MembershipRole,
} from "@expendi-business/shared";
import {
  cardActionResultSchema,
  cardConfirmationSchema,
  cardListSchema,
  cardLoadListSchema,
  cardProgramSchema,
  expendiCardSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import { SoftwarePasskey } from "../../../scripts/lib/software-passkey.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  cardLoads,
  cardPurchases,
  cards,
  organizations,
  paidFromAccounts,
  payouts,
  users,
  walletTransactions,
} from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  finishPasskeyEnrolment,
  startPasskeyEnrolment,
} from "../../services/approval/passkeys.js";
import { closeRequestedCards } from "../../services/cards/leavers.js";
import { Lithic } from "../../services/lithic/lithic-client.js";
import { changeMemberRole } from "../../services/membership/members.js";
import { approvePayouts } from "../../services/payout/approve.js";
import {
  preparePayouts,
  requestPayoutApproval,
} from "../../services/payout/payout-service.js";
import { addCategory, sendJson } from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  makeFakeLithic,
  makeFakePaycrest,
  makeFakePrivyWallets,
  TEST_ORIGIN,
} from "../helpers/fakes.js";
import {
  claimRequest,
  createPayingCompany,
  payClaims,
} from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const lithic = makeFakeLithic();
const paycrest = makeFakePaycrest();
const privy = makeFakePrivyWallets();

let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let paying: PayingCompany;
let company: TestCompany;
let admin: TestUser;
let adminPasskey: SoftwarePasskey;
let categoryId: string;
let employee: TestUser;
let employeeMembershipId: string;
let employeePasskey: SoftwarePasskey;
let colleague: TestUser;
let accountant: TestUser;
let accountantMembershipId: string;

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

const USD_RATE = "128.68";

beforeAll(async () => {
  runtime = makeTestRuntime({
    lithic: lithic.layer,
    paycrest: paycrest.layer,
    privyWallets: privy.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const cardsPath = (rest = "", target: TestCompany = company) =>
  `/organizations/${target.organizationId}/cards${rest}`;

async function dataOf(response: Response): Promise<unknown> {
  const { data } = (await response.clone().json()) as { data: unknown };
  return data;
}

async function errorOf(
  response: Response,
): Promise<{ _tag: string; message: string }> {
  const { error } = (await response.clone().json()) as {
    error: { _tag: string; message: string };
  };
  return error;
}

function turnOn(
  user: Pick<TestUser, "privyUserId"> = admin,
  target: TestCompany = company,
) {
  return sendJson(app, cardsPath("/program", target), user, {
    method: "POST",
    body: PROGRAM,
  });
}

async function enrol(user: TestUser): Promise<SoftwarePasskey> {
  const passkey = SoftwarePasskey.create();
  const options = await runtime.runPromise(startPasskeyEnrolment(user.id));
  await runtime.runPromise(
    finishPasskeyEnrolment(user.id, passkey.register(options, TEST_ORIGIN)),
  );
  return passkey;
}

/** One passkey signs one request at a time: its counter must only rise. */
async function anotherAdmin(): Promise<{
  readonly user: TestUser;
  readonly passkey: SoftwarePasskey;
}> {
  const user = await createUser(db);
  await addMember(db, company, user, { role: "admin" });
  return { user, passkey: await enrol(user) };
}

function startConfirmation(
  user: Pick<TestUser, "privyUserId">,
  action: CardActionRequest,
) {
  return sendJson(app, cardsPath("/confirmations"), user, {
    method: "POST",
    body: action,
  });
}

interface Started {
  readonly challengeId: string;
  readonly options: ReturnType<typeof cardConfirmationSchema.parse>["options"];
}

async function started(response: Response): Promise<Started> {
  expect(response.status).toBe(201);
  return cardConfirmationSchema.parse(await dataOf(response));
}

function finishConfirmation(
  user: Pick<TestUser, "privyUserId">,
  passkey: SoftwarePasskey,
  challenge: Started,
  action: CardActionRequest,
) {
  return sendJson(
    app,
    cardsPath(`/confirmations/${challenge.challengeId}`),
    user,
    {
      method: "POST",
      body: {
        action,
        response: passkey.sign(challenge.options, TEST_ORIGIN),
      },
    },
  );
}

async function confirm(
  user: Pick<TestUser, "privyUserId">,
  passkey: SoftwarePasskey,
  action: CardActionRequest,
): Promise<Response> {
  const challenge = await started(await startConfirmation(user, action));
  return finishConfirmation(user, passkey, challenge, action);
}

async function resultOf(response: Response): Promise<CardActionResult> {
  expect(response.status, await response.clone().text()).toBe(200);
  return cardActionResultSchema.parse(await dataOf(response));
}

const issueAction = (
  overrides: Partial<Extract<CardActionRequest, { type: "issue_card" }>> = {},
): CardActionRequest => ({
  type: "issue_card",
  membershipId: employeeMembershipId,
  nickname: "Marketing subscriptions",
  monthlyLimitUsd: "500",
  defaultCategoryId: categoryId,
  ...overrides,
});

async function issue(
  action: CardActionRequest = issueAction(),
): Promise<ExpendiCard> {
  const result = await resultOf(await confirm(admin, adminPasskey, action));
  if (result.type !== "issue_card") throw new Error("not issue_card");
  return result.card;
}

const loadAction = (amountUsd = "100"): CardActionRequest => ({
  type: "load_balance",
  amountUsd,
});

const cardRow = async (cardId: string) => {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) => tx.select().from(cards).where(eq(cards.id, cardId)),
  );
  if (!row) throw new Error("card row not found");
  return row;
};

const auditOf = async (entityId: string) => {
  const { rows } = await owner.query<{
    action: string;
    actor_type: string;
    after: unknown;
  }>(
    `SELECT action, actor_type, after FROM audit_log WHERE entity_id = $1 ORDER BY occurred_at, id`,
    [entityId],
  );
  return rows;
};

const outboxKinds = async (target: TestCompany = company) => {
  const { rows } = await owner.query<{ kind: string }>(
    `SELECT kind FROM notification_outbox WHERE organization_id = $1`,
    [target.organizationId],
  );
  return rows.map((row) => row.kind);
};

const setCompany = (changes: Partial<typeof organizations.$inferInsert>) =>
  runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(organizations)
      .set(changes)
      .where(eq(organizations.id, company.organizationId)),
  );

const pauseCompany = () => setCompany({ payoutsPaused: true });

beforeEach(async () => {
  lithic.state.reset();
  paycrest.state.reset();
  privy.state.reset();
  paycrest.state.rateFor = () => USD_RATE;

  paying = await createPayingCompany(runtime, db);
  ({ company, passkey: adminPasskey } = paying);
  ({ admin } = company);
  categoryId = await addCategory(db, company, "Software");

  employee = await createUser(db);
  employeeMembershipId = await addMember(db, company, employee);
  employeePasskey = await enrol(employee);
  colleague = await createUser(db);
  await addMember(db, company, colleague);
  accountant = await createUser(db);
  accountantMembershipId = await addMember(db, company, accountant, {
    role: "accountant",
  });

  await db
    .update(users)
    .set({ fullName: "Jane Wanjiku Mwangi" })
    .where(eq(users.id, employee.id));

  expect((await turnOn()).status).toBe(201);
});

describe("turning on cards", () => {
  it("answers off for a company that hasn't, to any member", async () => {
    // #given
    const other = await createCompany(db);
    const member = await createUser(db);
    await addMember(db, other, member);

    // #when
    const response = await sendJson(app, cardsPath("/program", other), member);

    // #then
    expect(cardProgramSchema.parse(await dataOf(response))).toEqual({
      status: "off",
    });
  });

  it("creates the business, the paid-from account and the program, once", async () => {
    // #when
    const again = await turnOn();
    const read = await sendJson(app, cardsPath("/program"), employee);

    // #then
    expect(again.status).toBe(409);
    expect(lithic.state.businesses).toHaveLength(1);
    expect(lithic.state.businesses[0]).toMatchObject({
      externalId: `org:${company.organizationId}`,
      legalName: PROGRAM.legalName,
    });
    expect(cardProgramSchema.parse(await dataOf(read))).toMatchObject({
      status: "on",
      legalName: PROGRAM.legalName,
      lowBalance: true,
      paused: false,
    });
    const accounts = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ name: paidFromAccounts.name, kind: paidFromAccounts.kind })
          .from(paidFromAccounts),
    );
    expect(accounts).toEqual([{ name: "Expendi cards", kind: "card" }]);
  });

  it("reuses the company's existing Expendi cards account", async () => {
    // #given
    const other = await createCompany(db);
    await runInScope(db, { organizationId: other.organizationId }, (tx) =>
      tx.insert(paidFromAccounts).values({
        organizationId: other.organizationId,
        name: "expendi CARDS",
        kind: "card",
      }),
    );

    // #when
    const response = await turnOn(other.admin, other);

    // #then
    expect(response.status).toBe(201);
    const accounts = await runInScope(
      db,
      { organizationId: other.organizationId },
      (tx) => tx.select({ id: paidFromAccounts.id }).from(paidFromAccounts),
    );
    expect(accounts).toHaveLength(1);
  });

  it("recovers an ambiguous create by looking it up, without a second create", async () => {
    // #given
    const other = await createCompany(db);
    lithic.state.nextCreateFailure = "ambiguous";

    // #when
    const response = await turnOn(other.admin, other);

    // #then
    expect(response.status, await response.clone().text()).toBe(201);
    expect(
      lithic.state.businesses.filter(
        (business) => business.externalId === `org:${other.organizationId}`,
      ),
    ).toHaveLength(1);
  });

  it("reuses the business when a retry finds Lithic already has it", async () => {
    // #given a first attempt that created it but never committed
    const other = await createCompany(db);
    lithic.state.holders.set(`org:${other.organizationId}`, {
      token: "holder-orphan",
      accountToken: "account-orphan",
    });
    const before = lithic.state.businesses.length;

    // #when
    const response = await turnOn(other.admin, other);

    // #then
    expect(response.status).toBe(201);
    expect(lithic.state.businesses).toHaveLength(before);
  });

  it("gives plain copy and records nothing when Lithic refuses", async () => {
    // #given
    const other = await createCompany(db);
    lithic.state.nextCreateFailure = "refused";

    // #when
    const response = await turnOn(other.admin, other);

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "We couldn't reach the card issuer. Try again in a minute.",
    );
    expect(
      cardProgramSchema.parse(
        await dataOf(
          await sendJson(app, cardsPath("/program", other), other.admin),
        ),
      ),
    ).toEqual({ status: "off" });
  });

  it("says cards aren't available when Lithic isn't configured", async () => {
    // #given
    const shape = await Effect.runPromise(Effect.provide(Lithic, lithic.layer));
    const unconfigured = makeTestRuntime({
      lithic: Layer.succeed(Lithic, { ...shape, configured: false }),
      paycrest: paycrest.layer,
    });
    const other = await createCompany(db);

    try {
      // #when
      const response = await sendJson(
        createApp({ runtime: unconfigured }),
        cardsPath("/program", other),
        other.admin,
        { method: "POST", body: PROGRAM },
      );

      // #then
      expect(response.status).toBe(503);
      expect((await errorOf(response)).message).toBe(
        "Cards aren't available yet.",
      );
    } finally {
      await unconfigured.dispose();
    }
  });

  it("is for admins", async () => {
    // #given
    const other = await createCompany(db);
    const staff = await createUser(db);
    await addMember(db, other, staff);

    // #when
    const response = await turnOn(staff, other);

    // #then
    expect(response.status).toBe(403);
    expect(lithic.state.businesses).toHaveLength(1);
  });
});

describe("who can do what", () => {
  it("refuses employees everything an admin does", async () => {
    // #given
    const card = await issue();
    const attempts: CardActionRequest[] = [
      issueAction(),
      { type: "raise_limit", cardId: card.id, monthlyLimitUsd: "900" },
      { type: "unfreeze_card", cardId: card.id },
      loadAction(),
    ];

    // #when
    const answers = await Promise.all([
      ...attempts.map((action) => startConfirmation(employee, action)),
      sendJson(app, cardsPath(`/${card.id}/close`), employee, {
        method: "POST",
      }),
      sendJson(app, cardsPath(`/${card.id}/lower-limit`), employee, {
        method: "POST",
        body: { monthlyLimitUsd: "10" },
      }),
      sendJson(app, cardsPath("/loads"), employee),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403, 403, 403,
    ]);
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("shows employees only their own cards", async () => {
    // #given
    const mine = await issue();
    const colleagueMembership = await addMember(
      db,
      company,
      await createUser(db),
    );
    const theirs = await issue(
      issueAction({ membershipId: colleagueMembership, nickname: "Travel" }),
    );

    // #when
    const list = cardListSchema.parse(
      await dataOf(await sendJson(app, cardsPath(), employee)),
    );
    const someoneElses = await sendJson(
      app,
      cardsPath(`/${theirs.id}`),
      employee,
    );
    const own = await sendJson(app, cardsPath(`/${mine.id}`), employee);

    // #then
    expect(list.cards.map((card) => card.id)).toEqual([mine.id]);
    expect(list.cards[0]?.yours).toBe(true);
    expect(someoneElses.status).toBe(404);
    expect(expendiCardSchema.parse(await dataOf(own)).id).toBe(mine.id);
  });

  it("gives admins every card, and their own with mine=true", async () => {
    // #given
    const someone = await issue();
    const selfIssued = await issue(
      issueAction({
        membershipId: company.adminMembershipId,
        nickname: "Mine",
      }),
    );

    // #when
    const all = cardListSchema.parse(
      await dataOf(await sendJson(app, cardsPath(), admin)),
    );
    const mine = cardListSchema.parse(
      await dataOf(await sendJson(app, cardsPath("?mine=true"), admin)),
    );

    // #then
    expect(all.cards.map((card) => card.id).sort()).toEqual(
      [someone.id, selfIssued.id].sort(),
    );
    expect(mine.cards.map((card) => card.id)).toEqual([selfIssued.id]);
  });

  it("filters by state", async () => {
    // #given
    const frozen = await issue();
    const open = await issue(issueAction({ nickname: "Open one" }));
    await sendJson(app, cardsPath(`/${frozen.id}/freeze`), admin, {
      method: "POST",
    });

    // #when
    const list = cardListSchema.parse(
      await dataOf(await sendJson(app, cardsPath("?state=open"), admin)),
    );

    // #then
    expect(list.cards.map((card) => card.id)).toEqual([open.id]);
  });

  it("lets an accountant read and change nothing", async () => {
    // #given
    const card = await issue();

    // #when
    const reads = await Promise.all([
      sendJson(app, cardsPath(), accountant),
      sendJson(app, cardsPath(`/${card.id}`), accountant),
      sendJson(app, cardsPath("/loads"), accountant),
      sendJson(app, cardsPath("/program"), accountant),
    ]);
    const writes = await Promise.all([
      sendJson(app, cardsPath("/confirmations"), accountant, {
        method: "POST",
        body: issueAction(),
      }),
      sendJson(app, cardsPath(`/${card.id}/freeze`), accountant, {
        method: "POST",
      }),
      sendJson(app, cardsPath(`/${card.id}/close`), accountant, {
        method: "POST",
      }),
    ]);

    // #then
    expect(reads.map((response) => response.status)).toEqual([
      200, 200, 200, 200,
    ]);
    expect(writes.map((response) => response.status)).toEqual([403, 403, 403]);
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("keeps another company's cards out of reach", async () => {
    // #given
    const card = await issue();
    const other = await createCompany(db);

    // #when
    const read = await sendJson(
      app,
      cardsPath(`/${card.id}`, other),
      other.admin,
    );
    const crossTenant = await sendJson(
      app,
      cardsPath(`/${card.id}`),
      other.admin,
    );

    // #then
    expect(read.status).toBe(404);
    expect(crossTenant.status).toBe(403);
  });
});

describe("issuing a card", () => {
  it("creates the holder and card at Lithic and records both, once", async () => {
    // #when
    const card = await issue();

    // #then
    expect(card).toMatchObject({
      nickname: "Marketing subscriptions",
      state: "open",
      monthlyLimitUsdCents: "50000",
      spentThisMonthUsdCents: "0",
      yours: false,
      closedAt: null,
      holder: {
        membershipId: employeeMembershipId,
        name: "Jane Wanjiku Mwangi",
      },
      defaultCategory: { id: categoryId, name: "Software" },
    });
    expect(lithic.state.cardholders).toHaveLength(1);
    expect(lithic.state.cardholders[0]).toMatchObject({
      externalId: `member:${employeeMembershipId}`,
      firstName: "Jane",
      lastName: "Wanjiku Mwangi",
      phone: PROGRAM.phone,
      address: {
        addressLine1: PROGRAM.addressLine1,
        city: PROGRAM.city,
        postalCode: PROGRAM.postalCode,
      },
    });
    expect([...lithic.state.cards.values()]).toMatchObject([
      { memo: "Marketing subscriptions", monthlyLimitUsdCents: 50_000n },
    ]);
    expect(await auditOf(card.id)).toMatchObject([
      {
        action: "card.issued",
        after: { selfIssued: false, monthlyLimitUsdCents: "50000" },
      },
    ]);
    expect(await outboxKinds()).toContain("card_issued");
  });

  it("flags an admin issuing their own card", async () => {
    // #when
    const card = await issue(
      issueAction({ membershipId: company.adminMembershipId }),
    );

    // #then
    expect(card.yours).toBe(true);
    expect(await auditOf(card.id)).toMatchObject([
      { action: "card.issued", after: { selfIssued: true } },
    ]);
  });

  it("creates each cardholder once, however many cards they get", async () => {
    // #when
    await issue();
    await issue(issueAction({ nickname: "Second" }));

    // #then
    expect(lithic.state.cardholders).toHaveLength(1);
    expect(lithic.state.cards.size).toBe(2);
  });

  it("recovers an ambiguous cardholder create without a second one", async () => {
    // #given
    lithic.state.nextCreateFailure = "ambiguous";

    // #when
    await issue();

    // #then
    expect(lithic.state.cardholders).toHaveLength(1);
    expect(lithic.state.cards.size).toBe(1);
  });

  it("uses the person's confirmed number, and a name when they have none", async () => {
    // #given
    const phone = `+2547${String(Date.now()).slice(-8)}`;
    await db
      .update(users)
      .set({ fullName: null, phone, phoneVerifiedAt: new Date() })
      .where(eq(users.id, employee.id));

    // #when
    await issue();

    // #then
    expect(lithic.state.cardholders[0]).toMatchObject({
      firstName: "Expendi",
      lastName: "Cardholder",
      phone,
    });
  });

  it("refuses someone who hasn't signed in or who is an accountant", async () => {
    // #given
    const invited = await createUser(db);
    const invitedMembership = await addMember(db, company, invited);
    await db
      .update(users)
      .set({ privyUserId: null })
      .where(eq(users.id, invited.id));

    // #when
    const answers = await Promise.all([
      startConfirmation(
        admin,
        issueAction({ membershipId: invitedMembership }),
      ),
      startConfirmation(
        admin,
        issueAction({ membershipId: accountantMembershipId }),
      ),
      startConfirmation(admin, issueAction({ membershipId: randomUUID() })),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([409, 409, 404]);
    expect(lithic.state.cardholders).toHaveLength(0);
  });

  it("refuses a category that's archived or belongs to no one here", async () => {
    // #given
    const archived = await addCategory(db, company, "Old", { archived: true });

    // #when
    const answers = await Promise.all([
      startConfirmation(admin, issueAction({ defaultCategoryId: archived })),
      startConfirmation(
        admin,
        issueAction({ defaultCategoryId: randomUUID() }),
      ),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([400, 400]);
  });

  it("refuses a confirmation that doesn't match what was signed", async () => {
    // #given
    const signed = issueAction();
    const challenge = await started(await startConfirmation(admin, signed));

    // #when
    const tampered = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      issueAction({ monthlyLimitUsd: "5000" }),
    );

    // #then
    expect(tampered.status).toBe(403);
    expect((await errorOf(tampered)).message).toBe(
      "That isn't what you confirmed. Confirm again.",
    );
    expect(lithic.state.cards.size).toBe(0);

    // #and the challenge is spent: the honest action can't reuse it
    const honest = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      signed,
    );
    expect(honest.status).toBe(403);
    expect(lithic.state.cards.size).toBe(0);
  });

  it("refuses a challenge signed for a different kind of action", async () => {
    // #given
    const card = await issue();
    const challenge = await started(
      await startConfirmation(employee, {
        type: "reveal_card",
        cardId: card.id,
      }),
    );
    const before = lithic.state.cards.size;

    // #when
    const response = await finishConfirmation(
      employee,
      employeePasskey,
      challenge,
      issueAction(),
    );

    // #then
    expect(response.status).toBe(403);
    expect(lithic.state.cards.size).toBe(before);
  });

  it("checks again at confirm: a person removed since is refused", async () => {
    // #given
    const action = issueAction();
    const challenge = await started(await startConfirmation(admin, action));
    await sendJson(
      app,
      `/organizations/${company.organizationId}/members/${employeeMembershipId}`,
      admin,
      { method: "DELETE" },
    );

    // #when
    const response = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      action,
    );

    // #then
    expect(response.status).toBe(409);
    expect(lithic.state.cards.size).toBe(0);
  });

  it("gives plain copy when Lithic can't create the card, and records nothing", async () => {
    // #given
    lithic.state.failCreateCard = true;

    // #when
    const response = await confirm(admin, adminPasskey, issueAction());

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "We couldn't reach the card issuer. Try again in a minute.",
    );
    const list = cardListSchema.parse(
      await dataOf(await sendJson(app, cardsPath(), admin)),
    );
    expect(list.cards).toEqual([]);
  });

  it("is blocked by a pause, before the passkey and after", async () => {
    // #given
    const action = issueAction();
    const challenge = await started(await startConfirmation(admin, action));

    // #when
    await pauseCompany();
    const atConfirm = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      action,
    );
    const atStart = await startConfirmation(admin, action);

    // #then
    expect(atConfirm.status).toBe(409);
    expect(atStart.status).toBe(409);
    expect(lithic.state.cards.size).toBe(0);
    expect(lithic.state.cardholders).toHaveLength(0);
  });

  it("needs cards to be on", async () => {
    // #given
    const other = await createCompany(db);
    const member = await createUser(db);
    const membershipId = await addMember(db, other, member);
    const otherCategory = await addCategory(db, other, "Stuff");

    // #when
    const response = await sendJson(
      app,
      cardsPath("/confirmations", other),
      other.admin,
      {
        method: "POST",
        body: issueAction({ membershipId, defaultCategoryId: otherCategory }),
      },
    );

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toBe(
      "Turn on cards for this company first.",
    );
  });

  it("marks the card for closing when the holder left while it was being made", async () => {
    // #given the issuer's reply, slowed so the removal can land first
    const shape = await Effect.runPromise(Effect.provide(Lithic, lithic.layer));
    const removeHolder = () =>
      sendJson(
        app,
        `/organizations/${company.organizationId}/members/${employeeMembershipId}`,
        admin,
        { method: "DELETE" },
      );
    const racing = makeTestRuntime({
      lithic: Layer.succeed(Lithic, {
        ...shape,
        createCard: (input) =>
          Effect.promise(removeHolder).pipe(
            Effect.zipRight(shape.createCard(input)),
          ),
      }),
      paycrest: paycrest.layer,
    });
    const racingApp = createApp({ runtime: racing });

    try {
      const action = issueAction();
      const challenge = await started(
        await sendJson(racingApp, cardsPath("/confirmations"), admin, {
          method: "POST",
          body: action,
        }),
      );

      // #when
      const response = await sendJson(
        racingApp,
        cardsPath(`/confirmations/${challenge.challengeId}`),
        admin,
        {
          method: "POST",
          body: {
            action,
            response: adminPasskey.sign(challenge.options, TEST_ORIGIN),
          },
        },
      );

      // #then
      const result = await resultOf(response);
      if (result.type !== "issue_card") throw new Error("not issue_card");
      const row = await cardRow(result.card.id);
      expect(row.closeRequestedAt).not.toBeNull();
      expect(await outboxKinds()).not.toContain("card_issued");
    } finally {
      await racing.dispose();
    }
  });
});

describe("freezing, limits and closing", () => {
  it("lets a holder freeze their own card, without a passkey", async () => {
    // #given
    const card = await issue();

    // #when
    const response = await sendJson(
      app,
      cardsPath(`/${card.id}/freeze`),
      employee,
      { method: "POST" },
    );

    // #then
    expect(expendiCardSchema.parse(await dataOf(response)).state).toBe(
      "frozen",
    );
    expect(lithic.state.updates.at(-1)?.patch).toEqual({ state: "PAUSED" });
    expect(await auditOf(card.id)).toMatchObject([
      { action: "card.issued" },
      { action: "card.frozen" },
    ]);
  });

  it("lets an admin freeze anyone's card, and freezing twice changes nothing", async () => {
    // #given
    const card = await issue();
    await sendJson(app, cardsPath(`/${card.id}/freeze`), admin, {
      method: "POST",
    });
    const updatesBefore = lithic.state.updates.length;

    // #when
    const again = await sendJson(app, cardsPath(`/${card.id}/freeze`), admin, {
      method: "POST",
    });

    // #then
    expect(again.status).toBe(200);
    expect(lithic.state.updates).toHaveLength(updatesBefore);
  });

  it("refuses to freeze someone else's card to an employee", async () => {
    // #given
    const card = await issue();

    // #when
    const response = await sendJson(
      app,
      cardsPath(`/${card.id}/freeze`),
      colleague,
      { method: "POST" },
    );

    // #then
    expect(response.status).toBe(404);
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("unfreezes only with an admin's passkey", async () => {
    // #given
    const card = await issue();
    await sendJson(app, cardsPath(`/${card.id}/freeze`), employee, {
      method: "POST",
    });
    const action: CardActionRequest = {
      type: "unfreeze_card",
      cardId: card.id,
    };

    // #when
    const byHolder = await startConfirmation(employee, action);
    const result = await resultOf(await confirm(admin, adminPasskey, action));

    // #then
    expect(byHolder.status).toBe(403);
    expect(result).toMatchObject({
      type: "unfreeze_card",
      card: { state: "open" },
    });
    expect(lithic.state.updates.at(-1)?.patch).toEqual({ state: "OPEN" });
  });

  it("won't unfreeze a card that isn't frozen", async () => {
    // #given
    const card = await issue();

    // #when
    const response = await startConfirmation(admin, {
      type: "unfreeze_card",
      cardId: card.id,
    });

    // #then
    expect(response.status).toBe(409);
  });

  it("lowers a limit without a passkey, but can't raise one that way", async () => {
    // #given
    const card = await issue();

    // #when
    const lowered = await sendJson(
      app,
      cardsPath(`/${card.id}/lower-limit`),
      admin,
      { method: "POST", body: { monthlyLimitUsd: "200" } },
    );
    const updates = lithic.state.updates.length;
    const raised = await sendJson(
      app,
      cardsPath(`/${card.id}/lower-limit`),
      admin,
      { method: "POST", body: { monthlyLimitUsd: "900" } },
    );
    const same = await sendJson(
      app,
      cardsPath(`/${card.id}/lower-limit`),
      admin,
      { method: "POST", body: { monthlyLimitUsd: "200" } },
    );

    // #then
    expect(expendiCardSchema.parse(await dataOf(lowered))).toMatchObject({
      monthlyLimitUsdCents: "20000",
    });
    expect(raised.status).toBe(400);
    expect((await errorOf(raised)).message).toContain("passkey");
    expect(same.status).toBe(400);
    expect(lithic.state.updates).toHaveLength(updates);
    expect((await cardRow(card.id)).monthlyLimitUsdCents).toBe(20_000n);
  });

  it("raises a limit with the passkey, refusing anything not above it", async () => {
    // #given
    const card = await issue();

    // #when
    const result = await resultOf(
      await confirm(admin, adminPasskey, {
        type: "raise_limit",
        cardId: card.id,
        monthlyLimitUsd: "900",
      }),
    );
    const below = await startConfirmation(admin, {
      type: "raise_limit",
      cardId: card.id,
      monthlyLimitUsd: "100",
    });

    // #then
    expect(result).toMatchObject({
      type: "raise_limit",
      card: { monthlyLimitUsdCents: "90000" },
    });
    expect(lithic.state.updates.at(-1)?.patch).toEqual({
      monthlyLimitUsdCents: 90_000n,
    });
    expect(below.status).toBe(400);
    expect(await auditOf(card.id)).toMatchObject([
      { action: "card.issued" },
      { action: "card.limit_raised" },
    ]);
  });

  it("closes a card, for good", async () => {
    // #given
    const card = await issue();

    // #when
    const closed = await sendJson(app, cardsPath(`/${card.id}/close`), admin, {
      method: "POST",
    });
    const freezeAfter = await sendJson(
      app,
      cardsPath(`/${card.id}/freeze`),
      admin,
      { method: "POST" },
    );
    const closeAgain = await sendJson(
      app,
      cardsPath(`/${card.id}/close`),
      admin,
      { method: "POST" },
    );

    // #then
    expect(expendiCardSchema.parse(await dataOf(closed))).toMatchObject({
      state: "closed",
    });
    expect(lithic.state.updates.at(-1)?.patch).toEqual({ state: "CLOSED" });
    expect(freezeAfter.status).toBe(409);
    expect(closeAgain.status).toBe(200);
    expect(
      lithic.state.updates.filter((u) => u.patch.state === "CLOSED"),
    ).toHaveLength(1);
  });

  it("changes nothing here when Lithic refuses, and says so plainly", async () => {
    // #given
    const card = await issue();
    lithic.state.failUpdateCard = true;

    // #when
    const response = await sendJson(
      app,
      cardsPath(`/${card.id}/close`),
      admin,
      { method: "POST" },
    );

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "We couldn't reach the card issuer. Try again in a minute.",
    );
    expect((await cardRow(card.id)).state).toBe("open");
  });

  it("answers NotFound for an ID that isn't a card", async () => {
    // #when
    const answers = await Promise.all([
      sendJson(app, cardsPath("/not-a-card"), admin),
      sendJson(app, cardsPath(`/${randomUUID()}`), admin),
      sendJson(app, cardsPath("/not-a-card/close"), admin, { method: "POST" }),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([404, 404, 404]);
  });

  it("keeps the purchases routes ahead of /:cardId", () => {
    // #given
    const order = app.routes
      .filter((route) => route.method === "GET")
      .map((route) => route.path);

    // #then
    expect(
      order.indexOf("/organizations/:organizationId/cards/program"),
    ).toBeLessThan(
      order.indexOf("/organizations/:organizationId/cards/:cardId"),
    );
    expect(
      order.indexOf("/organizations/:organizationId/cards/loads"),
    ).toBeLessThan(
      order.indexOf("/organizations/:organizationId/cards/:cardId"),
    );
    const purchases = order.indexOf(
      "/organizations/:organizationId/cards/purchases",
    );
    if (purchases !== -1) {
      expect(purchases).toBeLessThan(
        order.indexOf("/organizations/:organizationId/cards/:cardId"),
      );
    }
  });
});

describe("spent this month", () => {
  it("counts this UTC month's purchases, settled and held, and nothing else", async () => {
    // #given
    const card = await issue();
    const now = new Date();
    const lastMonth = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15),
    );
    const purchase = (
      overrides: Partial<typeof cardPurchases.$inferInsert>,
    ): typeof cardPurchases.$inferInsert => ({
      organizationId: company.organizationId,
      cardId: card.id,
      membershipId: employeeMembershipId,
      lithicTransactionToken: `tx-${randomUUID()}`,
      status: "settled",
      merchant: "Shop",
      mcc: "5734",
      categoryId,
      authorizedAt: now,
      ...overrides,
    });
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .insert(cardPurchases)
        .values([
          purchase({ settledUsdCents: 7_000n, holdUsdCents: 300n }),
          purchase({ status: "pending", holdUsdCents: 1_000n }),
          purchase({ settledUsdCents: 99_999n, authorizedAt: lastMonth }),
          purchase({ kind: "refund", settledUsdCents: 88_888n }),
        ]),
    );

    // #when
    const response = await sendJson(app, cardsPath(`/${card.id}`), admin);

    // #then
    expect(
      expendiCardSchema.parse(await dataOf(response)).spentThisMonthUsdCents,
    ).toBe("8300");
  });
});

describe("Card loads", () => {
  const balanceOf = async () => {
    const program = cardProgramSchema.parse(
      await dataOf(await sendJson(app, cardsPath("/program"), admin)),
    );
    if (program.status !== "on") throw new Error("cards are off");
    return program.balance;
  };

  it("is a row in card_loads and nothing else: no wallet ledger, payouts or Privy", async () => {
    // #given
    const ledgerBefore = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.select({ id: walletTransactions.id }).from(walletTransactions),
    );

    // #when
    const result = await resultOf(
      await confirm(admin, adminPasskey, loadAction("250.50")),
    );

    // #then
    expect(result).toMatchObject({
      type: "load_balance",
      load: {
        amountUsdCents: "25050",
        amountKes: "3223434",
        usdKesRate: USD_RATE,
        simulated: true,
      },
    });
    expect(await balanceOf()).toMatchObject({
      loadedUsdCents: "25050",
      availableUsdCents: "25050",
    });
    const [ledgerAfter, payoutRows, loads] = await runInScope(
      db,
      { organizationId: company.organizationId, role: "admin" },
      (tx) =>
        Promise.all([
          tx.select({ id: walletTransactions.id }).from(walletTransactions),
          tx.select({ id: payouts.id }).from(payouts),
          tx.select().from(cardLoads),
        ]),
    );
    expect(ledgerAfter).toHaveLength(ledgerBefore.length);
    expect(payoutRows).toEqual([]);
    expect(loads).toMatchObject([{ simulated: true, loadedBy: admin.id }]);
    expect(privy.state.sends).toEqual([]);
    expect(Object.values(privy.state.calls)).toEqual(
      Object.values(privy.state.calls).map(() => 0),
    );
    if (result.type !== "load_balance") throw new Error("not a load");
    expect(await auditOf(result.load.id)).toMatchObject([
      { action: "card_load.recorded", after: { simulated: true } },
    ]);
  });

  it("lists loads for admins and accountants", async () => {
    // #given
    await resultOf(await confirm(admin, adminPasskey, loadAction()));

    // #when
    const response = await sendJson(app, cardsPath("/loads"), accountant);

    // #then
    const { loads } = cardLoadListSchema.parse(await dataOf(response));
    expect(loads).toHaveLength(1);
    expect(loads[0]?.loadedBy).toBe(admin.email);
  });

  it("refuses a load that doesn't match what was signed", async () => {
    // #given
    const action = loadAction("100");
    const challenge = await started(await startConfirmation(admin, action));

    // #when
    const response = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      loadAction("10000"),
    );

    // #then
    expect(response.status).toBe(403);
    expect(await balanceOf()).toMatchObject({ loadedUsdCents: "0" });
  });

  it("refuses a load that today's payouts leave no room for", async () => {
    // #given KES 2,000 cap, KES 1,500 already paid out today
    await setCompany({ dailyPayoutCapKes: 200_000n });
    await payClaims(runtime, db, paying, [claimRequest()]);

    // #when USD 10 is KES 1,286.80
    const response = await startConfirmation(admin, loadAction("10"));

    // #then
    expect(response.status).toBe(409);
    expect((await errorOf(response)).message).toContain("daily cap");
    expect(await balanceOf()).toMatchObject({ loadedUsdCents: "0" });
  });

  it("refuses a payout that today's loads leave no room for", async () => {
    // #given KES 2,000 cap, USD 10 (KES 1,286.80) loaded today
    await setCompany({ dailyPayoutCapKes: 200_000n });
    await resultOf(await confirm(admin, adminPasskey, loadAction("10")));
    const prepared = await runtime.runPromise(
      preparePayouts({
        organizationId: company.organizationId,
        actor: { type: "user", id: admin.id },
        requests: [claimRequest()],
      }),
    );
    const approval = await runtime.runPromise(
      requestPayoutApproval({
        organizationId: company.organizationId,
        userId: admin.id,
        payoutIds: prepared.map((payout) => payout.id),
      }),
    );

    // #when KES 1,500 more
    const exit = await runtime.runPromiseExit(
      approvePayouts({
        organizationId: company.organizationId,
        userId: admin.id,
        challengeId: approval.challengeId,
        response: adminPasskey.sign(approval.options, TEST_ORIGIN),
      }),
    );

    // #then
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("daily_cap");
    }
  });

  it("still approves a payout that fits beside today's loads", async () => {
    // #given KES 3,000 cap, KES 1,286.80 loaded
    await setCompany({ dailyPayoutCapKes: 300_000n });
    await resultOf(await confirm(admin, adminPasskey, loadAction("10")));

    // #when KES 1,500 more
    const [payout] = await payClaims(runtime, db, paying, [claimRequest()]);

    // #then
    expect(payout?.status).toBe("paying");
  });

  it("checks the cap again at confirm", async () => {
    // #given
    const action = loadAction("10");
    const challenge = await started(await startConfirmation(admin, action));
    await setCompany({ dailyPayoutCapKes: 100_000n });

    // #when
    const response = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      action,
    );

    // #then
    expect(response.status).toBe(409);
    expect(await balanceOf()).toMatchObject({ loadedUsdCents: "0" });
  });

  it("doesn't let two simultaneous loads both use the same room", async () => {
    // #given two USD 10 loads and room for one
    await setCompany({ dailyPayoutCapKes: 150_000n });
    const action = loadAction("10");
    const other = await anotherAdmin();
    const [first, second] = await Promise.all([
      started(await startConfirmation(admin, action)),
      started(await startConfirmation(other.user, action)),
    ]);

    // #when
    const answers = await Promise.all([
      finishConfirmation(admin, adminPasskey, first, action),
      finishConfirmation(other.user, other.passkey, second, action),
    ]);

    // #then
    expect(answers.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await balanceOf()).toMatchObject({ loadedUsdCents: "1000" });
  });

  it("is blocked by a pause, before the passkey and after", async () => {
    // #given
    const action = loadAction();
    const challenge = await started(await startConfirmation(admin, action));

    // #when
    await pauseCompany();
    const atConfirm = await finishConfirmation(
      admin,
      adminPasskey,
      challenge,
      action,
    );
    const atStart = await startConfirmation(admin, action);

    // #then
    expect(atConfirm.status).toBe(409);
    expect(atStart.status).toBe(409);
    expect(await balanceOf()).toMatchObject({ loadedUsdCents: "0" });
  });

  it("says so, naming no provider, when Paycrest has no rate", async () => {
    // #given
    paycrest.state.failRate = true;

    // #when
    const response = await startConfirmation(admin, loadAction());

    // #then
    expect(response.status).toBe(503);
    expect((await errorOf(response)).message).toBe(
      "Couldn't get today's KES rate. Try again in a minute.",
    );
  });
});

describe("revealing a card's details", () => {
  it("opens the reveal page for the holder, with a fresh passkey each time", async () => {
    // #given
    const card = await issue();
    const action: CardActionRequest = { type: "reveal_card", cardId: card.id };
    const challenge = await started(await startConfirmation(employee, action));

    // #when
    const first = await resultOf(
      await finishConfirmation(employee, employeePasskey, challenge, action),
    );
    const replay = await finishConfirmation(
      employee,
      employeePasskey,
      challenge,
      action,
    );

    // #then
    const row = await cardRow(card.id);
    expect(first).toMatchObject({
      type: "reveal_card",
      revealUrl: `https://business.test/card-reveal#session=${encodeURIComponent(`session-for-${row.lithicCardToken}`)}`,
    });
    expect(replay.status).toBe(403);
    expect(lithic.state.embedSessions).toEqual([row.lithicCardToken]);
    const audited = await auditOf(card.id);
    expect(audited.map((entry) => entry.action)).toEqual([
      "card.issued",
      "card.details_revealed",
    ]);
    expect(JSON.stringify(audited)).not.toContain("session");
  });

  it("refuses anyone but the holder", async () => {
    // #given
    const card = await issue();
    const action: CardActionRequest = { type: "reveal_card", cardId: card.id };

    // #when
    const answers = await Promise.all([
      startConfirmation(colleague, action),
      startConfirmation(admin, action),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([404, 403]);
    expect((await errorOf(answers[1])).message).toContain("person holding");
    expect(lithic.state.embedSessions).toEqual([]);
  });

  it("refuses a closed card, and one being closed, before the passkey and after", async () => {
    // #given
    const closing = await issue();
    const closed = await issue(issueAction({ nickname: "Second" }));
    const action = (cardId: string): CardActionRequest => ({
      type: "reveal_card",
      cardId,
    });
    const closingChallenge = await started(
      await startConfirmation(employee, action(closing.id)),
    );
    const closedChallenge = await started(
      await startConfirmation(employee, action(closed.id)),
    );

    // #when the admin closes one and the other is marked closing
    await sendJson(app, cardsPath(`/${closed.id}/close`), admin, {
      method: "POST",
    });
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(cards)
        .set({ closeRequestedAt: new Date() })
        .where(eq(cards.id, closing.id)),
    );
    const atConfirm = [
      await finishConfirmation(
        employee,
        employeePasskey,
        closingChallenge,
        action(closing.id),
      ),
      await finishConfirmation(
        employee,
        employeePasskey,
        closedChallenge,
        action(closed.id),
      ),
    ];
    const atStart = await Promise.all([
      startConfirmation(employee, action(closing.id)),
      startConfirmation(employee, action(closed.id)),
    ]);

    // #then
    expect(
      [...atConfirm, ...atStart].map((response) => response.status),
    ).toEqual([409, 409, 409, 409]);
    expect(lithic.state.embedSessions).toEqual([]);
  });

  it("works on a frozen card", async () => {
    // #given
    const card = await issue();
    await sendJson(app, cardsPath(`/${card.id}/freeze`), employee, {
      method: "POST",
    });

    // #when
    const result = await resultOf(
      await confirm(employee, employeePasskey, {
        type: "reveal_card",
        cardId: card.id,
      }),
    );

    // #then
    expect(result.type).toBe("reveal_card");
  });
});

describe("closing a leaver's cards", () => {
  const close = () => runtime.runPromise(closeRequestedCards());

  const alertsOf = async (cardId: string) => {
    const { rows } = await owner.query<{
      kind: string;
      occurrences: number;
      resolved_at: Date | null;
    }>(
      `SELECT kind, occurrences, resolved_at FROM ops_alerts WHERE subject_key = $1`,
      [cardId],
    );
    return rows;
  };

  const removeEmployee = () =>
    sendJson(
      app,
      `/organizations/${company.organizationId}/members/${employeeMembershipId}`,
      admin,
      { method: "DELETE" },
    );

  it("marks a removed member's cards and the job closes them at Lithic", async () => {
    // #given
    const open = await issue();
    const frozen = await issue(issueAction({ nickname: "Second" }));
    await sendJson(app, cardsPath(`/${frozen.id}/freeze`), employee, {
      method: "POST",
    });

    // #when
    expect((await removeEmployee()).status).toBe(200);
    expect((await cardRow(open.id)).closeRequestedAt).not.toBeNull();
    expect((await cardRow(open.id)).state).toBe("open");
    await close();

    // #then
    const [openRow, frozenRow] = await Promise.all([
      cardRow(open.id),
      cardRow(frozen.id),
    ]);
    expect([openRow.state, frozenRow.state]).toEqual(["closed", "closed"]);
    expect(openRow.closedAt).not.toBeNull();
    expect(lithic.state.cards.get(openRow.lithicCardToken)?.state).toBe(
      "CLOSED",
    );
    const audited = await auditOf(open.id);
    expect(audited.map((entry) => entry.action)).toEqual([
      "card.issued",
      "card.close_requested",
      "card.closed",
    ]);
    expect(audited.at(-1)?.actor_type).toBe("system");
  });

  it("leaves the card marked in the same transaction as the removal", async () => {
    // #given
    const card = await issue();
    lithic.state.failUpdateCard = true;

    // #when Lithic is down: the removal still goes through and the card waits
    const removal = await removeEmployee();
    const run = await close();

    // #then
    expect(removal.status).toBe(200);
    expect(run).toMatchObject({ closed: 0 });
    expect(await cardRow(card.id)).toMatchObject({
      state: "open",
      closeAttempts: 1,
    });
    expect((await cardRow(card.id)).closeRequestedAt).not.toBeNull();
  });

  it("retries, alerts once at 5 failures, and resolves once it closes", async () => {
    // #given
    const card = await issue();
    await removeEmployee();
    lithic.state.failUpdateCard = true;

    // #when 4 failures
    for (let attempt = 0; attempt < 4; attempt += 1) await close();

    // #then no alert yet
    expect((await cardRow(card.id)).closeAttempts).toBe(4);
    expect(await alertsOf(card.id)).toEqual([]);

    // #when the 5th and 6th failures
    await close();
    await close();

    // #then one alert, raised once
    expect((await cardRow(card.id)).closeAttempts).toBe(6);
    expect(await alertsOf(card.id)).toMatchObject([
      { kind: "card_close_failed", occurrences: 1, resolved_at: null },
    ]);

    // #when Lithic recovers
    lithic.state.failUpdateCard = false;
    await close();

    // #then the card is closed and the alert resolved
    expect((await cardRow(card.id)).state).toBe("closed");
    const [alert] = await alertsOf(card.id);
    expect(alert?.resolved_at).not.toBeNull();
  });

  it("marks a member's cards when they become an accountant", async () => {
    // #given
    const card = await issue();
    const toAccountant = "accountant" as MembershipRole as AssignableRole;

    // #when
    await runtime.runPromise(
      changeMemberRole(
        { organizationId: company.organizationId, userId: admin.id },
        employeeMembershipId,
        toAccountant,
      ),
    );

    // #then
    expect((await cardRow(card.id)).closeRequestedAt).not.toBeNull();
  });

  it("leaves cards alone on a change between admin and employee", async () => {
    // #given
    const card = await issue();

    // #when
    await runtime.runPromise(
      changeMemberRole(
        { organizationId: company.organizationId, userId: admin.id },
        employeeMembershipId,
        "admin",
      ),
    );

    // #then
    expect((await cardRow(card.id)).closeRequestedAt).toBeNull();
  });

  it("won't unfreeze, limit or freeze a card that is closing", async () => {
    // #given
    const card = await issue();
    await sendJson(app, cardsPath(`/${card.id}/freeze`), admin, {
      method: "POST",
    });
    await removeEmployee();
    lithic.state.failUpdateCard = true;

    // #when
    const answers = await Promise.all([
      startConfirmation(admin, { type: "unfreeze_card", cardId: card.id }),
      startConfirmation(admin, {
        type: "raise_limit",
        cardId: card.id,
        monthlyLimitUsd: "9000",
      }),
      sendJson(app, cardsPath(`/${card.id}/lower-limit`), admin, {
        method: "POST",
        body: { monthlyLimitUsd: "1" },
      }),
      sendJson(app, cardsPath(`/${card.id}/freeze`), admin, { method: "POST" }),
    ]);

    // #then
    expect(answers.map((response) => response.status)).toEqual([
      409, 409, 409, 409,
    ]);
  });
});

describe("the issuer", () => {
  it("queues concurrent cardholder creates so there's only one", async () => {
    // #given two cards for one first-time holder, at once
    const shape = await Effect.runPromise(Effect.provide(Lithic, lithic.layer));
    let creating = 0;
    let concurrentCreates = 0;
    const racing = makeTestRuntime({
      lithic: Layer.succeed(Lithic, {
        ...shape,
        createCardholder: (input) =>
          Effect.gen(function* () {
            creating += 1;
            if (creating > 1) concurrentCreates += 1;
            yield* Effect.sleep("30 millis");
            const holder = yield* shape.createCardholder(input);
            creating -= 1;
            return holder;
          }),
      }),
      paycrest: paycrest.layer,
    });
    const racingApp = createApp({ runtime: racing });

    try {
      const other = await anotherAdmin();
      const actionA = issueAction({ nickname: "A" });
      const actionB = issueAction({ nickname: "B" });
      const start = (user: TestUser, action: CardActionRequest) =>
        sendJson(racingApp, cardsPath("/confirmations"), user, {
          method: "POST",
          body: action,
        });
      const [challengeA, challengeB] = await Promise.all([
        started(await start(admin, actionA)),
        started(await start(other.user, actionB)),
      ]);
      const finish = (
        user: TestUser,
        passkey: SoftwarePasskey,
        challenge: Started,
        action: CardActionRequest,
      ) =>
        sendJson(
          racingApp,
          cardsPath(`/confirmations/${challenge.challengeId}`),
          user,
          {
            method: "POST",
            body: {
              action,
              response: passkey.sign(challenge.options, TEST_ORIGIN),
            },
          },
        );

      // #when
      const answers = await Promise.all([
        finish(admin, adminPasskey, challengeA, actionA),
        finish(other.user, other.passkey, challengeB, actionB),
      ]);

      // #then at most one reached Lithic; the other was told to try again
      expect(concurrentCreates).toBe(0);
      expect(lithic.state.cardholders).toHaveLength(1);
      const statuses = answers.map((response) => response.status).sort();
      expect(statuses[0]).toBe(200);
    } finally {
      await racing.dispose();
    }
  });

  it("never exposes the issuer's tokens", async () => {
    // #given
    const card = await issue();
    const token = (await cardRow(card.id)).lithicCardToken;

    // #when
    const responses = await Promise.all([
      sendJson(app, cardsPath(`/${card.id}`), employee),
      sendJson(app, cardsPath(), admin),
      sendJson(app, cardsPath("/program"), admin),
    ]);
    const bodies = await Promise.all(
      responses.map((response) => response.text()),
    );

    // #then
    for (const body of bodies) expect(body).not.toContain(token);
  });
});
