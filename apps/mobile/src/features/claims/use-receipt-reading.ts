import { useCallback, useEffect, useRef, useState } from "react";

import type { ReceiptExtractionResponse } from "@expendi-business/shared";
import { receiptExtractionResponseSchema } from "@expendi-business/shared";

import { useApi } from "~/providers/api-provider";

/** Claude can take up to 45 s on a receipt, plus the download from storage. */
const READ_TIMEOUT_MS = 60_000;

export type ReadingStatus = "idle" | "reading" | "read" | "unreadable";

type ReadResult = Extract<ReceiptExtractionResponse, { status: "read" }>;

export interface ReceiptReadingControls {
  status: ReadingStatus;
  /** Reads an uploaded image; a newer read replaces one still running. */
  read: (receiptFileId: string, onRead: (result: ReadResult) => void) => void;
  /** Stops waiting, so the person types the details in. */
  stop: () => void;
}

/**
 * Reads each newly uploaded receipt to pre-fill the form (spec §6.4). Any
 * failure is "unreadable": the person types the details in, and the form
 * never submits on its own.
 */
export function useReceiptReading(
  organizationId: string,
): ReceiptReadingControls {
  const api = useApi();
  const running = useRef<AbortController | null>(null);
  const [status, setStatus] = useState<ReadingStatus>("idle");

  useEffect(() => () => running.current?.abort(), []);

  const read = useCallback(
    (receiptFileId: string, onRead: (result: ReadResult) => void) => {
      running.current?.abort();
      const controller = new AbortController();
      running.current = controller;
      setStatus("reading");
      void api
        .post(
          `/organizations/${organizationId}/receipts/${receiptFileId}/extract`,
          {},
          receiptExtractionResponseSchema,
          { signal: controller.signal, timeoutMs: READ_TIMEOUT_MS },
        )
        .then(
          (result) => {
            if (controller.signal.aborted) return;
            setStatus(result.status);
            if (result.status === "read") onRead(result);
          },
          (error: unknown) => {
            if (controller.signal.aborted) return;
            console.warn("[claims] reading the receipt failed", error);
            setStatus("unreadable");
          },
        )
        .finally(() => {
          if (running.current === controller) running.current = null;
        });
    },
    [api, organizationId],
  );

  const stop = useCallback(() => {
    running.current?.abort();
    running.current = null;
    setStatus("idle");
  }, []);

  return { status, read, stop };
}
