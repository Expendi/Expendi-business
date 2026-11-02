import { randomBytes } from "node:crypto";

import type {
  ReceiptSmsResponse,
  ReceiptUploadRequest,
  ReceiptUploadResponse,
  SubmitClaimRequest,
} from "@expendi-business/shared";
import {
  receiptSmsResponseSchema,
  receiptUploadResponseSchema,
} from "@expendi-business/shared";

import type { App } from "../../app.js";
import type { Database } from "../../db/client.js";
import type { TestCompany, TestUser } from "./db.js";
import type { makeFakeFileStorage } from "./fakes.js";
import { categories } from "../../db/schema/index.js";
import { runInScope } from "../../db/scope.js";
import { bearer } from "./runtime.js";

type FakeFileStorage = ReturnType<typeof makeFakeFileStorage>;

export const randomSha256 = (): string => randomBytes(32).toString("hex");

export async function addCategory(
  db: Database,
  company: TestCompany,
  name: string,
  options: { etimsNotRequired?: boolean; archived?: boolean } = {},
): Promise<string> {
  const [category] = await runInScope(
    db,
    { organizationId: company.organizationId },
    (tx) =>
      tx
        .insert(categories)
        .values({ organizationId: company.organizationId, name, ...options })
        .returning({ id: categories.id }),
  );
  if (!category) throw new Error("category insert returned no row");
  return category.id;
}

export function sendJson(
  app: App,
  path: string,
  user: Pick<TestUser, "privyUserId">,
  init: { method?: string; body?: unknown } = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(path, {
      method: init.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...bearer(user.privyUserId),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
}

/** Asks for an upload URL, then "uploads" the file to the fake storage. */
export async function uploadReceipt(
  app: App,
  storage: FakeFileStorage,
  company: TestCompany,
  user: Pick<TestUser, "privyUserId">,
  request: Partial<ReceiptUploadRequest> = {},
): Promise<ReceiptUploadResponse> {
  const body = {
    contentType: "image/jpeg",
    byteSize: 180_000,
    sha256: randomSha256(),
    ...request,
  } satisfies ReceiptUploadRequest;
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/receipts/upload-url`,
    user,
    { method: "POST", body },
  );
  if (response.status !== 201) {
    throw new Error(`upload-url answered ${response.status}`);
  }
  const { data } = (await response.json()) as { data: unknown };
  const upload = receiptUploadResponseSchema.parse(data);
  storage.state.put(upload.storageKey, body.byteSize, body.contentType);
  return upload;
}

export function claimRequest(
  overrides: Partial<SubmitClaimRequest> &
    Pick<SubmitClaimRequest, "receiptFileIds" | "categoryId">,
): SubmitClaimRequest {
  return {
    merchant: "Java House Westlands",
    amountKes: "1,500.50",
    spentOn: "2026-10-15",
    description: "Lunch with the Acme team",
    ...overrides,
  };
}

/** A Buy Goods confirmation in Safaricom's wording; the values are invented. */
export function buyGoodsSms({
  code = "SKL3ABCDEF",
  amount = "1,500.50",
  merchant = "NAIVAS SUPERMARKET",
  date = "15/10/26",
}: {
  code?: string;
  amount?: string;
  merchant?: string;
  date?: string;
} = {}): string {
  return `${code} Confirmed. Ksh${amount} paid to ${merchant}. on ${date} at 2:15 PM.New M-PESA balance is Ksh3,250.40. Transaction cost, Ksh0.00.`;
}

export async function pasteSms(
  app: App,
  company: TestCompany,
  user: Pick<TestUser, "privyUserId">,
  text: string,
): Promise<ReceiptSmsResponse> {
  const response = await sendJson(
    app,
    `/organizations/${company.organizationId}/receipts/sms`,
    user,
    { method: "POST", body: { text } },
  );
  if (response.status !== 201) {
    throw new Error(`receipts/sms answered ${response.status}`);
  }
  const { data } = (await response.json()) as { data: unknown };
  return receiptSmsResponseSchema.parse(data);
}
