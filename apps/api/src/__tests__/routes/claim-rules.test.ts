import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ClaimDetail,
  ExpenseStatus,
  SubmitClaimRequest,
  UpdateClaimRequest,
} from "@expendi-business/shared";
import {
  claimDetailSchema,
  claimsPageSchema,
  duplicateOfSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { nairobiToday } from "../../services/expenses/rules.js";
import {
  addCategory,
  buyGoodsSms,
  claimRequest,
  pasteSms,
  randomSha256,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";
import { TEST_DATABASE_URL_MIGRATE } from "../setup/test-database.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let owner: pg.Pool;

let company: TestCompany;
let employeeA: TestUser;
let employeeB: TestUser;
let employeeAMembershipId: string;
let employeeBMembershipId: string;
let mealsId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  owner = new pg.Pool({ connectionString: TEST_DATABASE_URL_MIGRATE, max: 1 });
});

beforeEach(async () => {
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  [employeeA, employeeB] = await Promise.all([createUser(db), createUser(db)]);
  [employeeAMembershipId, employeeBMembershipId] = await Promise.all([
    addMember(db, company, employeeA),
    addMember(db, company, employeeB),
  ]);
  mealsId = await addCategory(db, company, "Meals & entertainment");
});

afterAll(async () => {
  await Promise.all([runtime.dispose(), owner.end()]);
});

const DAY_MS = 24 * 60 * 60 * 1000;
const TODAY = nairobiToday();
/** A Nairobi calendar day `days` from today; negative is in the past. */
const day = (days: number): string =>
  new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
const D = day(-10);

const claimsPath = () => `/organizations/${company.organizationId}/claims`;

async function submitAs(
  user: TestUser,
  overrides: Partial<SubmitClaimRequest> = {},
): Promise<Response> {
  const upload = await uploadReceipt(app, storage, company, user);
  return sendJson(app, claimsPath(), user, {
    method: "POST",
    body: claimRequest({
      receiptFileIds: [upload.receiptFileId],
      categoryId: mealsId,
      spentOn: D,
      ...overrides,
    }),
  });
}

async function submitted(
  user: TestUser,
  overrides: Partial<SubmitClaimRequest> = {},
): Promise<ClaimDetail> {
  const response = await submitAs(user, overrides);
  expect(response.status).toBe(201);
  const { data } = (await response.json()) as { data: unknown };
  return claimDetailSchema.parse(data);
}

const edit = (claimId: string, user: TestUser, body: UpdateClaimRequest) =>
  sendJson(app, `${claimsPath()}/${claimId}`, user, { method: "PATCH", body });

async function seenBy(user: TestUser, claimId: string): Promise<ClaimDetail> {
  const response = await sendJson(app, `${claimsPath()}/${claimId}`, user);
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: unknown };
  return claimDetailSchema.parse(data);
}

async function conflictOf(response: Response) {
  expect(response.status).toBe(409);
  const body = (await response.json()) as {
    error: { message: string; details?: { duplicateOf?: unknown } };
  };
  return {
    message: body.error.message,
    duplicateOf: duplicateOfSchema.parse(body.error.details?.duplicateOf),
  };
}

/** History as the spreadsheet import (T25) will write it: same table, `source='import'`. */
async function importExpense(values: {
  membershipId: string;
  amountKes: bigint;
  spentOn: string;
  mpesaCode?: string;
  etimsInvoiceNumber?: string;
  status?: ExpenseStatus;
}): Promise<string> {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .insert(expenses)
        .values({
          organizationId: company.organizationId,
          membershipId: values.membershipId,
          kind: "claim",
          overviewHeading: "petty_cash",
          categoryId: mealsId,
          merchant: "Imported merchant",
          amountKes: values.amountKes,
          spentOn: values.spentOn,
          description: null,
          source: "import",
          status: values.status ?? "paid_outside",
          mpesaCode: values.mpesaCode ?? null,
          etimsInvoiceNumber: values.etimsInvoiceNumber ?? null,
        })
        .returning({ id: expenses.id }),
  );
  if (!row) throw new Error("import insert returned no row");
  return row.id;
}

const randomCode = (): string =>
  `S${randomBytes(5).toString("hex").slice(0, 9).toUpperCase()}`;

describe("exact duplicates are blocked, pointing at the earlier claim", () => {
  it("names the caller's own earlier claim and links to it", async () => {
    // #given
    const earlier = await submitted(employeeA, { mpesaCode: "SLK4H7Q2XY" });

    // #when
    const conflict = await conflictOf(
      await submitAs(employeeA, { mpesaCode: "SLK4H7Q2XY" }),
    );

    // #then
    expect(conflict.message).toBe(
      `This M-Pesa code is already on your claim of ${formatDay(D)} for KES 1,500.50.`,
    );
    expect(conflict.duplicateOf).toEqual({
      expenseId: earlier.id,
      kind: "claim",
      spentOn: D,
      amountKes: "150050",
      yours: true,
    });
  });

  it("says only 'another employee's claim', its date and amount, and no ID, to an employee", async () => {
    // #given
    await submitted(employeeB, { mpesaCode: "SLK4H7Q2XY", amountKes: "999" });

    // #when
    const conflict = await conflictOf(
      await submitAs(employeeA, { mpesaCode: "SLK4H7Q2XY" }),
    );

    // #then
    expect(conflict.message).toBe(
      `This M-Pesa code is already on another employee's claim of ${formatDay(D)} for KES 999.00.`,
    );
    expect(conflict.duplicateOf).toMatchObject({
      expenseId: null,
      yours: false,
    });
  });

  it("links an admin to another employee's earlier claim", async () => {
    // #given
    const earlier = await submitted(employeeB, { mpesaCode: "SLK4H7Q2XY" });

    // #when
    const conflict = await conflictOf(
      await submitAs(company.admin, { mpesaCode: "SLK4H7Q2XY" }),
    );

    // #then
    expect(conflict.duplicateOf).toMatchObject({
      expenseId: earlier.id,
      yours: false,
    });
  });

  it("blocks the same eTIMS invoice number", async () => {
    // #given
    await submitted(employeeB, { etimsInvoiceNumber: "KRACU0100000001/123" });

    // #when
    const conflict = await conflictOf(
      await submitAs(employeeA, { etimsInvoiceNumber: "kracu0100000001/123" }),
    );

    // #then
    expect(conflict.message).toContain(
      "This eTIMS invoice number is already on another employee's claim",
    );
  });

  it("blocks the same invoice number read from a scanned QR", async () => {
    // #given
    const qr =
      "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0110600190000154458";
    await submitted(employeeB, { etimsQrPayload: qr });

    // #when
    const response = await submitAs(employeeA, { etimsQrPayload: qr });

    // #then
    expect(response.status).toBe(409);
  });

  it("blocks the same photo, naming the claim it's on", async () => {
    // #given
    const sha256 = randomSha256();
    const upload = await uploadReceipt(app, storage, company, employeeB, {
      sha256,
    });
    await sendJson(app, claimsPath(), employeeB, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [upload.receiptFileId],
        categoryId: mealsId,
        spentOn: D,
      }),
    });

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}/receipts/upload-url`,
      employeeA,
      {
        method: "POST",
        body: { contentType: "image/jpeg", byteSize: 180_000, sha256 },
      },
    );

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.message).toBe(
      `This receipt is already on another employee's claim of ${formatDay(D)} for KES 1,500.50.`,
    );
  });

  it("blocks the same pasted SMS, naming the claim it's on", async () => {
    // #given
    const sms = await pasteSms(app, company, employeeA, buyGoodsSms());
    await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [sms.receiptFileId],
        categoryId: mealsId,
      }),
    });

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}/receipts/sms`,
      employeeA,
      { method: "POST", body: { text: buyGoodsSms() } },
    );

    // #then
    const conflict = await conflictOf(response);
    expect(conflict.message).toBe(
      "This M-Pesa SMS is already on your claim of 15 Oct 2026 for KES 1,500.50.",
    );
  });

  it("blocks an edit that takes another claim's code, but not the claim's own", async () => {
    // #given
    await submitted(employeeB, { mpesaCode: "QWE1RTY2UI" });
    const mine = await submitted(employeeA, { mpesaCode: "SLK4H7Q2XY" });

    // #when
    const keepsOwn = await edit(mine.id, employeeA, {
      mpesaCode: "SLK4H7Q2XY",
      merchant: "Changed",
    });
    const takesOther = await edit(mine.id, employeeA, {
      mpesaCode: "QWE1RTY2UI",
    });

    // #then
    expect(keepsOwn.status).toBe(200);
    expect((await conflictOf(takesOther)).message).toContain(
      "another employee's claim",
    );
  });
});

describe("imported history counts in the duplicate checks", () => {
  it("blocks an M-Pesa code already in imported history", async () => {
    // #given
    await importExpense({
      membershipId: employeeBMembershipId,
      amountKes: 250_000n,
      spentOn: "2026-08-01",
      mpesaCode: "TB71XY9Z2Q",
    });

    // #when
    const conflict = await conflictOf(
      await submitAs(employeeA, { mpesaCode: "TB71XY9Z2Q" }),
    );

    // #then
    expect(conflict.message).toBe(
      "This M-Pesa code is already on another employee's claim of 1 Aug 2026 for KES 2,500.00 (from the spreadsheet).",
    );
  });

  it("blocks an eTIMS invoice number already in imported history", async () => {
    // #given
    await importExpense({
      membershipId: employeeAMembershipId,
      amountKes: 250_000n,
      spentOn: "2026-08-01",
      etimsInvoiceNumber: "KRACU0100000009/9",
    });

    // #when
    const response = await submitAs(employeeA, {
      etimsInvoiceNumber: "KRACU0100000009/9",
    });

    // #then
    expect((await conflictOf(response)).duplicateOf.yours).toBe(true);
  });

  it("warns about a near-duplicate of an imported claim", async () => {
    // #given
    const imported = await importExpense({
      membershipId: employeeAMembershipId,
      amountKes: 150_050n,
      spentOn: day(-11),
    });

    // #when
    const claim = await submitted(employeeA);

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([
      {
        code: "near_duplicate",
        expenseId: imported,
        spentOn: day(-11),
        amountKes: "150050",
      },
    ]);
  });
});

describe("near-duplicate warnings", () => {
  it.each([
    ["the same day", 0, true],
    ["a day before", -1, true],
    ["a day after", 1, true],
    ["two days before", -2, false],
    ["two days after", 2, false],
  ])(
    "warns the admin about the same amount by the same employee %s: %s",
    async (_case, offset, warned) => {
      // #given
      const earlier = await submitted(employeeA, {
        spentOn: day(-10 + offset),
        mpesaCode: randomCode(),
      });

      // #when
      const claim = await submitted(employeeA, { mpesaCode: randomCode() });

      // #then
      const { warnings } = await seenBy(company.admin, claim.id);
      expect(warnings).toEqual(
        warned
          ? [
              {
                code: "near_duplicate",
                expenseId: earlier.id,
                spentOn: day(-10 + offset),
                amountKes: "150050",
              },
            ]
          : [],
      );
    },
  );

  it.each([
    ["a different amount", { amountKes: "1,500.51" }, "A"],
    ["a different employee", {}, "B"],
  ] as const)("doesn't warn about %s", async (_case, overrides, who) => {
    // #given
    await submitted(who === "B" ? employeeB : employeeA, overrides);

    // #when
    const claim = await submitted(employeeA);

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([]);
  });

  it("ignores a rejected claim", async () => {
    // #given
    const rejected = await submitted(employeeA);
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(expenses)
        .set({ status: "rejected", rejectedReason: "Duplicate" })
        .where(eq(expenses.id, rejected.id)),
    );

    // #when
    const claim = await submitted(employeeA);

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([]);
  });

  it("shows warnings only to admins, in the claim and in the list", async () => {
    // #given
    await submitted(employeeA);
    const claim = await submitted(employeeA);

    // #when
    const asEmployee = await seenBy(employeeA, claim.id);
    const listResponse = await sendJson(app, claimsPath(), company.admin);
    const { data } = (await listResponse.json()) as { data: unknown };
    const listed = claimsPageSchema
      .parse(data)
      .claims.find((row) => row.id === claim.id);

    // #then
    expect(asEmployee.warnings).toEqual([]);
    expect(listed?.warnings).toMatchObject([{ code: "near_duplicate" }]);
  });

  it("is recomputed when an edit moves the claim onto or off another", async () => {
    // #given
    await submitted(employeeA, { amountKes: "500" });
    const claim = await submitted(employeeA, { amountKes: "700" });

    // #when
    await edit(claim.id, employeeA, { amountKes: "500" });
    const onto = await seenBy(company.admin, claim.id);
    await edit(claim.id, employeeA, { spentOn: day(-20) });
    const off = await seenBy(company.admin, claim.id);

    // #then
    expect(onto.warnings).toMatchObject([{ code: "near_duplicate" }]);
    expect(off.warnings).toEqual([]);
  });

  it("keeps the change in the audit entry for the edit", async () => {
    // #given
    await submitted(employeeA, { amountKes: "500" });
    const claim = await submitted(employeeA, { amountKes: "700" });

    // #when
    await edit(claim.id, employeeA, { amountKes: "500" });

    // #then
    const { rows } = await owner.query<{ before: unknown; after: unknown }>(
      `SELECT before, after FROM audit_log
       WHERE entity_type = 'expense' AND entity_id = $1 AND action = 'expense.edited'`,
      [claim.id],
    );
    expect(rows).toMatchObject([
      {
        before: { amountKes: "70000", warnings: [] },
        after: {
          amountKes: "50000",
          warnings: [{ code: "near_duplicate" }],
        },
      },
    ]);
  });
});

describe("the 60-day warning", () => {
  it("doesn't warn about a claim exactly 60 days old", async () => {
    // #when
    const claim = await submitted(employeeA, { spentOn: day(-60) });

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([]);
  });

  it("warns about a claim 61 days old", async () => {
    // #when
    const claim = await submitted(employeeA, { spentOn: day(-61) });

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([
      { code: "older_than_60_days", spentOn: day(-61), ageDays: 61 },
    ]);
  });

  it("appears when an edit moves the date back past 60 days", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    await edit(claim.id, employeeA, { spentOn: day(-90) });

    // #then
    expect((await seenBy(company.admin, claim.id)).warnings).toEqual([
      { code: "older_than_60_days", spentOn: day(-90), ageDays: 90 },
    ]);
  });
});

describe("a receipt or SMS is required", () => {
  it("refuses a claim with none", async () => {
    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({ receiptFileIds: [], categoryId: mealsId }),
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an edit that takes every receipt off", async () => {
    // #given
    const claim = await submitted(employeeA);

    // #when
    const response = await edit(claim.id, employeeA, { receiptFileIds: [] });

    // #then
    expect(response.status).toBe(400);
  });
});

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function formatDay(isoDate: string): string {
  const [year, month, dayOfMonth] = isoDate.split("-");
  return `${Number(dayOfMonth)} ${MONTHS[Number(month) - 1]} ${year}`;
}
