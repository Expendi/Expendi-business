import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { receiptUploadResponseSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { receiptFiles } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { FileStorageLive } from "../../services/storage/r2.js";
import {
  addCategory,
  claimRequest,
  randomSha256,
  sendJson,
  uploadReceipt,
} from "../helpers/claims.js";
import { addMember, createCompany, createUser } from "../helpers/db.js";
import { makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
  expectTableIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;
let company: TestCompany;
let employee: TestUser;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
});

beforeEach(async () => {
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  employee = await createUser(db);
  await addMember(db, company, employee);
});

afterAll(async () => {
  await runtime.dispose();
});

const uploadUrlPath = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/receipts/upload-url`;

const requestUpload = (
  body: unknown,
  user: Pick<TestUser, "privyUserId"> = employee,
) => sendJson(app, uploadUrlPath(), user, { method: "POST", body });

const photo = (sha256 = randomSha256()) => ({
  contentType: "image/jpeg",
  byteSize: 180_000,
  sha256,
});

describe("POST /organizations/:organizationId/receipts/upload-url", () => {
  it("signs a PUT for a file in the company's own folder", async () => {
    // #when
    const response = await requestUpload(photo());

    // #then
    expect(response.status).toBe(201);
    const { data } = (await response.json()) as { data: unknown };
    const upload = receiptUploadResponseSchema.parse(data);
    expect(upload.storageKey).toMatch(
      new RegExp(
        `^org/${company.organizationId}/receipts/[0-9a-f-]{36}\\.jpg$`,
      ),
    );
    expect(storage.state.signedUploads).toEqual([
      {
        key: upload.storageKey,
        contentType: "image/jpeg",
        byteSize: 180_000,
      },
    ]);
  });

  it("records the file as pending, uploaded by the caller", async () => {
    // #given
    const sha256 = randomSha256();

    // #when
    const upload = await uploadReceipt(app, storage, company, employee, {
      sha256,
      contentType: "image/png",
      kind: "screenshot",
    });

    // #then
    const [file] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select()
          .from(receiptFiles)
          .where(eq(receiptFiles.id, upload.receiptFileId)),
    );
    expect(file).toMatchObject({
      organizationId: company.organizationId,
      expenseId: null,
      uploadedBy: employee.id,
      kind: "screenshot",
      sha256,
      contentType: "image/png",
      byteSize: 180_000,
    });
  });

  it.each([
    [{ ...photo(), contentType: "application/pdf" }, "Upload a JPEG"],
    [{ ...photo(), byteSize: 8 * 1024 * 1024 + 1 }, "too large"],
    [{ ...photo(), byteSize: 0 }, "empty"],
    [{ ...photo(), sha256: "not-a-hash" }, "SHA-256"],
  ])("refuses %j", async (body, message) => {
    // #when
    const response = await requestUpload(body);

    // #then
    expect(response.status).toBe(400);
    expect(await response.text()).toContain(message);
  });

  it("refuses an image already on a claim in this company", async () => {
    // #given
    const sha256 = randomSha256();
    const categoryId = await addCategory(db, company, "Meals");
    const upload = await uploadReceipt(app, storage, company, employee, {
      sha256,
    });
    const submitted = await sendJson(
      app,
      `/organizations/${company.organizationId}/claims`,
      employee,
      {
        method: "POST",
        body: claimRequest({
          receiptFileIds: [upload.receiptFileId],
          categoryId,
        }),
      },
    );
    expect(submitted.status).toBe(201);

    // #when
    const response = await requestUpload(photo(sha256));

    // #then
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        _tag: "Conflict",
        message:
          "This receipt is already on your claim of 15 Oct 2026 for KES 1,500.50.",
      },
    });
  });

  it("refuses an image someone else in the company has uploaded", async () => {
    // #given
    const sha256 = randomSha256();
    await uploadReceipt(app, storage, company, company.admin, { sha256 });

    // #when
    const response = await requestUpload(photo(sha256));

    // #then
    expect(response.status).toBe(409);
  });

  it("signs again for the caller's own unused upload, e.g. after a failed submit", async () => {
    // #given
    const sha256 = randomSha256();
    const first = await uploadReceipt(app, storage, company, employee, {
      sha256,
    });

    // #when
    const response = await requestUpload(photo(sha256));

    // #then
    expect(response.status).toBe(201);
    const { data } = (await response.json()) as { data: unknown };
    expect(receiptUploadResponseSchema.parse(data)).toMatchObject({
      receiptFileId: first.receiptFileId,
      storageKey: first.storageKey,
    });
  });

  it("allows the same image in another company", async () => {
    // #given
    const sha256 = randomSha256();
    const other = await createCompany(db);
    await uploadReceipt(app, storage, other, other.admin, { sha256 });

    // #when
    const response = await requestUpload(photo(sha256));

    // #then
    expect(response.status).toBe(201);
  });

  it("answers 503 when receipt storage isn't configured, and the API still runs", async () => {
    // #given
    const unconfigured = makeTestRuntime(
      { fileStorage: FileStorageLive },
      {
        R2_ACCOUNT_ID: undefined,
        R2_ACCESS_KEY_ID: undefined,
        R2_SECRET_ACCESS_KEY: undefined,
        R2_BUCKET: undefined,
      },
    );
    const unconfiguredApp = createApp({ runtime: unconfigured });

    // #when
    const response = await sendJson(
      unconfiguredApp,
      uploadUrlPath(),
      employee,
      {
        method: "POST",
        body: photo(),
      },
    );
    await unconfigured.dispose();

    // #then
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { message: "Receipt uploads aren't set up yet" },
    });
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(uploadUrlPath(), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(photo()),
    });

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/receipts/upload-url`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(photo()),
      },
    }));
  });
});

describe("receipt_files table", () => {
  it("is isolated between companies", async () => {
    // #given
    await uploadReceipt(app, storage, fixture.companyA, fixture.companyA.admin);
    await uploadReceipt(app, storage, fixture.companyB, fixture.companyB.admin);

    // #then
    await expectTableIsolation(fixture, "receipt_files");
  });

  it("refuses a storage key outside the company's folder", async () => {
    // #given
    const other = await createCompany(db);

    // #when
    const attempt = runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx.insert(receiptFiles).values({
          organizationId: company.organizationId,
          uploadedBy: employee.id,
          storageKey: `org/${other.organizationId}/receipts/stolen.jpg`,
          kind: "photo",
          sha256: randomSha256(),
          contentType: "image/jpeg",
          byteSize: 10,
        }),
    );

    // #then
    await expect(attempt).rejects.toMatchObject({
      cause: { constraint: "receipt_files_key_in_company_folder" },
    });
  });

  it.each([
    { kind: "sms_text" as const, storageKey: null, smsText: null },
    {
      kind: "sms_text" as const,
      storageKey: "org/x/receipts/sms.txt",
      smsText: "SKL3ABCDEF Confirmed.",
    },
    { kind: "photo" as const, storageKey: null, smsText: null },
    { kind: "photo" as const, storageKey: null, smsText: "text" },
  ])(
    "keeps an SMS inline and every image in storage: refuses %j",
    async ({ kind, storageKey, smsText }) => {
      // #when
      const attempt = runInScope(
        db,
        { organizationId: company.organizationId },
        (tx) =>
          tx.insert(receiptFiles).values({
            organizationId: company.organizationId,
            uploadedBy: employee.id,
            storageKey:
              storageKey?.replace("org/x/", `org/${company.organizationId}/`) ??
              null,
            kind,
            smsText,
            sha256: randomSha256(),
            contentType: "text/plain",
            byteSize: 10,
          }),
      );

      // #then
      await expect(attempt).rejects.toMatchObject({
        cause: { constraint: "receipt_files_sms_inline" },
      });
    },
  );
});
