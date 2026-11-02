/**
 * Receipts are shrunk on the phone before upload, since staff may be on
 * cheap phones and slow data (spec §6.3). 1600 px on the long edge keeps
 * the print readable.
 */
export const RECEIPT_LONG_EDGE_PX = 1600;
export const RECEIPT_JPEG_QUALITY = 0.7;

export type ReceiptResize = { width: number } | { height: number };

/** Brings the longer edge down to 1600 px; null when it's already that small. */
export function receiptResize(size: {
  width: number;
  height: number;
}): ReceiptResize | null {
  if (Math.max(size.width, size.height) <= RECEIPT_LONG_EDGE_PX) return null;
  return size.width >= size.height
    ? { width: RECEIPT_LONG_EDGE_PX }
    : { height: RECEIPT_LONG_EDGE_PX };
}

export function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
