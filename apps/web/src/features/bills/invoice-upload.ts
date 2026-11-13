import type { BillFileType, ReceiptImageType } from "@expendi-business/shared";
import {
  BILL_FILE_TYPES,
  RECEIPT_IMAGE_TYPES,
  RECEIPT_MAX_BYTES,
  receiptUploadResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { describeApiError } from "~/lib/api";

/**
 * An invoice, or proof a bill was paid outside Expendi, from the
 * desktop: a PDF or an image, which the app can't pick (spec §6.20). The
 * API signs a PUT for the exact type and size, and the browser sends the
 * file straight to the company's storage.
 */

export const BILL_FILE_ACCEPT = BILL_FILE_TYPES.join(",");

export class InvoiceUploadError extends Error {
  override readonly name = "InvoiceUploadError";
}

const notUploaded =
  "The file didn't upload. Check your connection and try again.";

function isBillFileType(type: string): type is BillFileType {
  return BILL_FILE_TYPES.some((allowed) => allowed === type);
}

/** Why a picked file can't be uploaded, or null if it can. */
export function invalidInvoiceFile(
  file: Pick<File, "type" | "size">,
): string | null {
  if (!isBillFileType(file.type)) {
    return "Upload a PDF, or a JPEG, PNG, WebP or HEIC image.";
  }
  if (file.size === 0) return "That file is empty.";
  if (file.size > RECEIPT_MAX_BYTES) {
    return "That file is too large. Keep it under 8 MB.";
  }
  return null;
}

function toHex(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/** Hex SHA-256 of the exact bytes, for the API's duplicate check. */
export async function sha256Hex(file: Blob): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
}

/** Uploads the file and returns its id, to attach to a bill. */
export async function uploadBillFile(
  api: ApiClient,
  organizationId: string,
  file: File,
): Promise<string> {
  const invalid = invalidInvoiceFile(file);
  if (invalid !== null || !isBillFileType(file.type)) {
    throw new InvoiceUploadError(invalid ?? notUploaded);
  }
  const upload = await api.post(
    `/organizations/${organizationId}/bills/upload-url`,
    {
      contentType: file.type,
      byteSize: file.size,
      sha256: await sha256Hex(file),
    },
    receiptUploadResponseSchema,
  );
  return sendToStorage(upload, file);
}

/** A Card purchase's receipt is an image, as a claim's is; the API refuses a PDF there. */
export const RECEIPT_IMAGE_ACCEPT = RECEIPT_IMAGE_TYPES.join(",");

function isReceiptImageType(type: string): type is ReceiptImageType {
  return RECEIPT_IMAGE_TYPES.some((allowed) => allowed === type);
}

/** Why a picked file can't be a receipt, or null if it can. */
export function invalidReceiptImage(
  file: Pick<File, "type" | "size">,
): string | null {
  if (!isReceiptImageType(file.type)) {
    return "Upload a JPEG, PNG, WebP or HEIC image.";
  }
  return invalidInvoiceFile(file);
}

/** Uploads a receipt image the way the app does, and returns its id. */
export async function uploadReceiptImage(
  api: ApiClient,
  organizationId: string,
  file: File,
): Promise<string> {
  const invalid = invalidReceiptImage(file);
  if (invalid !== null || !isReceiptImageType(file.type)) {
    throw new InvoiceUploadError(invalid ?? notUploaded);
  }
  const upload = await api.post(
    `/organizations/${organizationId}/receipts/upload-url`,
    {
      contentType: file.type,
      byteSize: file.size,
      sha256: await sha256Hex(file),
      kind: "photo",
    },
    receiptUploadResponseSchema,
  );
  return sendToStorage(upload, file);
}

async function sendToStorage(
  upload: { readonly receiptFileId: string; readonly uploadUrl: string },
  file: File,
): Promise<string> {
  let response: Response;
  try {
    response = await fetch(upload.uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": file.type },
      body: file,
    });
  } catch (cause) {
    throw new InvoiceUploadError(notUploaded, { cause });
  }
  if (!response.ok) throw new InvoiceUploadError(notUploaded);
  return upload.receiptFileId;
}

export function describeUploadError(error: unknown): string {
  return error instanceof InvoiceUploadError
    ? error.message
    : describeApiError(error);
}
