import type { Effect } from "effect";
import { Context, Data } from "effect";

/**
 * Private file storage (spec §9): receipts now, bill attachments and import
 * files later. The phone uploads and downloads directly through short-lived
 * presigned URLs, so file bytes only pass through the API when it works on
 * a file itself.
 */

export type StorageErrorCode = "NOT_CONFIGURED" | "UNAVAILABLE";

/** Its message never includes a key or URL, so it can be logged as it is. */
export class StorageError extends Data.TaggedError("StorageError")<{
  readonly message: string;
  readonly code: StorageErrorCode;
}> {}

export interface PresignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface StoredObject {
  readonly byteSize: number;
  readonly contentType: string | null;
}

export interface StoredFile {
  readonly bytes: Uint8Array;
  readonly contentType: string | null;
}

export interface FileStorageShape {
  /** Stores a file the API made itself, e.g. a monthly export. */
  readonly put: (file: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly contentType: string;
  }) => Effect.Effect<void, StorageError>;
  /** A PUT that only accepts exactly this content type and size. */
  readonly presignUpload: (file: {
    readonly key: string;
    readonly contentType: string;
    readonly byteSize: number;
  }) => Effect.Effect<PresignedUrl, StorageError>;
  readonly presignDownload: (
    key: string,
  ) => Effect.Effect<PresignedUrl, StorageError>;
  /** What is stored under `key`, or null when nothing was uploaded there. */
  readonly head: (
    key: string,
  ) => Effect.Effect<StoredObject | null, StorageError>;
  /**
   * The file's bytes, or null when nothing was uploaded there. Only for
   * work the API does on a file itself, e.g. reading a receipt.
   */
  readonly get: (key: string) => Effect.Effect<StoredFile | null, StorageError>;
}

export class FileStorage extends Context.Tag("FileStorage")<
  FileStorage,
  FileStorageShape
>() {}
