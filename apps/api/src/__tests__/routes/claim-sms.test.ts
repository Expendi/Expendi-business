import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SubmitClaimRequest } from "@expendi-business/shared";
import { claimDetailSchema } from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { AppRuntime } from "../../runtime.js";
import type { TestCompany, TestUser } from "../helpers/db.js";
import type { IsolationFixture } from "../helpers/isolation.js";
import { createApp } from "../../app.js";
import { DatabaseService } from "../../db/client.js";
import { receiptFiles } from "../../db/schema/index.js";
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
import { makeFakeFileStorage } from "../helpers/fakes.js";
import {
  createIsolationFixture,
  expectRouteIsolation,
} from "../helpers/isolation.js";
import { makeTestRuntime } from "../helpers/runtime.js";

const storage = makeFakeFileStorage();
let runtime: AppRuntime;
let db: Database;
let app: App;
let fixture: IsolationFixture;

let company: TestCompany;
let employeeA: TestUser;
let employeeB: TestUser;
let mealsId: string;

beforeAll(async () => {
  runtime = makeTestRuntime({ fileStorage: storage.layer });
  ({ db } = await runtime.runPromise(DatabaseService));
  app = createApp({ runtime });
  fixture = await createIsolationFixture(db);
});

beforeEach(async () => {
  storage.state.reset();
  company = await createCompany(db, "Acme Logistics");
  [employeeA, employeeB] = await Promise.all([createUser(db), createUser(db)]);
  await Promise.all([
    addMember(db, company, employeeA),
    addMember(db, company, employeeB),
  ]);
  mealsId = await addCategory(db, company, "Meals & entertainment");
});

afterAll(async () => {
  await runtime.dispose();
});

const smsPath = (target: TestCompany = company) =>
  `/organizations/${target.organizationId}/receipts/sms`;
const claimsPath = () => `/organizations/${company.organizationId}/claims`;

const postSms = (user: TestUser, text: string) =>
  sendJson(app, smsPath(), user, { method: "POST", body: { text } });

async function submitWithSms(
  user: TestUser,
  text: string,
  overrides: Partial<SubmitClaimRequest> = {},
): Promise<Response> {
  const sms = await pasteSms(app, company, user, text);
  return sendJson(app, claimsPath(), user, {
    method: "POST",
    body: claimRequest({
      receiptFileIds: [sms.receiptFileId],
      categoryId: mealsId,
      ...overrides,
    }),
  });
}

async function errorMessage(response: Response): Promise<string> {
  const body = (await response.json()) as { error: { message: string } };
  return body.error.message;
}

describe("POST /organizations/:organizationId/receipts/sms", () => {
  it("keeps a pasted M-Pesa SMS as a pending receipt and returns what it read", async () => {
    // #when
    const sms = await pasteSms(
      app,
      company,
      employeeA,
      `  ${buyGoodsSms()}\n\n`,
    );

    // #then
    expect(sms.sms).toEqual({
      kind: "buy_goods",
      code: "SKL3ABCDEF",
      amountKesCents: "150050",
      counterparty: "NAIVAS SUPERMARKET",
      occurredAt: "2026-10-15T14:15:00+03:00",
    });
    const [row] = await runInScope(
      db,
      { organizationId: company.organizationId },
      (tx) =>
        tx
          .select()
          .from(receiptFiles)
          .where(eq(receiptFiles.id, sms.receiptFileId)),
    );
    expect(row).toMatchObject({
      kind: "sms_text",
      storageKey: null,
      smsText: buyGoodsSms(),
      expenseId: null,
      uploadedBy: employeeA.id,
      contentType: "text/plain; charset=utf-8",
    });
  });

  it("refuses text that isn't an M-Pesa payment, so the app falls back to manual entry", async () => {
    // #when
    const response = await postSms(employeeA, "Hi, lunch was 1500 at Java");

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain("Couldn't read this SMS");
  });

  it("returns the same receipt when the caller pastes their unused SMS again", async () => {
    // #given
    const first = await pasteSms(app, company, employeeA, buyGoodsSms());

    // #when
    const again = await pasteSms(
      app,
      company,
      employeeA,
      buyGoodsSms().replaceAll(" ", "  "),
    );

    // #then
    expect(again.receiptFileId).toBe(first.receiptFileId);
  });

  it("refuses an SMS someone else in the company already pasted", async () => {
    // #given
    await pasteSms(app, company, employeeB, buyGoodsSms());

    // #when
    const response = await postSms(employeeA, buyGoodsSms());

    // #then
    expect(response.status).toBe(409);
  });

  it("needs a signed-in caller", async () => {
    // #when
    const response = await app.request(smsPath(), { method: "POST" });

    // #then
    expect(response.status).toBe(401);
  });

  it("is isolated between companies", async () => {
    await expectRouteIsolation(app, fixture, (organizationId) => ({
      path: `/organizations/${organizationId}/receipts/sms`,
      init: {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: "" }),
      },
    }));
  });
});

describe("claims with a pasted SMS", () => {
  it("submits a claim whose only evidence is the SMS, taking its M-Pesa code", async () => {
    // #when
    const response = await submitWithSms(employeeA, buyGoodsSms(), {
      mpesaCode: null,
    });

    // #then
    expect(response.status).toBe(201);
    const claim = claimDetailSchema.parse(
      ((await response.json()) as { data: unknown }).data,
    );
    expect(claim).toMatchObject({
      mpesaCode: "SKL3ABCDEF",
      amountKes: "150050",
      receipts: [{ kind: "sms_text", text: buyGoodsSms() }],
    });
  });

  it("refuses a claim whose amount contradicts the SMS", async () => {
    // #when
    const response = await submitWithSms(employeeA, buyGoodsSms(), {
      amountKes: "1,600",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toBe(
      "The amount doesn't match the SMS you attached, which says KES 1,500.50.",
    );
  });

  it("refuses a claim whose M-Pesa code contradicts the SMS", async () => {
    // #when
    const response = await submitWithSms(employeeA, buyGoodsSms(), {
      mpesaCode: "QWE1RTY2UI",
    });

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toContain("which says SKL3ABCDEF");
  });

  it("accepts an SMS next to a photo", async () => {
    // #given
    const photo = await uploadReceipt(app, storage, company, employeeA);
    const sms = await pasteSms(app, company, employeeA, buyGoodsSms());

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [photo.receiptFileId, sms.receiptFileId],
        categoryId: mealsId,
      }),
    });

    // #then
    expect(response.status).toBe(201);
  });

  it("refuses two SMS on one claim", async () => {
    // #given
    const first = await pasteSms(app, company, employeeA, buyGoodsSms());
    const second = await pasteSms(
      app,
      company,
      employeeA,
      buyGoodsSms({ code: "TB71XY9Z2Q" }),
    );

    // #when
    const response = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [first.receiptFileId, second.receiptFileId],
        categoryId: mealsId,
      }),
    });

    // #then
    expect(response.status).toBe(400);
    expect(await errorMessage(response)).toBe(
      "Attach one M-Pesa SMS per claim.",
    );
  });

  it("refuses an edit that makes the amount contradict the attached SMS", async () => {
    // #given
    const created = await submitWithSms(employeeA, buyGoodsSms());
    const { data } = (await created.json()) as { data: { id: string } };

    // #when
    const response = await sendJson(
      app,
      `${claimsPath()}/${data.id}`,
      employeeA,
      {
        method: "PATCH",
        body: { amountKes: "2,000" },
      },
    );

    // #then
    expect(response.status).toBe(400);
  });

  it("refuses an edit that attaches an SMS contradicting the claim", async () => {
    // #given
    const photo = await uploadReceipt(app, storage, company, employeeA);
    const created = await sendJson(app, claimsPath(), employeeA, {
      method: "POST",
      body: claimRequest({
        receiptFileIds: [photo.receiptFileId],
        categoryId: mealsId,
        amountKes: "999",
      }),
    });
    const { data } = (await created.json()) as { data: { id: string } };
    const sms = await pasteSms(app, company, employeeA, buyGoodsSms());

    // #when
    const response = await sendJson(
      app,
      `${claimsPath()}/${data.id}`,
      employeeA,
      {
        method: "PATCH",
        body: { receiptFileIds: [photo.receiptFileId, sms.receiptFileId] },
      },
    );

    // #then
    expect(response.status).toBe(400);
  });
});
