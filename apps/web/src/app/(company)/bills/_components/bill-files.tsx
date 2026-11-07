import type { JSX } from "react";
import { cn } from "cn";
import { ExternalLinkIcon, ImageOffIcon } from "lucide-react";
import Image from "next/image";

import type { BillFile } from "@expendi-business/shared";

import { textLinkClass } from "~/components/data/actions";

const ROLE_CAPTIONS = {
  invoice: "Invoice",
  proof: "Proof of payment",
} as const;

/**
 * A bill's invoices and proof of payment, each in a viewer with an Open
 * link. The links expire after a few minutes, so images load straight
 * from storage: Next's optimizer would cache a private file under a URL
 * that no longer works.
 */
export function BillFiles({
  files,
}: {
  files: readonly BillFile[];
}): JSX.Element {
  if (files.length === 0) {
    return (
      <div className="flex min-h-40 flex-col items-center justify-center gap-1.5 rounded-control border border-dashed border-control-border p-6 text-center text-gray-600">
        <ImageOffIcon aria-hidden="true" className="size-6 text-gray-500" />
        <p>No receipt attached.</p>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => {
        const caption = ROLE_CAPTIONS[file.role];
        return (
          <figure
            key={file.id}
            className="m-0 overflow-hidden rounded-control border border-gray-200 bg-gray-50"
          >
            {file.kind === "pdf" ? (
              <iframe
                title={caption}
                src={file.url}
                className="block h-80 w-full border-0 bg-white"
              />
            ) : (
              <div className="flex min-h-70 items-center justify-center p-5">
                <Image
                  src={file.url}
                  alt={caption}
                  width={0}
                  height={0}
                  unoptimized
                  className="h-auto max-h-75 w-auto max-w-full rounded-[4px]"
                />
              </div>
            )}
            <figcaption className="flex items-center justify-between gap-2 border-t border-gray-200 bg-surface px-3 py-2 text-xs leading-4 text-gray-500">
              <span>{caption}</span>
              <a
                href={file.url}
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
            </figcaption>
          </figure>
        );
      })}
    </div>
  );
}
