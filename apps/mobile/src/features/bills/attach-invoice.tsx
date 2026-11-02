import type { JSX } from "react";
import { useState } from "react";
import { View } from "react-native";

import type { ReceiptSource } from "~/features/claims/receipt-upload";
import { Button } from "~/components/button";
import { ErrorMessage } from "~/components/error-message";
import {
  describeReceiptError,
  pickReceiptImage,
  uploadReceiptImage,
} from "~/features/claims/receipt-upload";
import { useApi } from "~/providers/api-provider";
import { useAttachBillInvoices } from "./use-bills";

const NO_CAMERA =
  "Expendi Business can’t use the camera. Allow it in Settings, or choose an image instead.";

/** Photographs or picks an invoice, uploads it like a receipt, then attaches it to the bill. */
export function AttachInvoice({
  organizationId,
  billId,
}: {
  organizationId: string;
  billId: string;
}): JSX.Element {
  const api = useApi();
  const attach = useAttachBillInvoices(organizationId, billId);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(source: ReceiptSource): Promise<void> {
    setError(null);
    attach.reset();
    try {
      const picked = await pickReceiptImage(source);
      if (picked.status === "no-camera-access") setError(NO_CAMERA);
      if (picked.status !== "picked") return;
      setUploading(true);
      const { receiptFileId } = await uploadReceiptImage(
        api,
        organizationId,
        picked.image,
        source,
      );
      await attach.mutateAsync([receiptFileId]);
    } catch (cause) {
      setError(describeReceiptError(cause));
    } finally {
      setUploading(false);
    }
  }

  const busy = uploading || attach.isPending;
  return (
    <View className="gap-3">
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Photograph invoice"
            variant="secondary"
            loading={busy}
            onPress={() => void add("camera")}
          />
        </View>
        <View className="flex-1">
          <Button
            label="Choose image"
            variant="secondary"
            disabled={busy}
            onPress={() => void add("library")}
          />
        </View>
      </View>
      <ErrorMessage message={error} />
    </View>
  );
}
