"use client";

import type { JSX } from "react";
import { DownloadIcon } from "lucide-react";

import { useBillReceiptDownload } from "~/app/(company)/reports/_components/reports-api";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";

/** What a sheet needs to offer a paid bill's receipt: start it and show how it went. */
export interface ReceiptDownload {
  /** The bill the latest attempt was for; its state shows only on that bill. */
  readonly billId: string | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly start: (billId: string) => void;
}

export function useReceiptDownload(organizationId: string): ReceiptDownload {
  const download = useBillReceiptDownload(organizationId);
  return {
    billId: download.variables ?? null,
    pending: download.isPending,
    error: download.isError ? describeApiError(download.error) : null,
    start: (billId) => download.mutate(billId),
  };
}

/** "Download receipt" for a bill paid through Expendi, with its failure inline. */
export function ReceiptDownloadAction({
  billId,
  download,
}: {
  billId: string;
  download: ReceiptDownload;
}): JSX.Element {
  const mine = download.billId === billId;
  const pending = mine && download.pending;
  const error = mine ? download.error : null;
  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="outline"
        size="md"
        disabled={pending}
        onClick={() => download.start(billId)}
      >
        <DownloadIcon aria-hidden="true" />
        {pending ? "Preparing receipt…" : "Download receipt"}
      </Button>
      {error ? (
        <div role="alert" className="w-full">
          <Callout tone="error">
            <p>{error}</p>
          </Callout>
        </div>
      ) : null}
    </div>
  );
}
