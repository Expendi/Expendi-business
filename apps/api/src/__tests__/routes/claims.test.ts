import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ClaimDetail,
  ClaimsPage,
  ExpenseStatus,
  SubmitClaimRequest,
  UpdateClaimRequest,
} from "@expendi-business/shared";
import { claimDetailSchema, claimsPageSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, receiptFiles } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { FAKE_STORAGE_ORIGIN, makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;
let fixture: IsolationFixture;

let company: TestCompany;
let employeeA: TestUser;
let employeeB: TestUser;
let employeeAMembershipId: string;
let mealsId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
  fixture = await createIsolationFixture(db);
});

beforeEach(async () => {
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  [employeeA, employeeB] = await Promise.all([createUser(db), createUser(db)]);
  employeeAMembershipId = await addMember(db, company, employeeA);
  await addMember(db, company, employeeB);
  mealsId = await addCategory(db, company, "Meals & entertainment");
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const claimsPath = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/claims`;

async function dataOf(response: Response): Promise<unknown> {
  const body = (await response.json()) as { data: unknown };
  return body.data;
}

async function submitAs(
  user: TestUser,
  overrides: Partial<SubmitClaimRequest> = {},
  target: TestCompany = company,
): Promise<Response> {
  const upload = await uploadReceipt(app, storage, target, user);
  return sendJson(app, claimsPath(target), user, {
    method: "POST",
    body: claimRequest({
      receiptFileIds: [upload.receiptFileId],
      categoryId: mealsId,
      ...overrides,
    }),
  });
}

async function submitted(
  user: TestUser,
  overrides: Partial<SubmitClaimRequest> = {},
  target: TestCompany = company,
): Promise<ClaimDetail> {
  const response = await submitAs(user, overrides, target);
  expect(response.status).toBe(201);
  return claimDetailSchema.parse(await dataOf(response));
}

const getClaim = (claimId: string, user: TestUser) =>
  sendJson(app, `${claimsPath()}/${claimId}`, user);

const listClaims = (user: TestUser, query = "") =>
  sendJson(app, `${claimsPath()}${query}`, user);

const editClaim = (claimId: string, user: TestUser, body: UpdateClaimRequest) =>
  sendJson(app, `${claimsPath()}/${claimId}`, user, { method: "PATCH", body });

async function listed(user: TestUser, query = ""): Promise<ClaimsPage> {
  const response = await listClaims(user, query);
  expect(response.status).toBe(200);
  return claimsPageSchema.parse(await dataOf(response));
}

function setStatus(
  claimId: string,
  status: ExpenseStatus,
  rejectedReason: string | null = null,
): Promise<unknown> {
  return runInScope(db, { organizationId: company.organizationId }, (tx) =>
    tx
      .update(expenses)
      .set({ status, rejectedReason })
      .where(eq(expenses.id, claimId)),
  );
}

async function auditEntries(claimId: string) {
  const { rows } = await owner.query<{
    action: string;
    actor_id: string;
    before: Record<string, unknown> | null;
    after: Record<string, unknown> | null;
  }>(
    `SELECT action, actor_id, before, after FROM audit_log
     WHERE entity_type = 'expense' AND entity_id = $1 ORDER BY occurred_at, id`,
    [claimId],
  );
  return rows;
}

describe("POST /organizations/:organizationId/claims", () => {
  it("submits an employee's photo claim with its file in the company's folder", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId: mealsId,
        mpesaCode: "slk4h7q2xy",
      }),
    });

    // #then
    expect(response.status).toBe(201);
    const claim = claimDetailSchema.parse(await dataOf(response));
    expect(claim).toMatchObject({
      status: "submitted",
      merchant: "Java House Westlands",
      amountKes: "150050",
      spentOn: "2026-10-15",
      category: { id: mealsId, name: "Meals & entertainment" },
      mpesaCode: "SLK4H7Q2XY",
      etimsStatus: "none",
      rejectedReason: null,
      submittedBy: {
        membershipId: employeeAMembershipId,
        email: employeeA.email,
      },
      canEdit: true,
      receiptCount: 1,
    });
    expect(claim.receipts).toMatchObject([
      { url: `${FAKE_STORAGE_ORIGIN}/${upload.storageKey}?signature=download` },
    ]);
    expect(upload.storageKey.startsWith(`org/${company.organizationId}/`)).toBe(
      true,
    );
  });

  it("stores the amount as integer cents, the claim kind and the caller's membership", async () => {
    // #when
    const claim = await submitted(employeeA, { amountKes: "0.5" });

    // #then
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) => tx.select().from(expenses).where(eq(expenses.id, claim.id)),
    );
    expect(row).toMatchObject({
      amountKes: 50n,
      kind: "claim",
      overviewHeading: "petty_cash",
      source: "app",
      status: "submitted",
      membershipId: employeeAMembershipId,
    });
  });

  it("attaches the receipt to the claim", async () => {
    // #when
    const claim = await submitted(employeeA);

    // #then
    const files = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ expenseId: receiptFiles.expenseId })
          .from(receiptFiles)
          .where(eq(receiptFiles.expenseId, claim.id)),
    );
    expect(files).toEqual([{ expenseId: claim.id }]);
  });

  it("audits the submission", async () => {
    // #when
    const claim = await submitted(employeeA);

    // #then
    const entries = await auditEntries(claim.id);
    expect(entries).toMatchObject([
      {
        action: "expense.submitted",
        actor_id: employeeA.id,
        before: null,
        after: {
          kind: "claim",
          status: "submitted",
          amountKes: "150050",
          merchant: "Java House Westlands",
        },
      },
    ]);
  });

  it("marks eTIMS attached with an invoice number, and not required for an exempt category", async () => {
    // #given
    const airTravelId = await addCategory(db, company, "Air travel", {
      etimsNotRequired: true,
    });

    // #when
    const withInvoice = await submitted(employeeA, {
      etimsInvoiceNumber: "kracu0100000001/123",
      etimsSupplierPin: "p051234567x",
    });
    const exempt = await submitted(employeeA, { categoryId: airTravelId });

    // #then
    expect(withInvoice).toMatchObject({
      etimsStatus: "attached",
      etimsInvoiceNumber: "KRACU0100000001/123",
      etimsSupplierPin: "P051234567X",
    });
    expect(exempt.etimsStatus).toBe("not_required");
  });

  it.each(["1.234", "-50", "0", "fifty", "1,50"])(
    "refuses the amount %j",
    async (amountKes) => {
      // #when
      const response = await submitAs(employeeA, { amountKes });

      // #then
      expect(response.status).toBe(400);
    },
  );

  it("refuses a receipt that never reached storage", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    storage.state.objects.delete(upload.storageKey);

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId: mealsId,
      }),
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("didn't finish uploading");
  });

  it("refuses someone else's receipt", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeB);

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId: mealsId,
      }),
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("isn't available");
  });

  it("refuses a receipt already on another claim", async () => {
    // #given
    const first = await submitted(employeeA);
    const [file] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ id: receiptFiles.id })
          .from(receiptFiles)
          .where(eq(receiptFiles.expenseId, first.id)),
    );

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [file?.id ?? ""],
        categoryId: mealsId,
      }),
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("needs a receipt, screenshot or SMS", async () => {
    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({ receiptFileIds: [], categoryId: mealsId }),
    });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Add a photo or screenshot of the receipt, or paste the M-Pesa SMS.",
    );
  });

  it("refuses another company's category and an archived one", async () => {
    // #given
    const other = await createCompany(db);
    const foreignCategoryId = await addCategory(db, other, "Fuel");
    const archivedId = await addCategory(db, company, "Old", {
      archived: true,
    });

    // #when
    const foreign = await submitAs(employeeA, {
      categoryId: foreignCategoryId,
    });
    const archived = await submitAs(employeeA, { categoryId: archivedId });

    // #then
    expect([foreign.status, archived.status]).toEqual([400, 400]);
  });

  it("refuses a date in the future", async () => {
    // #when
    const response = await submitAs(employeeA, { spentOn: "2999-01-01" });

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("future");
  });

  it("refuses an M-Pesa code already on a claim in the company", async () => {
    // #given
    await submitted(employeeB, { mpesaCode: "SLK4H7Q2XY" });

    // #when
    const response = await submitAs(employeeA, { mpesaCode: "slk4h7q2xy" });

    // #then
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        message:
          "This M-Pesa code is already on another employee's claim of 15 Oct 2026 for KES 1,500.50.",
      },
    });
  });

  it("allows an admin to submit their own claim", async () => {
    // #when
    const claim = await submitted(company.admin);

    // #then
    expect(claim.submittedBy.membershipId).toBe(company.adminMembershipId);
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(claimsPath(), { method: "POST" });

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/claims`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    }));
  });
});

describe("GET /organizations/:organizationId/claims", () => {
  it("shows an employee only their own claims", async () => {
    // #given
    const own = await submitted(employeeA);
    await submitted(employeeB);
    await submitted(company.admin);

    // #when
    const page = await listed(employeeA);

    // #then
    expect(page.claims.map((claim) => claim.id)).toEqual([own.id]);
  });

  it("shows an admin every claim in the company, newest first, with who submitted it", async () => {
    // #given
    const first = await submitted(employeeA);
    const second = await submitted(employeeB);

    // #when
    const page = await listed(company.admin);

    // #then
    expect(page.claims.map((claim) => claim.id)).toEqual([second.id, first.id]);
    expect(page.claims[1]?.submittedBy.email).toBe(employeeA.email);
    expect(page.claims[0]?.canEdit).toBe(false);
  });

  it("filters by status", async () => {
    // #given
    const rejected = await submitted(employeeA);
    await submitted(employeeA);
    await setStatus(rejected.id, "rejected", "Blurry photo");

    // #when
    const page = await listed(employeeA, "?status=rejected");

    // #then
    expect(page.claims).toMatchObject([
      { id: rejected.id, rejectedReason: "Blurry photo" },
    ]);
  });

  it("pages through claims without skipping or repeating one", async () => {
    // #given
    const claims: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      claims.unshift((await submitted(employeeA)).id);
    }

    // #when
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page: ClaimsPage = await listed(employeeA, query);
      seen.push(...page.claims.map((claim) => claim.id));
      cursor = page.nextCursor;
    } while (cursor);

    // #then
    expect(seen).toEqual(claims);
  });

  it("refuses a cursor it didn't issue", async () => {
    // #when
    const response = await listClaims(employeeA, "?cursor=bm90LWEtY3Vyc29y");

    // #then
    expect(response.status).toBe(400);
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(claimsPath());

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/claims`,
    }));
  });
});

describe("GET /organizations/:organizationId/claims/:claimId", () => {
  it("shows the owner their claim with a link to each receipt", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await getClaim(claim.id, employeeA);

    // #then
    expect(response.status).toBe(200);
    const detail = claimDetailSchema.parse(await dataOf(response));
    expect(detail.receipts).toMatchObject([
      { kind: "photo", contentType: "image/jpeg" },
    ]);
  });

  it("hides another employee's claim", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await getClaim(claim.id, employeeB);

    // #then
    expect(response.status).toBe(404);
  });

  it("shows an admin anyone's claim", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await getClaim(claim.id, company.admin);

    // #then
    expect(response.status).toBe(200);
  });

  it("answers 404 for an unknown or malformed ID", async () => {
    // #when
    const unknown = await getClaim(randomUUID(), employeeA);
    const malformed = await getClaim("not-an-id", employeeA);

    // #then
    expect([unknown.status, malformed.status]).toEqual([404, 404]);
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(`${claimsPath()}/${randomUUID()}`);

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/claims/${randomUUID()}`,
    }));
  });
});

describe("PATCH /organizations/:organizationId/claims/:claimId", () => {
  it("lets the owner edit a submitted claim, audited with only what changed", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await editClaim(claim.id, employeeA, {
      amountKes: "2,000",
      mpesaCode: "QWE1RTY2UI",
    });

    // #then
    expect(response.status).toBe(200);
    expect(claimDetailSchema.parse(await dataOf(response))).toMatchObject({
      status: "submitted",
      amountKes: "200000",
      mpesaCode: "QWE1RTY2UI",
      merchant: "Java House Westlands",
    });
    const [, edited] = await auditEntries(claim.id);
    expect(edited).toEqual({
      action: "expense.edited",
      actor_id: employeeA.id,
      before: { amountKes: "150050", mpesaCode: null },
      after: { amountKes: "200000", mpesaCode: "QWE1RTY2UI" },
    });
  });

  it("clears an optional field sent as null", async () => {
    // #given
    const claim = await submitted(employeeA, { mpesaCode: "SLK4H7Q2XY" });

    // #when
    const response = await editClaim(claim.id, employeeA, { mpesaCode: null });

    // #then
    expect(
      claimDetailSchema.parse(await dataOf(response)).mpesaCode,
    ).toBeNull();
  });

  it("resubmits a rejected claim, keeping the reason in the audit log", async () => {
    // #given
    const claim = await submitted(employeeA);
    await setStatus(claim.id, "rejected", "Receipt is unreadable");

    // #when
    const response = await editClaim(claim.id, employeeA, {
      description: "Lunch with Acme, receipt retaken",
    });

    // #then
    expect(response.status).toBe(200);
    expect(claimDetailSchema.parse(await dataOf(response))).toMatchObject({
      status: "submitted",
      rejectedReason: null,
      description: "Lunch with Acme, receipt retaken",
    });
    const [, resubmitted] = await auditEntries(claim.id);
    expect(resubmitted).toMatchObject({
      action: "expense.resubmitted",
      before: { status: "rejected", rejectedReason: "Receipt is unreadable" },
      after: { status: "submitted" },
    });
  });

  it("swaps the receipt, leaving the old file free to use again", async () => {
    // #given
    const claim = await submitted(employeeA);
    const before = claimDetailSchema.parse(
      await dataOf(await getClaim(claim.id, employeeA)),
    );
    const replacement = await uploadReceipt(app, storage, company, employeeA);

    // #when
    const response = await editClaim(claim.id, employeeA, {
      receiptFileIds: [replacement.receiptFileId],
    });

    // #then
    expect(response.status).toBe(200);
    const detail = claimDetailSchema.parse(await dataOf(response));
    expect(detail.receipts.map((receipt) => receipt.id)).toEqual([
      replacement.receiptFileId,
    ]);
    const [old] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ expenseId: receiptFiles.expenseId })
          .from(receiptFiles)
          .where(eq(receiptFiles.id, before.receipts[0]?.id ?? "")),
    );
    expect(old?.expenseId).toBeNull();
  });

  it("hides another employee's claim from editing", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await editClaim(claim.id, employeeB, { merchant: "Mine" });

    // #then
    expect(response.status).toBe(404);
  });

  it("doesn't let an admin edit someone else's claim", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await editClaim(claim.id, company.admin, {
      merchant: "Changed",
    });

    // #then
    expect(response.status).toBe(403);
  });

  it.each(["paying", "paid", "payout_failed"] as const)(
    "refuses an edit once the claim is %s",
    async (status) => {
      // #given
      const claim = await submitted(employeeA);
      await setStatus(claim.id, status);

      // #when
      const response = await editClaim(claim.id, employeeA, {
        merchant: "Changed",
      });

      // #then
      expect(response.status).toBe(409);
    },
  );

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(`${claimsPath()}/${randomUUID()}`, {
      method: "PATCH",
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/claims/${randomUUID()}`,
      init: {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ merchant: "Changed" }),
      },
    }));
  });
});

describe("expenses table", () => {
  it("is isolated between companies", async () => {
    // #given
    const categoryA = await addCategory(db, fixture.companyA, "Meals");
    const categoryB = await addCategory(db, fixture.companyB, "Meals");
    await submitted(
      fixture.companyA.admin,
      { categoryId: categoryA },
      fixture.companyA,
    );
    await submitted(
      fixture.companyB.admin,
      { categoryId: categoryB },
      fixture.companyB,
    );

    // #then
    await expectTableIsolation(fixture, "expenses");
  });

  it("refuses a membership from another company", async () => {
    // #given
    const other = await createCompany(db);

    // #when
    const attempt = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx.insert(expenses).values({
          organizationId: company.organizationId,
          membershipId: other.adminMembershipId,
          kind: "claim",
          overviewHeading: "petty_cash",
          categoryId: mealsId,
          merchant: "Shop",
          amountKes: 100n,
          spentOn: "2026-10-01",
          status: "submitted",
        }),
    );

    // #then
    await expect(attempt).rejects.toMatchObject({
      cause: { constraint: "expenses_membership_organization_fk" },
    });
  });
});
