import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  ClaimDetail,
  SubmitClaimRequest,
  UpdateClaimRequest,
} from "@expendi-business/shared";
import {
  claimDetailSchema,
  organizationResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { expenses, organizations } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import {
  addCategory,
  claimRequest,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;

let company: TestCompany;
let employee: TestUser;
let mealsId: string;
let airTravelId: string;

const ETIMS_QR =
  "https://etims.kra.go.ke/common/link/etims/receipt/indexEtimsReceiptData?Data=P051234567X00ABCDEF0123456789";
const TIMS_QR =
  "https://itax.kra.go.ke/KRA-Portal/invoiceChk.htm?actionCode=loadPage&invoiceNo=0110600190000154458";

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
});

beforeEach(async () => {
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  await addMember(db, company, employee);
  [mealsId, airTravelId] = await Promise.all([
    addCategory(db, company, "Meals & entertainment"),
    addCategory(db, company, "Air travel", { etimsNotRequired: true }),
  ]);
});

afterAll(async () => {
  await runtime.dispose();
});

const claimsPath = () => `/organizations/${company.organizationId}/claims`;

async function submit(
  overrides: Partial<SubmitClaimRequest> = {},
): Promise<Response> {
  const upload = await uploadReceipt(app, storage, company, employee);
  return sendJson(app, claimsPath(), employee, {
    method: "POST",
    body: claimRequest({
      receiptFileIds: [upload.receiptFileId],
      categoryId: mealsId,
      ...overrides,
    }),
  });
}

async function claimFrom(response: Response): Promise<ClaimDetail> {
  expect(response.status).toBeLessThan(300);
  const { data } = (await response.json()) as { data: unknown };
  return claimDetailSchema.parse(data);
}

const edit = (claimId: string, body: UpdateClaimRequest) =>
  sendJson(app, `${claimsPath()}/${claimId}`, employee, {
    method: "PATCH",
    body,
  });

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

describe("claims with an eTIMS QR", () => {
  it("keeps the payload and takes the supplier's PIN from an eTIMS QR", async () => {
    // #when
    const claim = await claimFrom(
      await submit({
        etimsQrPayload: ETIMS_QR,
        etimsInvoiceNumber: "KRACU0100000001/123",
      }),
    );

    // #then
    expect(claim).toMatchObject({
      etimsQrPayload: ETIMS_QR,
      etimsSupplierPin: "P051234567X",
      etimsInvoiceNumber: "KRACU0100000001/123",
      etimsStatus: "attached",
    });
  });

  it("leaves eTIMS at none when the eTIMS QR is scanned but no invoice number is typed", async () => {
    // #when
    const claim = await claimFrom(await submit({ etimsQrPayload: ETIMS_QR }));

    // #then
    expect(claim).toMatchObject({
      etimsSupplierPin: "P051234567X",
      etimsInvoiceNumber: null,
      etimsStatus: "none",
    });
  });

  it("takes the invoice number from a TIMS QR", async () => {
    // #when
    const claim = await claimFrom(await submit({ etimsQrPayload: TIMS_QR }));

    // #then
    expect(claim).toMatchObject({
      etimsInvoiceNumber: "0110600190000154458",
      etimsStatus: "attached",
    });
  });

  it("refuses a typed invoice number that contradicts the QR", async () => {
    // #when
    const response = await submit({
      etimsQrPayload: TIMS_QR,
      etimsInvoiceNumber: "0110600190000154459",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toBe(
      "The eTIMS invoice number doesn't match the QR code you scanned, which says 0110600190000154458.",
    );
  });

  it("refuses a typed supplier PIN that contradicts the QR", async () => {
    // #when
    const response = await submit({
      etimsQrPayload: ETIMS_QR,
      etimsSupplierPin: "P099999999Z",
    });

    // #then
    expect(response.status).toBe(400);
  });

  it("keeps an unrecognised payload as scanned and takes the typed number", async () => {
    // #given
    const payload = "https://etims.ke/r/clno9s9zb02fqs601u5i79a06/v5241554";

    // #when
    const claim = await claimFrom(
      await submit({
        etimsQrPayload: payload,
        etimsInvoiceNumber: "kracu0100000001/124",
      }),
    );

    // #then
    expect(claim).toMatchObject({
      etimsQrPayload: payload,
      etimsInvoiceNumber: "KRACU0100000001/124",
      etimsSupplierPin: null,
      etimsStatus: "attached",
    });
  });

  it("refuses a payload over 2 KB", async () => {
    // #when
    const response = await submit({ etimsQrPayload: "a".repeat(2049) });

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain("too long");
  });
});

describe("etims_status", () => {
  it.each([
    [
      "attached",
      "an invoice number",
      { etimsInvoiceNumber: "KRACU1/1" },
      "meals",
    ],
    ["none", "no invoice in a normal category", {}, "meals"],
    ["not_required", "no invoice in an exempt category", {}, "air"],
    [
      "attached",
      "an invoice in an exempt category",
      { etimsInvoiceNumber: "KRACU1/2" },
      "air",
    ],
  ] as const)("is %s for %s", async (expected, _case, overrides, category) => {
    // #when
    const claim = await claimFrom(
      await submit({
        ...overrides,
        categoryId: category === "air" ? airTravelId : mealsId,
      }),
    );

    // #then
    expect(claim.etimsStatus).toBe(expected);
  });

  it("moves to not_required when an edit picks an exempt category", async () => {
    // #given
    const claim = await claimFrom(await submit());

    // #when
    const edited = await claimFrom(
      await edit(claim.id, { categoryId: airTravelId }),
    );

    // #then
    expect(edited.etimsStatus).toBe("not_required");
  });

  it("moves to attached when an edit adds a scanned TIMS QR", async () => {
    // #given
    const claim = await claimFrom(await submit());

    // #when
    const edited = await claimFrom(
      await edit(claim.id, { etimsQrPayload: TIMS_QR }),
    );

    // #then
    expect(edited).toMatchObject({
      etimsInvoiceNumber: "0110600190000154458",
      etimsStatus: "attached",
    });
  });

  it("stores the status on the expense row", async () => {
    // #given
    const claim = await claimFrom(await submit({ categoryId: airTravelId }));

    // #when
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ etimsStatus: expenses.etimsStatus })
          .from(expenses)
          .where(eq(expenses.id, claim.id)),
    );

    // #then
    expect(row?.etimsStatus).toBe("not_required");
  });
});

describe("the company's KRA PIN", () => {
  it("is visible to an employee, for the till", async () => {
    // #given
    await runInScope(db, { organizationId: company.organizationId }, (tx) =>
      tx
        .update(organizations)
        .set({ kraPin: "P051234567X" })
        .where(eq(organizations.id, company.organizationId)),
    );

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}`,
      employee,
    );

    // #then
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as { data: unknown };
    expect(organizationResponseSchema.parse(data)).toMatchObject({
      kraPin: "P051234567X",
      role: "employee",
    });
  });
});
