import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type {
  ParsedMpesaSms,
  ReceiptFileKind,
  ReceiptImageType,
} from "@expendi-business/shared";
import { normaliseMpesaSms, parseMpesaSms } from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type { StorageError } from "../storage/file-storage.js";
import { receiptFiles } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, Conflict, ServiceUnavailable } from "../../errors.js";
import { FileStorage } from "../storage/file-storage.js";
import { duplicateConflict, findExpense } from "./rules.js";

/**
 * Receipt uploads (spec §6.3). The app asks for a presigned PUT, uploads
 * the shrunk image straight to R2, then names the file in its claim. A
 * pasted M-Pesa SMS is sent to the API and kept as text instead. Either way
 * the row exists from the first step and stays pending until a claim takes
 * it.
 */

/** A bill's invoice may also be a PDF (spec §6.20); a claim's receipt never is. */
export type UploadContentType = ReceiptImageType | "application/pdf";

const EXTENSIONS: Readonly<Record<UploadContentType, string>> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/heic": "heic",
  "application/pdf": "pdf",
};

export function receiptStorageKey(
  organizationId: string,
  contentType: UploadContentType,
): string {
  return `org/${organizationId}/receipts/${randomUUID()}.${EXTENSIONS[contentType]}`;
}

const notSetUp = new ServiceUnavailable({
  message: "Receipt uploads aren't set up yet",
});
const storageDown = new ServiceUnavailable({
  message: "Couldn't reach receipt storage. Try again in a moment.",
});

export function storageFailure(error: StorageError): ServiceUnavailable {
  return error.code === "NOT_CONFIGURED" ? notSetUp : storageDown;
}

/** spec §6.5: the same image twice in one company is a duplicate. */
const alreadyUploaded = new Conflict({
  message: "This receipt was already uploaded",
});
const uploadedBySomeoneElse = (what: string) =>
  new Conflict({
    message: `${what} was already added by someone else in the company.`,
  });
const onABill = (what: string) =>
  new Conflict({ message: `${what} is already on a bill.` });

export interface ReceiptUploadInput {
  readonly contentType: UploadContentType;
  readonly byteSize: number;
  readonly sha256: string;
  readonly kind: Extract<ReceiptFileKind, "photo" | "screenshot" | "pdf">;
}

export interface ReceiptUpload {
  readonly receiptFileId: string;
  readonly uploadUrl: string;
  readonly storageKey: string;
  readonly expiresAt: Date;
}

/**
 * The file's row and a presigned PUT for it. Asking again for an image this
 * person uploaded but hasn't used yet (e.g. a retry after a failed submit)
 * signs a new URL for the same file; any other match is a duplicate.
 */
export function requestReceiptUpload(
  tenant: Tenant,
  upload: ReceiptUploadInput,
): Effect.Effect<
  ReceiptUpload,
  Conflict | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  const { organizationId, userId } = tenant;
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const storage = yield* FileStorage;
      const [created] = yield* query(() =>
        tx
          .insert(receiptFiles)
          .values({
            organizationId,
            uploadedBy: userId,
            storageKey: receiptStorageKey(organizationId, upload.contentType),
            kind: upload.kind,
            sha256: upload.sha256,
            contentType: upload.contentType,
            byteSize: upload.byteSize,
          })
          .onConflictDoNothing({
            target: [receiptFiles.organizationId, receiptFiles.sha256],
          })
          .returning({
            id: receiptFiles.id,
            storageKey: receiptFiles.storageKey,
          }),
      );
      const file =
        created ??
        (yield* reusablePendingFile(tx, tenant, upload, {
          kind: upload.kind,
          contentType: upload.contentType,
          byteSize: upload.byteSize,
        }));
      if (file.storageKey === null) return yield* Effect.fail(alreadyUploaded);

      const presigned = yield* storage
        .presignUpload({
          key: file.storageKey,
          contentType: upload.contentType,
          byteSize: upload.byteSize,
        })
        .pipe(Effect.mapError(storageFailure));
      return {
        receiptFileId: file.id,
        uploadUrl: presigned.url,
        storageKey: file.storageKey,
        expiresAt: presigned.expiresAt,
      };
    }),
  );
}

function reusablePendingFile(
  tx: Transaction,
  tenant: Tenant,
  upload: Pick<ReceiptUploadInput, "sha256">,
  changes: Partial<
    Pick<typeof receiptFiles.$inferInsert, "kind" | "contentType" | "byteSize">
  > = {},
  what = "This receipt",
): Effect.Effect<
  { readonly id: string; readonly storageKey: string | null },
  Conflict | DatabaseError
> {
  return Effect.gen(function* () {
    const [existing] = yield* query(() =>
      tx
        .select({
          id: receiptFiles.id,
          storageKey: receiptFiles.storageKey,
          uploadedBy: receiptFiles.uploadedBy,
          expenseId: receiptFiles.expenseId,
          billId: receiptFiles.billId,
        })
        .from(receiptFiles)
        .where(
          and(
            eq(receiptFiles.organizationId, tenant.organizationId),
            eq(receiptFiles.sha256, upload.sha256),
          ),
        )
        .for("update"),
    );
    if (!existing) return yield* Effect.fail(alreadyUploaded);
    if (existing.expenseId !== null) {
      const earlier = yield* findExpense(
        tx,
        tenant.organizationId,
        existing.expenseId,
      );
      return yield* Effect.fail(
        earlier
          ? duplicateConflict(what, earlier, {
              membershipId: tenant.membershipId,
              isAdmin: tenant.role === "admin",
            })
          : alreadyUploaded,
      );
    }
    if (existing.billId !== null) return yield* Effect.fail(onABill(what));
    if (existing.uploadedBy !== tenant.userId) {
      return yield* Effect.fail(uploadedBySomeoneElse(what));
    }
    if (Object.keys(changes).length > 0) {
      yield* query(() =>
        tx
          .update(receiptFiles)
          .set(changes)
          .where(eq(receiptFiles.id, existing.id)),
      );
    }
    return { id: existing.id, storageKey: existing.storageKey };
  });
}

const unreadableSms = new BadRequest({
  message:
    "Couldn't read this SMS. Enter the details by hand and add a photo or screenshot of the payment.",
});

export interface SmsReceipt {
  readonly receiptFileId: string;
  readonly sms: ParsedMpesaSms;
}

const sha256Hex = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Keeps a pasted M-Pesa payment SMS as a receipt (spec §6.4, §6.5). Only a
 * confirmation the parser reads counts as evidence; anything else is refused
 * so the employee adds a photo instead. Like an image, the same SMS twice in
 * a company is a duplicate, except the caller's own unused paste.
 */
export function registerSmsReceipt(
  tenant: Tenant,
  pasted: string,
): Effect.Effect<
  SmsReceipt,
  BadRequest | Conflict | DatabaseError,
  DatabaseService
> {
  const { organizationId, userId } = tenant;
  const text = normaliseMpesaSms(pasted);
  const parsed = parseMpesaSms(text);
  if (!parsed.ok) return Effect.fail(unreadableSms);
  const sha256 = sha256Hex(text);
  return withScope(tenant, (tx) =>
    Effect.gen(function* () {
      const [created] = yield* query(() =>
        tx
          .insert(receiptFiles)
          .values({
            organizationId,
            uploadedBy: userId,
            storageKey: null,
            kind: "sms_text",
            smsText: text,
            sha256,
            contentType: "text/plain; charset=utf-8",
            byteSize: Buffer.byteLength(text, "utf8"),
          })
          .onConflictDoNothing({
            target: [receiptFiles.organizationId, receiptFiles.sha256],
          })
          .returning({ id: receiptFiles.id }),
      );
      const file =
        created ??
        (yield* reusablePendingFile(
          tx,
          tenant,
          { sha256 },
          {},
          "This M-Pesa SMS",
        ));
      return { receiptFileId: file.id, sms: parsed.sms };
    }),
  );
}

const receiptUnavailable = new BadRequest({
  message: "That receipt isn't available. Add the photo again.",
});
const notUploaded = new BadRequest({
  message: "The receipt photo didn't finish uploading. Add it again.",
});
const oneSmsPerExpense = new BadRequest({
  message: "Attach one M-Pesa SMS per claim.",
});

/**
 * Checks that every file is the caller's, free to use (or already on
 * `expenseId`), and really in storage with the size they declared. Run it
 * before the transaction that attaches them: it calls R2.
 */
export function checkAttachableReceipts(
  tenant: Tenant,
  receiptFileIds: readonly string[],
  expenseId: string | null = null,
): Effect.Effect<
  void,
  BadRequest | ServiceUnavailable | DatabaseError,
  DatabaseService | FileStorage
> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const files = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({
            id: receiptFiles.id,
            kind: receiptFiles.kind,
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
    const usable = files.filter(
      (file) =>
        file.uploadedBy === tenant.userId &&
        file.billId === null &&
        file.kind !== "pdf" &&
        (file.expenseId === null || file.expenseId === expenseId),
    );
    if (usable.length !== receiptFileIds.length) {
      return yield* Effect.fail(receiptUnavailable);
    }
    if (usable.filter((file) => file.kind === "sms_text").length > 1) {
      return yield* Effect.fail(oneSmsPerExpense);
    }

    const toVerify = usable.flatMap((file) =>
      file.expenseId === null && file.storageKey !== null
        ? [{ storageKey: file.storageKey, byteSize: file.byteSize }]
        : [],
    );
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
 * Makes `receiptFileIds` exactly the files on `expenseId`, inside the
 * transaction that writes the expense, and returns the IDs it had before.
 * Files taken off it become pending again, so the same image can still be
 * used. Fails, rolling back, if a file was taken in the meantime.
 */
export function setExpenseReceipts(
  tx: Transaction,
  tenant: Tenant,
  expenseId: string,
  receiptFileIds: readonly string[],
): Effect.Effect<readonly string[], BadRequest | DatabaseError> {
  return Effect.gen(function* () {
    const current = yield* query(() =>
      tx
        .select({ id: receiptFiles.id })
        .from(receiptFiles)
        .where(
          and(
            eq(receiptFiles.organizationId, tenant.organizationId),
            eq(receiptFiles.expenseId, expenseId),
          ),
        )
        .for("update"),
    );
    const wanted = new Set(receiptFileIds);
    const removed = current.filter((file) => !wanted.has(file.id));
    const kept = new Set(current.map((file) => file.id));
    const added = receiptFileIds.filter((id) => !kept.has(id));

    if (removed.length > 0) {
      yield* query(() =>
        tx
          .update(receiptFiles)
          .set({ expenseId: null })
          .where(
            inArray(
              receiptFiles.id,
              removed.map((file) => file.id),
            ),
          ),
      );
    }
    const previous = current.map((file) => file.id);
    if (added.length === 0) return previous;
    const attached = yield* query(() =>
      tx
        .update(receiptFiles)
        .set({ expenseId })
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
      return yield* Effect.fail(receiptUnavailable);
    }
    return previous;
  });
}
