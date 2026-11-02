import { useCallback, useRef, useState } from "react";

import type { ReceiptImage, ReceiptSource } from "./receipt-upload";
import { useApi } from "~/providers/api-provider";
import { describeReceiptError, uploadReceiptImage } from "./receipt-upload";

/** One receipt on a claim being written: already stored, on its way, or failed. */
export type ReceiptSlot =
  | { key: string; status: "ready"; previewUri: string; receiptFileId: string }
  | { key: string; status: "uploading"; previewUri: string }
  | {
      key: string;
      status: "failed";
      previewUri: string;
      error: string;
      image: ReceiptImage;
      source: ReceiptSource;
    };

export interface ReceiptSlots {
  slots: ReceiptSlot[];
  add: (image: ReceiptImage, source: ReceiptSource) => void;
  retry: (key: string) => void;
  remove: (key: string) => void;
  /** The stored receipts, in the order they were added. */
  receiptFileIds: string[];
  uploading: boolean;
}

/**
 * Uploads each picked receipt straight away, so the person fills in the
 * form while it goes up. Removing a slot mid-upload drops its result.
 * `onUploaded` hears about each new file once it's stored.
 */
export function useReceiptSlots(
  organizationId: string,
  initial: ReceiptSlot[] = [],
  onUploaded?: (receiptFileId: string) => void,
): ReceiptSlots {
  const api = useApi();
  const [slots, setSlots] = useState<ReceiptSlot[]>(initial);
  const nextKey = useRef(0);

  const replace = useCallback((key: string, slot: ReceiptSlot) => {
    setSlots((current) =>
      current.map((existing) => (existing.key === key ? slot : existing)),
    );
  }, []);

  const upload = useCallback(
    (key: string, image: ReceiptImage, source: ReceiptSource) => {
      uploadReceiptImage(api, organizationId, image, source).then(
        ({ receiptFileId, previewUri }) => {
          replace(key, { key, status: "ready", previewUri, receiptFileId });
          onUploaded?.(receiptFileId);
        },
        (error: unknown) =>
          replace(key, {
            key,
            status: "failed",
            previewUri: image.uri,
            error: describeReceiptError(error),
            image,
            source,
          }),
      );
    },
    [api, organizationId, replace, onUploaded],
  );

  const add = useCallback(
    (image: ReceiptImage, source: ReceiptSource) => {
      nextKey.current += 1;
      const key = `new-${nextKey.current}`;
      setSlots((current) => [
        ...current,
        { key, status: "uploading", previewUri: image.uri },
      ]);
      upload(key, image, source);
    },
    [upload],
  );

  const retry = useCallback(
    (key: string) => {
      const slot = slots.find((candidate) => candidate.key === key);
      if (slot?.status !== "failed") return;
      replace(key, { key, status: "uploading", previewUri: slot.previewUri });
      upload(key, slot.image, slot.source);
    },
    [slots, replace, upload],
  );

  const remove = useCallback((key: string) => {
    setSlots((current) => current.filter((slot) => slot.key !== key));
  }, []);

  return {
    slots,
    add,
    retry,
    remove,
    receiptFileIds: slots.flatMap((slot) =>
      slot.status === "ready" ? [slot.receiptFileId] : [],
    ),
    uploading: slots.some((slot) => slot.status === "uploading"),
  };
}
