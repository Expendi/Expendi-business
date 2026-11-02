import { Effect } from "effect";

import type { EtimsStatus } from "@expendi-business/shared";
import { parseEtimsQr } from "@expendi-business/shared";

import { BadRequest } from "../../errors.js";

/**
 * eTIMS capture on an expense (spec §6.6). The QR payload is kept exactly as
 * scanned; when it's a KRA link the API reads the invoice number and the
 * supplier's PIN from it rather than trusting the phone. There's no call to
 * KRA: anyone can check the invoice by hand from the QR.
 */

export interface EtimsFields {
  readonly etimsQrPayload: string | null;
  readonly etimsInvoiceNumber: string | null;
  readonly etimsSupplierPin: string | null;
}

export interface ResolvedEtims extends EtimsFields {
  readonly etimsStatus: EtimsStatus;
}

/** `attached` once an invoice number is captured; exempt categories need none. */
export function etimsStatusFor(
  etimsInvoiceNumber: string | null,
  category: { readonly etimsNotRequired: boolean },
): EtimsStatus {
  if (etimsInvoiceNumber !== null) return "attached";
  return category.etimsNotRequired ? "not_required" : "none";
}

function agreed(
  typed: string | null,
  scanned: string | null,
  mismatch: (scanned: string) => string,
): Effect.Effect<string | null, BadRequest> {
  if (scanned === null || typed === null)
    return Effect.succeed(typed ?? scanned);
  return typed === scanned
    ? Effect.succeed(typed)
    : Effect.fail(new BadRequest({ message: mismatch(scanned) }));
}

/**
 * Fills the invoice number and supplier PIN from a recognised QR, and
 * refuses typed values that contradict it. An unrecognised QR is kept as
 * it is, with whatever the employee typed.
 */
export function resolveEtims(
  fields: EtimsFields,
  category: { readonly etimsNotRequired: boolean },
): Effect.Effect<ResolvedEtims, BadRequest> {
  return Effect.gen(function* () {
    const parsed =
      fields.etimsQrPayload === null
        ? null
        : parseEtimsQr(fields.etimsQrPayload);
    const qr = parsed?.ok ? parsed.qr : null;
    const etimsInvoiceNumber = yield* agreed(
      fields.etimsInvoiceNumber,
      qr?.invoiceNumber ?? null,
      (scanned) =>
        `The eTIMS invoice number doesn't match the QR code you scanned, which says ${scanned}.`,
    );
    const etimsSupplierPin = yield* agreed(
      fields.etimsSupplierPin,
      qr?.supplierPin ?? null,
      (scanned) =>
        `The supplier's KRA PIN doesn't match the QR code you scanned, which says ${scanned}.`,
    );
    return {
      etimsQrPayload: fields.etimsQrPayload,
      etimsInvoiceNumber,
      etimsSupplierPin,
      etimsStatus: etimsStatusFor(etimsInvoiceNumber, category),
    };
  });
}
