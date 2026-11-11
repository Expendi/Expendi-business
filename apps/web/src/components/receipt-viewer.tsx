import type { JSX } from "react";
import Image from "next/image";

import { linkClass } from "./styles";

/**
 * An expense's evidence (spec §6.4): an image or PDF behind a short-lived
 * link, or a pasted M-Pesa SMS. Claims, company spending, floats and bills
 * all return this shape.
 */
export type ViewableReceipt =
  | {
      id: string;
      kind: "photo" | "screenshot" | "pdf";
      contentType: string;
      url: string;
      billRole?: "invoice" | "proof" | null;
    }
  | { id: string; kind: "sms_text"; text: string };

const BILL_ROLES = { invoice: "Invoice", proof: "Proof of payment" } as const;

function captionOf(receipt: ViewableReceipt): string {
  if (receipt.kind === "sms_text") return "M-Pesa SMS";
  if (receipt.billRole) return BILL_ROLES[receipt.billRole];
  if (receipt.kind === "pdf") return "PDF";
  return receipt.kind === "screenshot" ? "Screenshot" : "Photo";
}

/**
 * The links expire after a few minutes, so images load straight from
 * storage: Next's optimizer would cache a private receipt under a URL that
 * no longer works.
 */
export function ReceiptViewer({
  receipts,
}: {
  receipts: readonly ViewableReceipt[];
}): JSX.Element {
  if (receipts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-card p-4 text-sm text-muted-foreground">
        No receipt attached.
      </p>
    );
  }
  return (
    <ul className="space-y-4">
      {receipts.map((receipt) => (
        <li key={receipt.id}>
          <figure className="space-y-2">
            {receipt.kind === "sms_text" ? (
              <pre className="font-sans text-sm whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/60 p-3">
                {receipt.text}
              </pre>
            ) : receipt.kind === "pdf" ? (
              <iframe
                title={captionOf(receipt)}
                src={receipt.url}
                className="h-96 w-full rounded-lg border border-border bg-card"
              />
            ) : (
              <a
                href={receipt.url}
                target="_blank"
                rel="noreferrer"
                className="relative block h-96 w-full overflow-hidden rounded-lg border border-border bg-muted"
              >
                <Image
                  src={receipt.url}
                  alt={`Receipt ${captionOf(receipt).toLowerCase()}`}
                  fill
                  unoptimized
                  sizes="(min-width: 1024px) 40vw, 100vw"
                  className="object-contain"
                />
              </a>
            )}
            <figcaption className="flex items-center justify-between text-xs text-muted-foreground">
              <span>{captionOf(receipt)}</span>
              {receipt.kind === "sms_text" ? null : (
                <a
                  href={receipt.url}
                  target="_blank"
                  rel="noreferrer"
                  className={linkClass}
                >
                  Open
                </a>
              )}
            </figcaption>
          </figure>
        </li>
      ))}
    </ul>
  );
}
