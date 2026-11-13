"use client";

import type { DragEvent, JSX } from "react";
import { cn } from "cn";
import { PaperclipIcon, UploadIcon } from "lucide-react";
import { useId, useState } from "react";

import { TextLinkButton } from "~/components/data/actions";
import { FieldDescription, FieldError } from "~/components/ui/field";
import {
  BILL_FILE_ACCEPT,
  describeUploadError,
  invalidInvoiceFile,
  invalidReceiptImage,
  RECEIPT_IMAGE_ACCEPT,
  uploadBillFile,
  uploadReceiptImage,
} from "~/features/bills/invoice-upload";
import { useApi } from "~/lib/use-api";

export interface UploadedBillFile {
  readonly id: string;
  readonly name: string;
}

/**
 * Picks invoices (or proof of payment) from the desktop, PDFs included,
 * by choosing or dropping them, and uploads each straight to storage as
 * it's picked. The bill takes the uploaded files' ids when it's saved.
 * With `receipts`, it takes receipt images only, for a Card purchase.
 */
export function BillFilesInput({
  organizationId,
  label,
  files,
  onChange,
  onUploadingChange,
  max,
  disabled,
  receipts = false,
}: {
  organizationId: string;
  label: string;
  files: readonly UploadedBillFile[];
  onChange: (files: UploadedBillFile[]) => void;
  onUploadingChange: (uploading: boolean) => void;
  max: number;
  disabled: boolean;
  receipts?: boolean;
}): JSX.Element {
  const api = useApi();
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const full = files.length >= max;
  const blocked = disabled || uploading || full;
  const invalidFile = receipts ? invalidReceiptImage : invalidInvoiceFile;
  const uploadFile = receipts ? uploadReceiptImage : uploadBillFile;

  async function upload(picked: readonly File[]): Promise<void> {
    setError(null);
    const room = max - files.length;
    if (picked.length > room) {
      setError(`Add at most ${String(max)} files.`);
      return;
    }
    const invalid = picked
      .map((file) => invalidFile(file))
      .find((reason) => reason !== null);
    if (invalid) {
      setError(invalid);
      return;
    }
    setUploading(true);
    onUploadingChange(true);
    const uploaded: UploadedBillFile[] = [];
    try {
      for (const file of picked) {
        const id = await uploadFile(api, organizationId, file);
        uploaded.push({ id, name: file.name });
      }
    } catch (cause) {
      setError(describeUploadError(cause));
    } finally {
      onChange([...files, ...uploaded]);
      setUploading(false);
      onUploadingChange(false);
    }
  }

  function onDrop(event: DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    const picked = Array.from(event.dataTransfer.files);
    if (!blocked && picked.length > 0) void upload(picked);
  }

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs leading-4 font-(--w-ui) text-muted-foreground">
        {label}
      </span>
      <input
        id={inputId}
        type="file"
        accept={receipts ? RECEIPT_IMAGE_ACCEPT : BILL_FILE_ACCEPT}
        multiple
        disabled={blocked}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) void upload(picked);
        }}
        className="peer sr-only"
      />
      <label
        htmlFor={inputId}
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
        className={cn(
          "flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-control border border-dashed border-input bg-muted/60 p-3 text-center text-muted-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--focus-ring) hover:border-muted-foreground/50 hover:text-foreground",
          blocked &&
            "cursor-not-allowed opacity-50 hover:border-input hover:text-muted-foreground",
        )}
      >
        <UploadIcon aria-hidden="true" className="size-4" />
        {uploading ? "Uploading…" : "Choose files or drop them here"}
      </label>
      <FieldDescription>
        {receipts
          ? "A JPEG, PNG, WebP or HEIC image, up to 8 MB."
          : "A PDF, or a JPEG, PNG, WebP or HEIC image, up to 8 MB."}
      </FieldDescription>
      {files.length > 0 ? (
        <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
          {files.map((file) => (
            <li
              key={file.id}
              className="flex items-center gap-2 rounded-control border border-border px-2.5 py-2"
            >
              <PaperclipIcon
                aria-hidden="true"
                className="size-3.5 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 flex-1 truncate">{file.name}</span>
              <TextLinkButton
                disabled={disabled || uploading}
                onClick={() =>
                  onChange(files.filter((other) => other.id !== file.id))
                }
              >
                Remove
              </TextLinkButton>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <FieldError>{error}</FieldError> : null}
    </div>
  );
}
