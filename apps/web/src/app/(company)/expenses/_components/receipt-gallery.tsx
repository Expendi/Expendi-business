import type { JSX } from "react";
import { cn } from "cn";
import { ExternalLinkIcon, ImageOffIcon } from "lucide-react";
import Image from "next/image";

import type { ViewableReceipt } from "~/components/receipt-viewer";
import { textLinkClass } from "~/components/data/actions";

const BILL_ROLES = { invoice: "Invoice", proof: "Proof of payment" } as const;

function captionOf(receipt: ViewableReceipt): string {
  if (receipt.kind === "sms_text") return "M-Pesa SMS";
  if (receipt.billRole) return BILL_ROLES[receipt.billRole];
  if (receipt.kind === "pdf") return "PDF";
  return receipt.kind === "screenshot" ? "Screenshot" : "Photo";
}

/**
 * Receipts on a gray stage with a caption bar, as the side sheet and the
 * Approvals pane show them: images, PDFs, and pasted M-Pesa SMS. `tall` is
 * the Approvals pane's larger stage. The links expire after a few minutes,
 * so images load straight from storage, unoptimized.
 */
export function ReceiptGallery({
  receipts,
  tall = false,
}: {
  receipts: readonly ViewableReceipt[];
  tall?: boolean;
}): JSX.Element {
  if (receipts.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-1.5 rounded-control border border-dashed border-control-border p-6 text-center text-gray-600",
          tall ? "min-h-[200px]" : "min-h-40",
        )}
      >
        <ImageOffIcon aria-hidden="true" className="size-6 text-gray-500" />
        <p>No receipt attached.</p>
      </div>
    );
  }
  const stageHeight = tall ? "h-[300px]" : "h-60";
  return (
    <div className={cn("flex flex-col", tall ? "gap-4" : "gap-3")}>
      {receipts.map((receipt) => (
        <figure
          key={receipt.id}
          className="overflow-hidden rounded-control border border-gray-200 bg-gray-50"
        >
          <div
            className={cn(
              "flex items-center justify-center p-5",
              tall ? "min-h-[340px]" : "min-h-[280px]",
            )}
          >
            {receipt.kind === "sms_text" ? (
              <pre className="m-0 w-full max-w-[320px] rounded-[16px_16px_16px_4px] border border-gray-200 bg-surface px-4 py-3.5 font-sans text-sm leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">
                {receipt.text}
              </pre>
            ) : receipt.kind === "pdf" ? (
              <iframe
                title={captionOf(receipt)}
                src={receipt.url}
                className={cn(
                  "w-full rounded-[2px] border border-gray-200 bg-surface",
                  stageHeight,
                )}
              />
            ) : (
              <a
                href={receipt.url}
                target="_blank"
                rel="noreferrer"
                className={cn("relative block w-full", stageHeight)}
              >
                <Image
                  src={receipt.url}
                  alt={`Receipt ${captionOf(receipt).toLowerCase()}`}
                  fill
                  unoptimized
                  sizes="(min-width: 1024px) 40vw, 100vw"
                  className="object-scale-down"
                />
              </a>
            )}
          </div>
          <figcaption className="flex items-center justify-between gap-2 border-t border-gray-200 bg-surface px-3 py-2 text-xs leading-4 text-gray-500">
            <span>{captionOf(receipt)}</span>
            {receipt.kind === "sms_text" ? null : (
              <a
                href={receipt.url}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  textLinkClass,
                  "inline-flex items-center gap-1 text-xs",
                )}
              >
                Open
                <ExternalLinkIcon aria-hidden="true" className="size-3" />
              </a>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
