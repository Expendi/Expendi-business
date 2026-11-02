import { randomBytes, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { ZohoMapping } from "@expendi-business/shared";
import {
  accountingSyncsResponseSchema,
  claimDetailSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AccountingSyncRow } from "../../db/schema/index.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { PayingCompany } from "../helpers/payouts.js";
import type { TestStaff } from "../helpers/staff.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import {
  accountingSyncs,
  expenses,
  receiptFiles,
} from "../../db/schema/index.js";
import { runInScope, withScope } from "../../db/scope.js";
import { applyPayoutOutcome } from "../../services/payout/subjects.js";
import { enqueuePaidClaim } from "../../services/zoho/enqueue.js";
import { claimDescription, kesDecimal } from "../../services/zoho/posting.js";
import {
  MAX_SYNC_ATTEMPTS,
  syncAccountingItem,
} from "../../services/zoho/sync.js";
import { claimFlow } from "../helpers/claim-flow.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import {
  makeFakeBaseRpc,
  makeFakeFileStorage,
  makeFakePaycrest,
  makeFakePrivyWallets,
  makeFakeZoho,
} from "../helpers/fakes.js";
import { createPayingCompany } from "../helpers/payouts.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { createStaff } from "../helpers/staff.js";
import {
  connectZoho,
  finishZohoSetUp,
  revokeZohoAccess,
  signInToZoho,
  staffRequest,
  ZOHO_KES_ORGANIZATION,
  zohoStaffPath,
} from "../helpers/zoho.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const TOKEN_KEY_BASE64 = randomBytes(32).toString("base64");

const privy = makeFakePrivyWallets();
const paycrest = makeFakePaycrest();
const storage = makeFakeFileStorage();
const rpc = makeFakeBaseRpc();
const zoho = makeFakeZoho();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let opsAdmin: TestStaff;
let viewer: TestStaff;

beforeAll(async () => {
  runtime = makeTestRuntime(
    {
      privyWallets: privy.layer,
      paycrest: paycrest.layer,
      fileStorage: storage.layer,
      baseRpc: rpc.layer,
      zoho: zoho.layer,
    },
    { ACCOUNTING_TOKEN_KEY: TOKEN_KEY_BASE64 },
  );
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 2 });
  [opsAdmin, viewer] = await Promise.all([
    createStaff(owner),
    createStaff(owner, { role: "ops_viewer" }),
  ]);
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

beforeEach(() => {
  privy.state.reset();
  paycrest.state.reset();
  storage.state.reset();
  zoho.state.reset();
});

interface Company {
  readonly paying: PayingCompany;
  readonly company: TestCompany;
  readonly flow: ReturnType<typeof claimFlow>;
  readonly employee: TestUser;
  readonly mealsCategoryId: string;
  readonly mapping: ZohoMapping;
}

/** A funded company with an employee; Meals maps to the travel account. */
async function companyWithClaims(): Promise<Company> {
  const paying = await createPayingCompany(runtime, db);
  const flow = claimFlow({ app, db, storage, paycrest }, paying);
  const { user: employee } = await flow.employee("Jane Wanjiku");
  const mealsCategoryId = await addCategory(db, paying.company, "Meals");
  return {
    paying,
    company: paying.company,
    flow,
    employee,
    mealsCategoryId,
    mapping: {
      categoryAccounts: { [mealsCategoryId]: "acc-travel" },
      paidThroughAccountId: "acc-wallet",
      defaultAccountId: "acc-fees",
    },
  };
}

async function connected(): Promise<Company> {
  const setUp = await companyWithClaims();
  await connectZoho(app, opsAdmin, setUp.company, setUp.mapping);
  return setUp;
}

/** The employee submits a claim in Meals, with a photo of the receipt. */
async function submitClaim(
  { company, employee, mealsCategoryId }: Company,
  amountKes = "1,500.50",
): Promise<string> {
  const upload = await uploadReceipt(app, storage, company, employee);
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/claims`,
    employee,
    {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId: mealsCategoryId,
        amountKes,
      }),
    },
  );
  expect(response.status).toBe(201);
  const { data } = (await response.json()) as { data: unknown };
  return claimDetailSchema.parse(data).id;
}

/** A claim the admin approved and Paycrest paid. */
async function paidClaim(
  setUp: Company,
  amountKes = "1,500.50",
): Promise<string> {
  const claimId = await submitClaim(setUp, amountKes);
  await setUp.flow.pay(claimId);
  return claimId;
}

async function syncsOf(company: TestCompany): Promise<AccountingSyncRow[]> {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx.select().from(accountingSyncs).orderBy(accountingSyncs.createdAt),
  );
}

async function onlySync(company: TestCompany): Promise<AccountingSyncRow> {
  const rows = await syncsOf(company);
  expect(rows).toHaveLength(1);
  const [row] = rows;
  if (!row) throw new Error("no sync");
  return row;
}

/** What the job would do for this company's queued items, now. */
async function runSync(company: TestCompany): Promise<string[]> {
  const outcomes: string[] = [];
  for (const row of await syncsOf(company)) {
    outcomes.push(
      await runtime.runPromise(
        syncAccountingItem(company.organizationId, row.id),
      ),
    );
  }
  return outcomes;
}

/** Skips the wait before the next try. */
async function makeDue(company: TestCompany): Promise<void> {
  await runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(accountingSyncs)
      .set({ nextAttemptAt: new Date(Date.now() - 1000) }),
  );
}

async function connectionStatus(company: TestCompany): Promise<string> {
  const { rows } = await owner.query<{ status: string }>(
    "SELECT status FROM accounting_connections WHERE organization_id = $1 AND status <> 'disconnected'",
    [company.organizationId],
  );
  return rows[0]?.status ?? "none";
}

async function syncAudit(
  company: TestCompany,
): Promise<{ action: string; actor_type: string; actor_id: string }[]> {
  const { rows } = await owner.query<{
    action: string;
    actor_type: string;
    actor_id: string;
  }>(
    `SELECT action, actor_type, actor_id FROM audit_log
     WHERE organization_id = $1 AND entity_type = 'accounting_sync'
     ORDER BY occurred_at`,
    [company.organizationId],
  );
  return rows;
}

/** Someone entered the claim in Zoho by hand, twice. */
function enteredTwiceInZoho(claimId: string): void {
  for (const id of ["1", "2"]) {
    zoho.state.expenses.push({
      id,
      organizationId: ZOHO_KES_ORGANIZATION,
      draft: {
        accountId: "acc-travel",
        paidThroughAccountId: "acc-wallet",
        date: "2026-10-15",
        amount: "1500.50",
        referenceNumber: claimId,
        description: "entered by hand",
      },
      receipt: null,
    });
  }
}

const zohoExpensesFor = (reference: string) =>
  zoho.state.expenses.filter(
    ({ draft }) => draft.referenceNumber === reference,
  );

describe("a paid claim in Zoho Books", () => {
  it("is posted with the mapped account, amount, reference, details and receipt", async () => {
    // #given
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    const [receipt] = await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx
          .select({ storageKey: receiptFiles.storageKey })
          .from(receiptFiles)
          .where(eq(receiptFiles.expenseId, claimId)),
    );
    const receiptBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    storage.state.put(
      receipt?.storageKey ?? "",
      receiptBytes.byteLength,
      "image/jpeg",
      receiptBytes,
    );

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(
      zoho.state.expenses.map(({ organizationId, draft, receipt }) => ({
        organizationId,
        draft,
        receipt,
      })),
    ).toEqual([
      {
        organizationId: ZOHO_KES_ORGANIZATION,
        draft: {
          accountId: "acc-travel",
          paidThroughAccountId: "acc-wallet",
          date: "2026-10-15",
          amount: "1500.50",
          referenceNumber: claimId,
          description:
            "Java House Westlands · Lunch with the Acme team · Jane Wanjiku",
        },
        receipt: {
          bytes: receiptBytes,
          contentType: "image/jpeg",
          fileName: `expendi-${claimId}.jpg`,
        },
      },
    ]);
    expect(await onlySync(setUp.company)).toMatchObject({
      subjectType: "expense",
      subjectId: claimId,
      status: "synced",
      attempts: 1,
      externalId: zoho.state.expenses[0]?.id,
      externalOrganizationId: ZOHO_KES_ORGANIZATION,
      receiptAttached: true,
      lastError: null,
    });
  });

  it("posts to the default account when the category isn't mapped", async () => {
    // #given
    const setUp = await companyWithClaims();
    await connectZoho(app, opsAdmin, setUp.company, {
      ...setUp.mapping,
      categoryAccounts: {},
    });
    await paidClaim(setUp);

    // #when
    await runSync(setUp.company);

    // #then
    expect(zoho.state.expenses.map(({ draft }) => draft.accountId)).toEqual([
      "acc-fees",
    ]);
  });

  it("posts without a receipt Zoho wouldn't take", async () => {
    // #given
    const setUp = await connected();
    const claimId = await submitClaim(setUp);
    await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx
          .update(receiptFiles)
          .set({ contentType: "image/webp" })
          .where(eq(receiptFiles.expenseId, claimId)),
    );
    await setUp.flow.pay(claimId);

    // #when
    await runSync(setUp.company);

    // #then
    expect(zoho.state.expenses.map(({ receipt }) => receipt)).toEqual([null]);
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "synced",
      receiptAttached: false,
    });
  });
});

describe("what gets queued", () => {
  it("queues a claim in the same change that marks it paid", async () => {
    // #given
    const setUp = await connected();

    // #when
    const claimId = await paidClaim(setUp);

    // #then
    expect(await onlySync(setUp.company)).toMatchObject({
      subjectType: "expense",
      subjectId: claimId,
      status: "pending",
      attempts: 0,
    });
  });

  it("queues nothing when the change marking the claim paid rolls back", async () => {
    // #given
    const setUp = await connected();
    const claimId = await submitClaim(setUp);
    const payout = await setUp.flow.approveAndPay(claimId);

    // #when
    const exit = await runtime.runPromiseExit(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        applyPayoutOutcome(tx, {
          ...payout,
          status: "paid",
          paidAt: new Date(),
        }).pipe(Effect.zipRight(Effect.fail("payout write failed"))),
      ),
    );

    // #then
    expect(exit._tag).toBe("Failure");
    expect(await syncsOf(setUp.company)).toEqual([]);
    const [still] = await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) => tx.select({ status: expenses.status }).from(expenses),
    );
    expect(still?.status).toBe("paying");
  });

  it("never queues a claim that isn't paid", async () => {
    // #given
    const setUp = await connected();
    const submitted = await submitClaim(setUp);
    const rejected = await submitClaim(setUp, "200.00");
    await setUp.flow.reject(rejected, "Not a work expense");
    const failed = await submitClaim(setUp, "300.00");
    await setUp.flow.failPayout(failed);
    const paying = await submitClaim(setUp, "400.00");
    await setUp.flow.approveAndPay(paying);

    // #when
    await runtime.runPromise(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        Effect.forEach([submitted, rejected, failed, paying], (claimId) =>
          enqueuePaidClaim(tx, setUp.company.organizationId, claimId),
        ),
      ),
    );

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });

  it("never queues or posts imported paid_outside history", async () => {
    // #given
    const setUp = await connected();
    const claimId = randomUUID();
    await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx.insert(expenses).values({
          id: claimId,
          organizationId: setUp.company.organizationId,
          membershipId: setUp.company.adminMembershipId,
          categoryId: setUp.mealsCategoryId,
          kind: "claim",
          status: "paid_outside",
          source: "import",
          merchant: "Imported lunch",
          amountKes: 50_000n,
          spentOn: "2026-08-01",
          overviewHeading: "petty_cash",
        }),
    );

    // #when
    await runtime.runPromise(
      withScope({ organizationId: setUp.company.organizationId }, (tx) =>
        enqueuePaidClaim(tx, setUp.company.organizationId, claimId),
      ),
    );
    await runInScope(
      db,
      { organizationId: setUp.company.organizationId },
      (tx) =>
        tx.insert(accountingSyncs).values({
          organizationId: setUp.company.organizationId,
          subjectType: "expense",
          subjectId: claimId,
        }),
    );
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["failed"]);
    expect(zoho.state.searches).toEqual([]);
    expect(zoho.state.expenses).toEqual([]);
  });

  it("queues nothing for a company without a Zoho connection", async () => {
    // #given
    const setUp = await companyWithClaims();

    // #when
    await paidClaim(setUp);

    // #then
    expect(await syncsOf(setUp.company)).toEqual([]);
  });
});

describe("retries", () => {
  it("finds a create that timed out by its reference, leaving one Zoho expense", async () => {
    // #given
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    zoho.state.loseNextCreateReply = true;
    expect(await runSync(setUp.company)).toEqual(["deferred"]);
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "pending",
      attempts: 1,
      externalId: null,
      lastError: "Zoho didn't answer in time.",
    });
    await makeDue(setUp.company);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(zohoExpensesFor(claimId)).toHaveLength(1);
    expect(zoho.state.searches).toEqual([claimId, claimId]);
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "synced",
      attempts: 2,
      externalId: zohoExpensesFor(claimId)[0]?.id,
      receiptAttached: true,
    });
  });

  it("waits before trying again", async () => {
    // #given
    const setUp = await connected();
    await paidClaim(setUp);
    zoho.state.failNext("createExpense", "API_ERROR");
    await runSync(setUp.company);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["skipped"]);
    const sync = await onlySync(setUp.company);
    expect(sync.nextAttemptAt.getTime()).toBeGreaterThan(Date.now() + 50_000);
  });

  it("attaches the receipt on the next try without creating again", async () => {
    // #given
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    zoho.state.failNext("attachReceipt", "API_ERROR");
    expect(await runSync(setUp.company)).toEqual(["deferred"]);
    await makeDue(setUp.company);

    // #when
    await runSync(setUp.company);

    // #then
    expect(zohoExpensesFor(claimId)).toHaveLength(1);
    expect(zohoExpensesFor(claimId)[0]?.receipt).not.toBeNull();
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "synced",
      receiptAttached: true,
    });
  });

  it("doesn't upload the receipt again when an upload timed out but landed", async () => {
    // #given
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    zoho.state.loseNextReceiptReply = true;
    expect(await runSync(setUp.company)).toEqual(["deferred"]);
    await makeDue(setUp.company);

    // #when
    await runSync(setUp.company);

    // #then
    expect(zoho.state.receiptUploads).toHaveLength(1);
    expect(zohoExpensesFor(claimId)).toHaveLength(1);
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "synced",
      receiptAttached: true,
    });
  });

  it("never creates when the reference search fails", async () => {
    // #given
    const setUp = await connected();
    await paidClaim(setUp);
    zoho.state.failNext("findExpenses", "API_ERROR");

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["deferred"]);
    expect(zoho.state.expenses).toEqual([]);
  });

  it("fails at once when Zoho already holds the reference twice", async () => {
    // #given
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    enteredTwiceInZoho(claimId);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["failed"]);
    expect(zoho.state.expenses).toHaveLength(2);
    expect((await onlySync(setUp.company)).lastError).toContain(
      "Remove the extra ones in Zoho",
    );
  });

  it("fails once its tries run out, and audits it", async () => {
    // #given
    const setUp = await connected();
    await paidClaim(setUp);

    // #when
    for (let tried = 0; tried < MAX_SYNC_ATTEMPTS; tried += 1) {
      zoho.state.failNext("createExpense", "API_ERROR");
      await makeDue(setUp.company);
      await runSync(setUp.company);
    }

    // #then
    const sync = await onlySync(setUp.company);
    expect(sync).toMatchObject({
      status: "failed",
      attempts: MAX_SYNC_ATTEMPTS,
    });
    expect(sync.lastError).toContain("fake Zoho createExpense");
    expect(await syncAudit(setUp.company)).toEqual([
      {
        action: "accounting_sync.failed",
        actor_type: "system",
        actor_id: "zoho-sync",
      },
    ]);
    expect(zoho.state.expenses).toEqual([]);
  });
});

describe("lost access", () => {
  it("marks the connection needs_reconnect and pauses without using up tries", async () => {
    // #given
    const setUp = await connected();
    await paidClaim(setUp);
    revokeZohoAccess(zoho);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["paused"]);
    expect(await connectionStatus(setUp.company)).toBe("needs_reconnect");
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: "Waiting for the Zoho connection to be reconnected.",
    });
  });

  it("syncs claims paid in the meantime once reconnected", async () => {
    // #given
    const setUp = await connected();
    const before = await paidClaim(setUp);
    revokeZohoAccess(zoho);
    await runSync(setUp.company);
    const during = await paidClaim(setUp, "800.00");
    for (let run = 0; run <= MAX_SYNC_ATTEMPTS; run += 1) {
      await makeDue(setUp.company);
      expect(await runSync(setUp.company)).toEqual(["paused", "paused"]);
    }
    expect(zoho.state.expenses).toEqual([]);

    // #when
    await signInToZoho(app, opsAdmin, setUp.company);
    const outcomes = await runSync(setUp.company);

    // #then
    expect(await connectionStatus(setUp.company)).toBe("active");
    expect(outcomes).toEqual(["synced", "synced"]);
    expect(
      zoho.state.expenses.map(({ draft }) => draft.referenceNumber).sort(),
    ).toEqual([before, during].sort());
  });

  it("doesn't try a claim while the connection is still being set up", async () => {
    // #given
    const setUp = await companyWithClaims();
    await signInToZoho(app, opsAdmin, setUp.company);
    await paidClaim(setUp);

    // #when
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["paused"]);
    expect(await onlySync(setUp.company)).toMatchObject({
      status: "pending",
      attempts: 0,
      lastError: null,
    });
    expect(zoho.state.searches).toEqual([]);
  });

  it("syncs it once the organization and mapping are chosen", async () => {
    // #given
    const setUp = await companyWithClaims();
    await signInToZoho(app, opsAdmin, setUp.company);
    await paidClaim(setUp);
    await runSync(setUp.company);

    // #when
    await finishZohoSetUp(app, opsAdmin, setUp.company, setUp.mapping);
    const outcomes = await runSync(setUp.company);

    // #then
    expect(outcomes).toEqual(["synced"]);
    expect(await onlySync(setUp.company)).toMatchObject({ attempts: 1 });
  });
});

describe("staff", () => {
  /** A sync that failed because the claim was already in Zoho twice. */
  async function failedSync(): Promise<Company & { claimId: string }> {
    const setUp = await connected();
    const claimId = await paidClaim(setUp);
    enteredTwiceInZoho(claimId);
    expect(await runSync(setUp.company)).toEqual(["failed"]);
    return { ...setUp, claimId };
  }

  it("lists failed syncs with what they post and why they failed", async () => {
    // #given
    const setUp = await failedSync();

    // #when
    const reply = await staffRequest(
      app,
      viewer,
      "GET",
      zohoStaffPath(setUp.company, "/syncs?status=failed"),
    );

    // #then
    expect(reply.status).toBe(200);
    const listed = accountingSyncsResponseSchema.parse(reply.data);
    expect(listed.counts).toEqual({ pending: 0, synced: 0, failed: 1 });
    expect(listed.syncs).toHaveLength(1);
    const [failed] = listed.syncs;
    expect(failed).toMatchObject({
      subjectType: "expense",
      subjectId: setUp.claimId,
      subject: {
        label: "Java House Westlands",
        date: "2026-10-15",
        amountKesCents: "150050",
      },
      status: "failed",
      attempts: 1,
    });
    expect(failed?.lastError).toContain("Remove the extra ones in Zoho");
  });

  it("retries a failed sync, audited, and the job then posts it once", async () => {
    // #given
    const setUp = await failedSync();
    const sync = await onlySync(setUp.company);
    zoho.state.expenses.length = 0;

    // #when
    const reply = await staffRequest(
      app,
      opsAdmin,
      "POST",
      zohoStaffPath(setUp.company, `/syncs/${sync.id}/requeue`),
    );
    const outcomes = await runSync(setUp.company);

    // #then
    expect(reply.status).toBe(200);
    expect(reply.data).toMatchObject({ status: "pending", attempts: 0 });
    expect(outcomes).toEqual(["synced"]);
    expect(zohoExpensesFor(setUp.claimId)).toHaveLength(1);
    expect((await syncAudit(setUp.company)).at(-1)).toEqual({
      action: "accounting_sync.requeued",
      actor_type: "staff",
      actor_id: opsAdmin.staffUserId,
    });
  });

  it("refuses to retry a sync that hasn't failed", async () => {
    // #given
    const setUp = await connected();
    await paidClaim(setUp);
    const sync = await onlySync(setUp.company);

    // #when
    const reply = await staffRequest(
      app,
      opsAdmin,
      "POST",
      zohoStaffPath(setUp.company, `/syncs/${sync.id}/requeue`),
    );

    // #then
    expect(reply.status).toBe(409);
  });

  it("refuses a viewer's retry", async () => {
    // #given
    const setUp = await failedSync();
    const sync = await onlySync(setUp.company);

    // #when
    const reply = await staffRequest(
      app,
      viewer,
      "POST",
      zohoStaffPath(setUp.company, `/syncs/${sync.id}/requeue`),
    );

    // #then
    expect(reply.status).toBe(403);
    expect((await onlySync(setUp.company)).status).toBe("failed");
  });

  it("only shows and retries the company in the path", async () => {
    // #given
    const companyA = await failedSync();
    const companyB = await failedSync();
    const syncB = await onlySync(companyB.company);

    // #when
    const listed = await staffRequest(
      app,
      opsAdmin,
      "GET",
      zohoStaffPath(companyA.company, "/syncs?status=failed"),
    );
    const retried = await staffRequest(
      app,
      opsAdmin,
      "POST",
      zohoStaffPath(companyA.company, `/syncs/${syncB.id}/requeue`),
    );

    // #then
    expect(
      accountingSyncsResponseSchema
        .parse(listed.data)
        .syncs.map(({ subjectId }) => subjectId),
    ).toEqual([companyA.claimId]);
    expect(retried.status).toBe(404);
    expect((await onlySync(companyB.company)).status).toBe("failed");
  });

  it("is a 404 for an unknown or malformed sync", async () => {
    // #given
    const setUp = await companyWithClaims();

    // #when
    const statuses = await Promise.all(
      [randomUUID(), "not-a-uuid"].map(
        async (syncId) =>
          (
            await staffRequest(
              app,
              opsAdmin,
              "POST",
              zohoStaffPath(setUp.company, `/syncs/${syncId}/requeue`),
            )
          ).status,
      ),
    );

    // #then
    expect(statuses).toEqual([404, 404]);
  });
});

describe("claimDescription", () => {
  it("joins what exists, labelled", () => {
    // #then
    expect(
      claimDescription({
        merchant: "Naivas",
        description: "Office \n milk",
        employeeName: "Jane Wanjiku",
        mpesaCode: "SKL3ABCDEF",
        etimsInvoiceNumber: "0040123456789",
        etimsSupplierPin: "P051234567Z",
      }),
    ).toBe(
      "Naivas · Office milk · Jane Wanjiku · M-Pesa SKL3ABCDEF · eTIMS 0040123456789 · PIN P051234567Z",
    );
  });

  it("shortens the merchant and description to keep Zoho's 100 characters", () => {
    // #when
    const description = claimDescription({
      merchant: "Naivas Supermarket Westlands",
      description: "A very long explanation ".repeat(10),
      employeeName: "Jane Wanjiku",
      mpesaCode: "SKL3ABCDEF",
      etimsInvoiceNumber: "0040123456789",
      etimsSupplierPin: "P051234567Z",
    });

    // #then
    expect([...description].length).toBeLessThanOrEqual(100);
    expect(description).toMatch(
      /^Naivas Supermarket .*… · Jane Wanjiku · M-Pesa SKL3ABCDEF · eTIMS 0040123456789 · PIN P051234567Z$/,
    );
  });
});

describe("kesDecimal", () => {
  it.each([
    [150_050n, "1500.50"],
    [5n, "0.05"],
    [100n, "1.00"],
    [900_719_925_474_099_399n, "9007199254740993.99"],
  ])("writes %s cents as %s", (cents, decimal) => {
    // #then
    expect(kesDecimal(cents)).toBe(decimal);
  });
});
