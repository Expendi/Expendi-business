import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ReceiptExtractionResponse } from "@expendi-business/shared";
import { receiptExtractionResponseSchema } from "@expendi-business/shared";

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
  buyGoodsSms,
  claimRequest,
  pasteSms,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import {
  FAKE_RECEIPT_FIELDS,
  makeFakeFileStorage,
  makeFakeReceiptExtractor,
} from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const storage = makeFakeFileStorage();
const extractor = makeFakeReceiptExtractor();
let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;

let company: TestCompany;
let employeeA: TestUser;
let employeeB: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({
    fileStorage: storage.layer,
    receiptExtractor: extractor.layer,
  });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
});

beforeEach(async () => {
  storage.state.reset();
  extractor.state.reset();
  company = await createCompany(db, "Acme Logistics");
  [employeeA, employeeB] = await Promise.all([createUser(db), createUser(db)]);
  await Promise.all([
    addMember(db, company, employeeA),
    addMember(db, company, employeeB),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await runtime.dispose();
});

const extractPath = (receiptFileId: string, target: TestCompany = company) =>
  `/organizations/${target.organizationId}/receipts/${receiptFileId}/extract`;

const extract = (receiptFileId: string, user: TestUser = employeeA) =>
  sendJson(app, extractPath(receiptFileId), user, { method: "POST" });

async function extracted(
  receiptFileId: string,
  user: TestUser = employeeA,
): Promise<ReceiptExtractionResponse> {
  const response = await extract(receiptFileId, user);
  expect(response.status).toBe(200);
  const { data } = (await response.json()) as { data: unknown };
  return receiptExtractionResponseSchema.parse(data);
}

const keptExtraction = async (receiptFileId: string) => {
  const [row] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .select({ extraction: receiptFiles.extraction })
        .from(receiptFiles)
        .where(eq(receiptFiles.id, receiptFileId)),
  );
  return row?.extraction;
};

describe("POST /organizations/:organizationId/receipts/:receiptFileId/extract", () => {
  it("returns what was read, as claim fields, for the uploader to check", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    extractor.state.nextRead({
      ...FAKE_RECEIPT_FIELDS,
      mpesaCode: "SLK4H7Q2XY",
      supplierKraPin: "P051234567X",
      etimsInvoiceNumber: "KRACU0100000001/123",
      confidence: {
        ...FAKE_RECEIPT_FIELDS.confidence,
        merchant: "low",
        mpesaCode: "high",
        supplierKraPin: "low",
        etimsInvoiceNumber: "high",
      },
    });

    // #when
    const result = await extracted(upload.receiptFileId);

    // #then
    expect(result).toEqual({
      status: "read",
      fields: {
        merchant: "Naivas Supermarket",
        amountKes: "123450",
        spentOn: "2026-10-30",
        mpesaCode: "SLK4H7Q2XY",
        etimsInvoiceNumber: "KRACU0100000001/123",
        etimsSupplierPin: "P051234567X",
      },
      lowConfidence: ["merchant", "etimsSupplierPin"],
      amountNotInKes: false,
    });
    expect(extractor.state.calls).toEqual([
      { mediaType: "image/jpeg", byteLength: 180_000 },
    ]);
  });

  it("leaves out an amount in another currency", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    extractor.state.nextRead({ ...FAKE_RECEIPT_FIELDS, currency: "USD" }, [
      "currency_not_kes",
    ]);

    // #when
    const result = await extracted(upload.receiptFileId);

    // #then
    expect(result).toMatchObject({
      status: "read",
      fields: { amountKes: null },
      amountNotInKes: true,
    });
  });

  it("answers unreadable when Claude can't read the image", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    extractor.state.nextUnreadable("illegible");

    // #when
    const result = await extracted(upload.receiptFileId);

    // #then
    expect(result).toEqual({ status: "unreadable" });
  });

  it.each(["UNAVAILABLE", "TIMEOUT", "RATE_LIMITED", "API_ERROR"] as const)(
    "answers unreadable when reading fails with %s",
    async (code) => {
      // #given
      const upload = await uploadReceipt(app, storage, company, employeeA);
      extractor.state.failNext(code);

      // #when
      const result = await extracted(upload.receiptFileId);

      // #then
      expect(result).toEqual({ status: "unreadable" });
    },
  );

  it("answers unreadable, and logs it, when receipt reading isn't configured", async () => {
    // #given
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload = await uploadReceipt(app, storage, company, employeeA);
    extractor.state.failNext("NOT_CONFIGURED");

    // #when
    const result = await extracted(upload.receiptFileId);

    // #then
    expect(result).toEqual({ status: "unreadable" });
    expect(warn).toHaveBeenCalledWith(
      `[receipts] receipt ${upload.receiptFileId} not read: NOT_CONFIGURED`,
    );
  });

  it("answers unreadable when storage is down", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const upload = await uploadReceipt(app, storage, company, employeeA);
    storage.state.failGets = true;

    // #when
    const result = await extracted(upload.receiptFileId);

    // #then
    expect(result).toEqual({ status: "unreadable" });
  });

  it("answers 413 when the image is too large to read", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    extractor.state.failNext("IMAGE_TOO_LARGE");

    // #when
    const response = await extract(upload.receiptFileId);

    // #then
    expect(response.status).toBe(413);
  });

  it("answers 413 for an upload over the reading limit without fetching it", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA, {
      byteSize: 6 * 1024 * 1024,
    });

    // #when
    const response = await extract(upload.receiptFileId);

    // #then
    expect(response.status).toBe(413);
    expect(extractor.state.calls).toEqual([]);
  });

  it("keeps the raw result on the file and doesn't read the same image twice", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeA);
    const first = await extracted(upload.receiptFileId);

    // #when
    const second = await extracted(upload.receiptFileId);

    // #then
    expect(second).toEqual(first);
    expect(extractor.state.calls).toHaveLength(1);
    expect(await keptExtraction(upload.receiptFileId)).toMatchObject({
      status: "read",
      raw: { model: "fake-receipt-model", stopReason: "end_turn" },
    });
  });

  it("hides another person's upload, even from an admin", async () => {
    // #given
    const upload = await uploadReceipt(app, storage, company, employeeB);

    // #when
    const asEmployee = await extract(upload.receiptFileId, employeeA);
    const asAdmin = await extract(upload.receiptFileId, company.admin);

    // #then
    expect([asEmployee.status, asAdmin.status]).toEqual([404, 404]);
    expect(extractor.state.calls).toEqual([]);
  });

  it("answers 404 for an unknown or malformed ID", async () => {
    // #when
    const unknown = await extract(randomUUID());
    const malformed = await extract("not-an-id");

    // #then
    expect([unknown.status, malformed.status]).toEqual([404, 404]);
  });

  it("refuses a pasted SMS, which is read when it's pasted", async () => {
    // #given
    const sms = await pasteSms(app, company, employeeA, buyGoodsSms());

    // #when
    const response = await extract(sms.receiptFileId);

    // #then
    expect(response.status).toBe(400);
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(extractPath(randomUUID()), {
      method: "POST",
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/receipts/${randomUUID()}/extract`,
      init: { method: "POST" },
    }));
  });
});

describe("a claim made from a read receipt", () => {
  it("keeps what reading returned in the claim's extraction", async () => {
    // #given
    const mealsId = await addCategory(db, company, "Meals");
    const upload = await uploadReceipt(app, storage, company, employeeA);
    await extracted(upload.receiptFileId);

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employeeA,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [upload.receiptFileId],
          categoryId: mealsId,
          amountKes: "1,234.50",
        }),
      },
    );

    // #then
    expect(response.status).toBe(201);
    const { data } = (await response.json()) as { data: { id: string } };
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ extraction: expenses.extraction, status: expenses.status })
          .from(expenses)
          .where(eq(expenses.id, data.id)),
    );
    expect(row).toMatchObject({
      status: "submitted",
      extraction: {
        receipts: [
          {
            receiptFileId: upload.receiptFileId,
            result: {
              status: "read",
              fields: { merchant: "Naivas Supermarket", amountCents: "123450" },
              raw: { model: "fake-receipt-model" },
            },
          },
        ],
      },
    });
  });

  it("takes the new receipt's extraction when an edit swaps the receipt", async () => {
    // #given
    const mealsId = await addCategory(db, company, "Meals");
    const first = await uploadReceipt(app, storage, company, employeeA);
    const created = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employeeA,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [first.receiptFileId],
          categoryId: mealsId,
        }),
      },
    );
    const { data } = (await created.json()) as { data: { id: string } };
    const retaken = await uploadReceipt(app, storage, company, employeeA);
    await extracted(retaken.receiptFileId);

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims/${data.id}`,
      employeeA,
      { method: "PATCH", body: { receiptFileIds: [retaken.receiptFileId] } },
    );

    // #then
    expect(response.status).toBe(200);
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ extraction: expenses.extraction })
          .from(expenses)
          .where(eq(expenses.id, data.id)),
    );
    expect(row?.extraction).toMatchObject({
      receipts: [{ receiptFileId: retaken.receiptFileId }],
    });
  });

  it("has no extraction when no receipt was read", async () => {
    // #given
    const mealsId = await addCategory(db, company, "Meals");
    const upload = await uploadReceipt(app, storage, company, employeeA);

    // #when
    const response = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employeeA,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [upload.receiptFileId],
          categoryId: mealsId,
        }),
      },
    );

    // #then
    const { data } = (await response.json()) as { data: { id: string } };
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select({ extraction: expenses.extraction })
          .from(expenses)
          .where(eq(expenses.id, data.id)),
    );
    expect(row?.extraction).toBeNull();
  });
});
