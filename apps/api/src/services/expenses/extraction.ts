import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { Effect } from "effect";
import { z } from "zod";

import type {
  ExtractedClaimField,
  ReceiptExtractionResponse,
} from "@expendi-business/shared";

import type { DatabaseService } from "../../db/client.js";
import type { Transaction } from "../../db/scope.js";
import type { DatabaseError } from "../../errors.js";
import type { Tenant } from "../../middleware/tenant.js";
import type {
  ReceiptExtraction,
  ReceiptExtractionError,
} from "../extraction/receipt-extractor.js";
import type { ReceiptFieldName } from "../extraction/receipt-schema.js";
import { receiptFiles } from "../../db/schema/index.js";
import { query, withScope } from "../../db/scope.js";
import { BadRequest, NotFound, PayloadTooLarge } from "../../errors.js";
import {
  MAX_RECEIPT_IMAGE_BYTES,
  ReceiptExtractor,
} from "../extraction/receipt-extractor.js";
import {
  RECEIPT_FIELD_NAMES,
  receiptFieldsSchema,
} from "../extraction/receipt-schema.js";
import { FileStorage } from "../storage/file-storage.js";

/**
 * Reading an uploaded receipt image to pre-fill the uploader's claim form
 * (spec §6.3, §6.4). It never submits anything, and anything short of a
 * clean read is "unreadable", so the app falls back to manual entry. The
 * result is kept on the file and copied to the claim made from it.
 */

/** A read result as kept in `receipt_files.extraction`. */
const storedExtractionSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("read"),
    fields: receiptFieldsSchema,
    flags: z.array(z.literal("currency_not_kes")),
    raw: z.unknown(),
  }),
  z.object({
    status: z.literal("unreadable"),
    reason: z.string(),
    raw: z.unknown(),
  }),
]);

type StoredExtraction = z.infer<typeof storedExtractionSchema>;

const receiptNotFound = new NotFound({ message: "Receipt not found" });
const notAnImage = new BadRequest({
  message: "Only a photo or screenshot of a receipt can be read.",
});
const tooLarge = new PayloadTooLarge({
  message: "That image is too large to read. Retake the photo.",
});

const UNREADABLE: ReceiptExtractionResponse = { status: "unreadable" };

const CLAIM_FIELD: Readonly<Record<ReceiptFieldName, ExtractedClaimField>> = {
  merchant: "merchant",
  amount: "amountKes",
  currency: "amountKes",
  date: "spentOn",
  mpesaCode: "mpesaCode",
  etimsInvoiceNumber: "etimsInvoiceNumber",
  supplierKraPin: "etimsSupplierPin",
};

/** Only KES pre-fills the amount; a claim is always in KES. */
export function toExtractionResponse(
  extraction: StoredExtraction,
): ReceiptExtractionResponse {
  if (extraction.status === "unreadable") return UNREADABLE;
  const { fields, flags } = extraction;
  const amountNotInKes = flags.includes("currency_not_kes");
  const lowConfidence = new Set<ExtractedClaimField>();
  for (const name of RECEIPT_FIELD_NAMES) {
    if (fields.confidence[name] === "low") lowConfidence.add(CLAIM_FIELD[name]);
  }
  return {
    status: "read",
    fields: {
      merchant: fields.merchant,
      amountKes: amountNotInKes ? null : fields.amountCents,
      spentOn: fields.date,
      mpesaCode: fields.mpesaCode,
      etimsInvoiceNumber: fields.etimsInvoiceNumber,
      etimsSupplierPin: fields.supplierKraPin,
    },
    lowConfidence: [...lowConfidence].filter(
      (field) => field !== "amountKes" || !amountNotInKes,
    ),
    amountNotInKes,
  };
}

function toStored(extraction: ReceiptExtraction): StoredExtraction {
  return extraction.status === "read"
    ? {
        status: "read",
        fields: extraction.fields,
        flags: [...extraction.flags],
        raw: extraction.raw,
      }
    : { status: "unreadable", reason: extraction.reason, raw: extraction.raw };
}

function logUnread(receiptFileId: string, why: string): Effect.Effect<void> {
  return Effect.sync(() => {
    console.warn(`[receipts] receipt ${receiptFileId} not read: ${why}`);
  });
}

/**
 * Reads the caller's own uploaded image once; asking again returns the
 * kept result without a second call to Claude. Nobody else's file is
 * visible here, not even an admin's view of a colleague's.
 */
export function extractReceipt(
  tenant: Tenant,
  receiptFileId: string,
): Effect.Effect<
  ReceiptExtractionResponse,
  BadRequest | NotFound | PayloadTooLarge | DatabaseError,
  DatabaseService | FileStorage | ReceiptExtractor
> {
  return Effect.gen(function* () {
    const storage = yield* FileStorage;
    const extractor = yield* ReceiptExtractor;
    const [file] = yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .select({
            kind: receiptFiles.kind,
            storageKey: receiptFiles.storageKey,
            contentType: receiptFiles.contentType,
            byteSize: receiptFiles.byteSize,
            extraction: receiptFiles.extraction,
          })
          .from(receiptFiles)
          .where(
            and(
              eq(receiptFiles.organizationId, tenant.organizationId),
              eq(receiptFiles.id, receiptFileId),
              eq(receiptFiles.uploadedBy, tenant.userId),
            ),
          )
          .limit(1),
      ),
    );
    if (!file) return yield* Effect.fail(receiptNotFound);
    if (
      (file.kind !== "photo" && file.kind !== "screenshot") ||
      file.storageKey === null
    ) {
      return yield* Effect.fail(notAnImage);
    }
    const kept = storedExtractionSchema.safeParse(file.extraction);
    if (kept.success) return toExtractionResponse(kept.data);
    if (file.byteSize > MAX_RECEIPT_IMAGE_BYTES) {
      return yield* Effect.fail(tooLarge);
    }

    const stored = yield* storage.get(file.storageKey).pipe(Effect.either);
    if (stored._tag === "Left") {
      yield* logUnread(receiptFileId, `storage ${stored.left.code}`);
      return UNREADABLE;
    }
    if (stored.right === null) {
      yield* logUnread(receiptFileId, "not in storage");
      return UNREADABLE;
    }

    const read = yield* extractor
      .extract({ bytes: stored.right.bytes, mediaType: file.contentType })
      .pipe(Effect.either);
    if (read._tag === "Left") {
      return yield* unreadOrTooLarge(receiptFileId, read.left);
    }

    const extraction = toStored(read.right);
    yield* withScope(tenant, (tx) =>
      query(() =>
        tx
          .update(receiptFiles)
          .set({ extraction })
          .where(
            and(
              eq(receiptFiles.id, receiptFileId),
              isNull(receiptFiles.extraction),
            ),
          ),
      ),
    );
    return toExtractionResponse(extraction);
  });
}

function unreadOrTooLarge(
  receiptFileId: string,
  error: ReceiptExtractionError,
): Effect.Effect<ReceiptExtractionResponse, PayloadTooLarge> {
  if (error.code === "IMAGE_TOO_LARGE") return Effect.fail(tooLarge);
  return logUnread(receiptFileId, error.code).pipe(Effect.as(UNREADABLE));
}

/**
 * What reading returned for each of an expense's receipts, for
 * `expenses.extraction`; null when none was read.
 */
export function extractionsOf(
  tx: Transaction,
  organizationId: string,
  receiptFileIds: readonly string[],
): Effect.Effect<{ receipts: unknown[] } | null, DatabaseError> {
  if (receiptFileIds.length === 0) return Effect.succeed(null);
  return query(() =>
    tx
      .select({ id: receiptFiles.id, extraction: receiptFiles.extraction })
      .from(receiptFiles)
      .where(
        and(
          eq(receiptFiles.organizationId, organizationId),
          inArray(receiptFiles.id, [...receiptFileIds]),
          isNotNull(receiptFiles.extraction),
        ),
      ),
  ).pipe(
    Effect.map((rows) => {
      const order = new Map(receiptFileIds.map((id, index) => [id, index]));
      const receipts = rows
        .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
        .map((row) => ({ receiptFileId: row.id, result: row.extraction }));
      return receipts.length === 0 ? null : { receipts };
    }),
  );
}
