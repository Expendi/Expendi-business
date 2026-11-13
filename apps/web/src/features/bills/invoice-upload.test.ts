import type { Mock } from "vitest";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiClient } from "~/lib/api";
import { createBill } from "./bills-api";
import {
  describeUploadError,
  invalidInvoiceFile,
  invalidReceiptImage,
  uploadBillFile,
  uploadReceiptImage,
} from "./invoice-upload";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const FILE_ID = "00000000-0000-4000-8000-0000000000f1";
const API = "https://api.example.com";
const UPLOAD_URL =
  "https://r2.example.com/org/receipts/invoice.pdf?X-Amz-Signature=abc";

type Fetcher = Mock<(url: string, init: RequestInit) => Promise<Response>>;

const pdfBytes = new TextEncoder().encode("%PDF-1.7 invoice INV-204");
const pdf = new File([pdfBytes], "INV-204.pdf", { type: "application/pdf" });

function jsonBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : null;
}

function client() {
  return createApiClient({
    baseUrl: API,
    getAccessToken: () => Promise.resolve("token"),
  });
}

function upload(): Response {
  return Response.json(
    {
      success: true,
      data: {
        receiptFileId: FILE_ID,
        uploadUrl: UPLOAD_URL,
        storageKey: `org/${ORG}/receipts/invoice.pdf`,
        expiresAt: "2026-11-02T09:15:00.000Z",
      },
    },
    { status: 201 },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploading an invoice PDF from the desktop", () => {
  it("asks for a signed PUT for the exact file, sends it straight to storage, then attaches it to the new bill", async () => {
    // #given
    const created = { id: "00000000-0000-4000-8000-000000000001" };
    const fetcher: Fetcher = vi.fn((url: string) =>
      Promise.resolve(
        url === UPLOAD_URL
          ? new Response(null, { status: 200 })
          : url.endsWith("/upload-url")
            ? upload()
            : Response.json({ success: true, data: created }, { status: 201 }),
      ),
    );
    vi.stubGlobal("fetch", fetcher);
    const api = client();

    // #when
    const fileId = await uploadBillFile(api, ORG, pdf);
    await createBill(api, ORG, {
      payeeId: "00000000-0000-4000-8000-000000000050",
      amountKes: "12,500.50",
      dueOn: "2026-11-30",
      categoryId: "00000000-0000-4000-8000-000000000060",
      invoiceFileIds: [fileId],
    }).catch(() => null);

    // #then
    const [requestUrl, put, createCall] = fetcher.mock.calls;
    expect({
      urls: fetcher.mock.calls.map(([url, init]) => [init.method, url]),
      uploadRequest: jsonBody(requestUrl?.[1]),
      putHeaders: put?.[1].headers,
      putBody: put?.[1].body,
      bill: jsonBody(createCall?.[1]),
    }).toEqual({
      urls: [
        ["POST", `${API}/organizations/${ORG}/bills/upload-url`],
        ["PUT", UPLOAD_URL],
        ["POST", `${API}/organizations/${ORG}/bills`],
      ],
      uploadRequest: {
        contentType: "application/pdf",
        byteSize: pdfBytes.byteLength,
        sha256: createHash("sha256").update(pdfBytes).digest("hex"),
      },
      putHeaders: { "Content-Type": "application/pdf" },
      putBody: pdf,
      bill: {
        payeeId: "00000000-0000-4000-8000-000000000050",
        amountKes: "12,500.50",
        dueOn: "2026-11-30",
        categoryId: "00000000-0000-4000-8000-000000000060",
        invoiceFileIds: [FILE_ID],
      },
    });
  });

  it("says so when storage refuses the file", async () => {
    // #given
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(
          url === UPLOAD_URL ? new Response(null, { status: 403 }) : upload(),
        ),
      ),
    );

    // #when
    const error = await uploadBillFile(client(), ORG, pdf).catch(
      (cause: unknown) => cause,
    );

    // #then
    expect(describeUploadError(error)).toBe(
      "The file didn't upload. Check your connection and try again.",
    );
  });
});

describe("invalidInvoiceFile", () => {
  it("takes PDFs and images up to 8 MB", () => {
    // #then
    expect([
      invalidInvoiceFile({ type: "application/pdf", size: 1 }),
      invalidInvoiceFile({ type: "image/jpeg", size: 1 }),
      invalidInvoiceFile({ type: "text/plain", size: 1 }),
      invalidInvoiceFile({ type: "application/pdf", size: 0 }),
      invalidInvoiceFile({ type: "application/pdf", size: 9 * 1024 * 1024 }),
    ]).toEqual([
      null,
      null,
      "Upload a PDF, or a JPEG, PNG, WebP or HEIC image.",
      "That file is empty.",
      "That file is too large. Keep it under 8 MB.",
    ]);
  });
});

describe("uploading a Card purchase's receipt from the desktop", () => {
  it("asks for a receipt upload, as the app does, and sends the image straight to storage", async () => {
    // #given
    const imageBytes = new TextEncoder().encode("jpeg receipt");
    const image = new File([imageBytes], "receipt.jpg", {
      type: "image/jpeg",
    });
    const fetcher: Fetcher = vi.fn((url: string) =>
      Promise.resolve(
        url === UPLOAD_URL ? new Response(null, { status: 200 }) : upload(),
      ),
    );
    vi.stubGlobal("fetch", fetcher);

    // #when
    const fileId = await uploadReceiptImage(client(), ORG, image);

    // #then
    expect({
      fileId,
      urls: fetcher.mock.calls.map(([url, init]) => [init.method, url]),
      uploadRequest: jsonBody(fetcher.mock.calls[0]?.[1]),
    }).toEqual({
      fileId: FILE_ID,
      urls: [
        ["POST", `${API}/organizations/${ORG}/receipts/upload-url`],
        ["PUT", UPLOAD_URL],
      ],
      uploadRequest: {
        contentType: "image/jpeg",
        byteSize: imageBytes.byteLength,
        sha256: createHash("sha256").update(imageBytes).digest("hex"),
        kind: "photo",
      },
    });
  });

  it("refuses a PDF before asking to upload it", async () => {
    // #given
    const fetcher: Fetcher = vi.fn(() => Promise.resolve(upload()));
    vi.stubGlobal("fetch", fetcher);

    // #when
    const error = await uploadReceiptImage(client(), ORG, pdf).catch(
      (cause: unknown) => cause,
    );

    // #then
    expect({
      message: describeUploadError(error),
      calls: fetcher.mock.calls.length,
      checks: [
        invalidReceiptImage({ type: "image/png", size: 1 }),
        invalidReceiptImage({ type: "image/png", size: 0 }),
      ],
    }).toEqual({
      message: "Upload a JPEG, PNG, WebP or HEIC image.",
      calls: 0,
      checks: [null, "That file is empty."],
    });
  });
});
