import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  BillFileRole,
  BillFileType,
  ReceiptFileKind,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type {
  Conflict,
  DatabaseError,
  ServiceUnavailable,
} from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { ReceiptUpload } from "../expenses/receipts.js";
import { receiptFiles } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest } from "../../errors.js";
import { requestReceiptUpload, storageFailure } from "../expenses/receipts.js";
import { FileStorage } from "../storage/file-storage.js";

/**
 * A bill's files (spec §6.20): the supplier's invoice, as an image or a
 * PDF, and proof that it was paid outside Expendi. They are receipt files
 * uploaded the way a claim's receipts are (T14) and stay pending until a
 * bill takes them, with a role. Reading an invoice and its eTIMS QR code
 * (T16, T17) works from the same rows once that's wired to bills.
 */

export interface BillFileView {
  readonly id: string;
  readonly role: BillFileRole;
  readonly kind: ReceiptFileKind;
  readonly contentType: string;
  readonly url: string;
  readonly expiresAt: Date;
}

/** A presigned PUT for an invoice or proof; a PDF is allowed here, unlike a claim's receipt. */
export function requestBillFileUpload(
  tenant: Tenant,
  upload: {
    readonly contentType: BillFileType;
    readonly byteSize: number;
    readonly sha256: string;
  },
): Effect.Effect<
  ReceiptUpload,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return requestReceiptUpload(tenant, {
    ...upload,
    kind: upload.contentType === "application/pdf" ? "pdf" : "photo",
  });
}

const fileUnavailable = new BadRequest({
  message: "That file isn't available. Add it again.",
});
const notUploaded = new BadRequest({
  message: "The file didn't finish uploading. Add it again.",
});

/**
 * Checks that every file is the caller's, stored (not a pasted SMS), on no
 * claim and no other bill, and really in storage with the size they
 * declared. Files already on `billId` pass. Run it before the transaction
 * that attaches them: it calls R2.
 */
export function checkAttachableBillFiles(
  tenant: Tenant,
  receiptFileIds: readonly string[],
  billId: string | null,
): Effect.Effect<
  void,
  BadRequest | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  if (receiptFileIds.length === 0) return Effect.void;
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const files = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({
            storageKey: receiptFiles.storageKey,
            byteSize: receiptFiles.byteSize,
            uploadedBy: receiptFiles.uploadedBy,
            expenseId: receiptFiles.expenseId,
            billId: receiptFiles.billId,
          })
          .from(receiptFiles)
          .where(
            and(
              eq(receiptFiles.organizationId, tenant.organizationId),
              inArray(receiptFiles.id, [...receiptFileIds]),
            ),
          ),
      ),
    );
    const usable = files.flatMap((file) =>
      file.uploadedBy === tenant.userId &&
      file.storageKey !== null &&
      file.expenseId === null &&
      (file.billId === null || file.billId === billId)
        ? [{ ...file, storageKey: file.storageKey }]
        : [],
    );
    if (usable.length !== receiptFileIds.length) {
      return yield* Effect.fail(fileUnavailable);
    }

    const toVerify = usable.filter((file) => file.billId === null);
    const stored = yield* Effect.forEach(
      toVerify,
      (file) => storage.head(file.storageKey),
      { concurrency: "unbounded" },
    ).pipe(Effect.mapError(storageFailure));
    const allUploaded = toVerify.every(
      (file, index) => stored[index]?.byteSize === file.byteSize,
    );
    if (!allUploaded) return yield* Effect.fail(notUploaded);
  });
}

/**
 * Puts the caller's pending files on the bill with `role`, inside the
 * transaction that changes the bill, and returns the ones newly attached.
 * Files already on the bill are left as they are. Fails, rolling back, if
 * a file was taken in the meantime.
 */
export function attachBillFiles(
  tx: Transaction,
  tenant: Tenant,
  billId: string,
  receiptFileIds: readonly string[],
  role: BillFileRole,
): Effect.Effect<readonly string[], BadRequest | DatabaseError> {
  if (receiptFileIds.length === 0) return Effect.succeed([]);
  return Effect.gen(function* () {
    const onBill = yield* query(() =>
      tx
        .select({ id: receiptFiles.id })
        .from(receiptFiles)
        .where(
          and(
            eq(receiptFiles.organizationId, tenant.organizationId),
            eq(receiptFiles.billId, billId),
            inArray(receiptFiles.id, [...receiptFileIds]),
          ),
        ),
    );
    const already = new Set(onBill.map((file) => file.id));
    const added = receiptFileIds.filter((id) => !already.has(id));
    if (added.length === 0) return [];

    const attached = yield* query(() =>
      tx
        .update(receiptFiles)
        .set({ billId, billRole: role })
        .where(
          and(
            eq(receiptFiles.organizationId, tenant.organizationId),
            eq(receiptFiles.uploadedBy, tenant.userId),
            inArray(receiptFiles.id, added),
            isNull(receiptFiles.expenseId),
            isNull(receiptFiles.billId),
          ),
        )
        .returning({ id: receiptFiles.id }),
    );
    if (attached.length !== added.length) {
      return yield* Effect.fail(fileUnavailable);
    }
    return added;
  });
}

/** The bill's files, oldest first, with short-lived links to each. */
export function billFileLinks(
  files: readonly {
    readonly id: string;
    readonly role: BillFileRole;
    readonly kind: ReceiptFileKind;
    readonly contentType: string;
    readonly storageKey: string;
  }[],
): Effect.Effect<BillFileView[], ServiceUnavailable, FileStorage> {
  return Effect.flatMap(FileStorage, (storage) =>
    Effect.forEach(files, (file) =>
      storage.presignDownload(file.storageKey).pipe(
        Effect.map(({ url, expiresAt }): BillFileView => ({
          id: file.id,
          role: file.role,
          kind: file.kind,
          contentType: file.contentType,
          url,
          expiresAt,
        })),
      ),
    ).pipe(Effect.mapError(storageFailure)),
  );
}

/** Rows for `billFileLinks`. Only stored files are ever attached to a bill. */
export function readBillFiles(
  tx: Transaction,
  organizationId: string,
  billId: string,
) {
  return query(() =>
    tx
      .select({
        id: receiptFiles.id,
        role: receiptFiles.billRole,
        kind: receiptFiles.kind,
        contentType: receiptFiles.contentType,
        storageKey: receiptFiles.storageKey,
      })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          eq(receiptFiles.billId, billId),
        ),
      )
      .orderBy(asc(receiptFiles.createdAt), asc(receiptFiles.id)),
  ).pipe(
    Effect.map((rows) =>
      rows.flatMap((row) =>
        row.role !== null && row.storageKey !== null
          ? [{ ...row, role: row.role, storageKey: row.storageKey }]
          : [],
      ),
    ),
  );
}
