import type { ConfigError } from "effect";
import { Config, Effect, Layer, Option, Redacted } from "effect";

import type { FileStorageShape, PresignedUrl } from "./file-storage.js";
import { FileStorage, StorageError } from "./file-storage.js";
import { presignUrl } from "./sigv4.js";

/**
 * A private Cloudflare R2 bucket through its S3-compatible endpoint
 * (https://developers.cloudflare.com/r2/api/s3/presigned-urls/), signed with
 * SigV4 in-process rather than through an AWS SDK. The token only needs
 * object read and write on this one bucket.
 */

export const UPLOAD_URL_TTL_SECONDS = 5 * 60;
export const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;
const HEAD_URL_TTL_SECONDS = 60;
const HEAD_TIMEOUT_MS = 10_000;
const GET_URL_TTL_SECONDS = 60;
/** A shrunk receipt is a few hundred KB; the slowest R2 answer still fits. */
const GET_TIMEOUT_MS = 20_000;

export interface R2Settings {
  readonly accountId: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: Redacted.Redacted;
  readonly bucket: string;
}

export function makeR2Storage(
  settings: R2Settings,
  fetchImpl: typeof fetch = fetch,
  now: () => Date = () => new Date(),
): FileStorageShape {
  const sign = (
    method: "GET" | "HEAD" | "PUT",
    key: string,
    expiresInSeconds: number,
    headers?: Readonly<Record<string, string>>,
  ): PresignedUrl => {
    const signedAt = now();
    return {
      url: presignUrl({
        method,
        host: `${settings.accountId}.r2.cloudflarestorage.com`,
        path: `/${settings.bucket}/${key}`,
        region: "auto",
        service: "s3",
        accessKeyId: settings.accessKeyId,
        secretAccessKey: Redacted.value(settings.secretAccessKey),
        signedAt,
        expiresInSeconds,
        headers,
      }),
      expiresAt: new Date(signedAt.getTime() + expiresInSeconds * 1000),
    };
  };

  const unavailable = (message: string) =>
    new StorageError({ code: "UNAVAILABLE", message });

  return {
    presignUpload: ({ key, contentType, byteSize }) =>
      Effect.sync(() =>
        sign("PUT", key, UPLOAD_URL_TTL_SECONDS, {
          "content-type": contentType,
          "content-length": String(byteSize),
        }),
      ),
    presignDownload: (key) =>
      Effect.sync(() => sign("GET", key, DOWNLOAD_URL_TTL_SECONDS)),
    head: (key) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(sign("HEAD", key, HEAD_URL_TTL_SECONDS).url, {
            method: "HEAD",
            signal: AbortSignal.timeout(HEAD_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => unavailable("R2 unreachable"),
      }).pipe(
        Effect.flatMap((response) => {
          if (response.status === 404) return Effect.succeed(null);
          if (!response.ok) {
            return Effect.fail(
              unavailable(`R2 answered HTTP ${response.status}`),
            );
          }
          return Effect.succeed({
            byteSize: Number(response.headers.get("content-length") ?? "0"),
            contentType: response.headers.get("content-type"),
          });
        }),
        Effect.tapError((error) =>
          Effect.sync(() => {
            console.warn(`[r2] HEAD failed: ${error.message}`);
          }),
        ),
      ),
    get: (key) =>
      Effect.tryPromise({
        try: () =>
          fetchImpl(sign("GET", key, GET_URL_TTL_SECONDS).url, {
            method: "GET",
            signal: AbortSignal.timeout(GET_TIMEOUT_MS),
            redirect: "error",
          }),
        catch: () => unavailable("R2 unreachable"),
      }).pipe(
        Effect.flatMap((response) => {
          if (response.status === 404) return Effect.succeed(null);
          if (!response.ok) {
            return Effect.fail(
              unavailable(`R2 answered HTTP ${response.status}`),
            );
          }
          return Effect.tryPromise({
            try: () => response.arrayBuffer(),
            catch: () => unavailable("R2 download interrupted"),
          }).pipe(
            Effect.map((body) => ({
              bytes: new Uint8Array(body),
              contentType: response.headers.get("content-type"),
            })),
          );
        }),
        Effect.tapError((error) =>
          Effect.sync(() => {
            console.warn(`[r2] GET failed: ${error.message}`);
          }),
        ),
      ),
  };
}

const notConfigured = Effect.fail(
  new StorageError({
    code: "NOT_CONFIGURED",
    message:
      "R2 isn't configured: set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET",
  }),
);

const unconfigured: FileStorageShape = {
  presignUpload: () => notConfigured,
  presignDownload: () => notConfigured,
  head: () => notConfigured,
  get: () => notConfigured,
};

/**
 * Optional: without all four settings the API still starts, and receipt
 * uploads answer that they aren't set up yet.
 */
export const FileStorageLive: Layer.Layer<
  FileStorage,
  ConfigError.ConfigError
> = Layer.effect(
  FileStorage,
  Effect.gen(function* () {
    const settings = yield* Config.option(
      Config.all({
        accountId: Config.string("R2_ACCOUNT_ID"),
        accessKeyId: Config.string("R2_ACCESS_KEY_ID"),
        secretAccessKey: Config.redacted("R2_SECRET_ACCESS_KEY"),
        bucket: Config.string("R2_BUCKET"),
      }),
    );
    if (Option.isNone(settings)) {
      console.warn(
        "[r2] R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and R2_BUCKET aren't all set; receipts can't be uploaded",
      );
      return unconfigured;
    }
    return makeR2Storage(settings.value);
  }),
);
