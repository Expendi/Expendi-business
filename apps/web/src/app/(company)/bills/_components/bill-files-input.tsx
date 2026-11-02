"use client";

import type { JSX } from "react";
import { useId, useState } from "react";

import { textButton } from "~/components/styles";
import {
  BILL_FILE_ACCEPT,
  describeUploadError,
  invalidInvoiceFile,
  uploadBillFile,
} from "~/features/bills/invoice-upload";
import { useApi } from "~/lib/use-api";

export interface UploadedBillFile {
  readonly id: string;
  readonly name: string;
}

/**
 * Picks invoices (or proof of payment) from the desktop, PDFs included,
 * and uploads each straight to storage as it's picked. The bill takes the
 * uploaded files' ids when it's saved.
 */
export function BillFilesInput({
  organizationId,
  label,
  files,
  onChange,
  onUploadingChange,
  max,
  disabled,
}: {
  organizationId: string;
  label: string;
  files: readonly UploadedBillFile[];
  onChange: (files: UploadedBillFile[]) => void;
  onUploadingChange: (uploading: boolean) => void;
  max: number;
  disabled: boolean;
}): JSX.Element {
  const api = useApi();
  const inputId = useId();
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function upload(picked: readonly File[]): Promise<void> {
    setError(null);
    const room = max - files.length;
    if (picked.length > room) {
      setError(`Add at most ${String(max)} files.`);
      return;
    }
    const invalid = picked
      .map((file) => invalidInvoiceFile(file))
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
        const id = await uploadBillFile(api, organizationId, file);
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

  return (
    <div className="text-sm">
      <label htmlFor={inputId}>{label}</label>
      <input
        id={inputId}
        type="file"
        accept={BILL_FILE_ACCEPT}
        multiple
        disabled={disabled || uploading || files.length >= max}
        onChange={(event) => {
          const picked = Array.from(event.target.files ?? []);
          event.target.value = "";
          if (picked.length > 0) void upload(picked);
        }}
        className="mt-1 block w-full text-sm file:mr-3 file:rounded-md file:border file:border-stone-300 file:bg-white file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-stone-700 hover:file:bg-stone-100"
      />
      <p className="mt-1 text-xs text-stone-500">
        A PDF, or a JPEG, PNG, WebP or HEIC image, up to 8 MB.
      </p>
      {uploading ? (
        <p className="mt-1 text-xs text-stone-600">Uploading…</p>
      ) : null}
      {files.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {files.map((file) => (
            <li key={file.id} className="flex items-center gap-3">
              <span className="break-all">{file.name}</span>
              <button
                type="button"
                disabled={disabled || uploading}
                onClick={() =>
                  onChange(files.filter((other) => other.id !== file.id))
                }
                className={textButton}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p className="mt-1 text-error-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
