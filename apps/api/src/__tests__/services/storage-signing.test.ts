import { Effect, Redacted } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { makeR2Storage } from "../../services/storage/r2.js";
import { presignUrl } from "../../services/storage/sigv4.js";

const AWS_EXAMPLE = {
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  service: "s3",
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  signedAt: new Date("2013-05-24T00:00:00Z"),
} as const;

describe("presignUrl", () => {
  it("matches AWS's published presigned GET example", () => {
    // #given
    // https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    const input = {
      ...AWS_EXAMPLE,
      method: "GET",
      path: "/test.txt",
      expiresInSeconds: 86_400,
    } as const;

    // #when
    const url = presignUrl(input);

    // #then
    expect(url).toBe(
      "https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
  });

  it("signs extra headers, so an upload of another type or size is refused", () => {
    // #given
    const upload = {
      ...AWS_EXAMPLE,
      method: "PUT",
      path: "/receipts/a.jpg",
      expiresInSeconds: 300,
    } as const;
    const signed = (headers: Record<string, string>) =>
      new URL(presignUrl({ ...upload, headers }));

    // #when
    const jpeg = signed({
      "Content-Type": "image/jpeg",
      "Content-Length": "10",
    });
    const png = signed({ "Content-Type": "image/png", "Content-Length": "10" });
    const bigger = signed({
      "Content-Type": "image/jpeg",
      "Content-Length": "11",
    });

    // #then
    expect(jpeg.searchParams.get("X-Amz-SignedHeaders")).toBe(
      "content-length;content-type;host",
    );
    const signatures = new Set(
      [jpeg, png, bigger].map((url) => url.searchParams.get("X-Amz-Signature")),
    );
    expect(signatures.size).toBe(3);
  });
});

describe("makeR2Storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const settings = {
    accountId: "0123456789abcdef0123456789abcdef",
    accessKeyId: "r2-key",
    secretAccessKey: Redacted.make("r2-secret"),
    bucket: "expendi-receipts",
  };
  const signedAt = new Date("2026-11-02T08:00:00Z");

  it("presigns a 5-minute PUT on the bucket's path-style R2 endpoint", async () => {
    // #given
    const storage = makeR2Storage(settings, fetch, () => signedAt);

    // #when
    const upload = await Effect.runPromise(
      storage.presignUpload({
        key: "org/1/receipts/2.jpg",
        contentType: "image/jpeg",
        byteSize: 1234,
      }),
    );

    // #then
    const url = new URL(upload.url);
    expect(url.origin).toBe(
      "https://0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com",
    );
    expect(url.pathname).toBe("/expendi-receipts/org/1/receipts/2.jpg");
    expect(url.searchParams.get("X-Amz-Credential")).toBe(
      "r2-key/20261102/auto/s3/aws4_request",
    );
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(upload.expiresAt).toEqual(new Date("2026-11-02T08:05:00Z"));
  });

  it("reads a stored object's size, and null when nothing was uploaded", async () => {
    // #given
    const requests: { url: string; method: string | undefined }[] = [];
    const fakeR2: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push({ url, method: init?.method });
      return Promise.resolve(
        url.includes("/missing.jpg")
          ? new Response(null, { status: 404 })
          : new Response(null, {
              status: 200,
              headers: {
                "content-length": "1234",
                "content-type": "image/jpeg",
              },
            }),
      );
    };
    const storage = makeR2Storage(settings, fakeR2, () => signedAt);

    // #when
    const found = await Effect.runPromise(storage.head("org/1/receipts/2.jpg"));
    const missing = await Effect.runPromise(storage.head("org/1/missing.jpg"));

    // #then
    expect(found).toEqual({ byteSize: 1234, contentType: "image/jpeg" });
    expect(missing).toBeNull();
    expect(requests.map((request) => request.method)).toEqual(["HEAD", "HEAD"]);
    expect(
      new URL(requests[0]?.url ?? "").searchParams.has("X-Amz-Signature"),
    ).toBe(true);
  });

  it("downloads a stored file's bytes through a signed GET, and null when nothing was uploaded", async () => {
    // #given
    const methods: (string | undefined)[] = [];
    const fakeR2: typeof fetch = (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      methods.push(init?.method);
      if (!new URL(url).searchParams.has("X-Amz-Signature")) {
        return Promise.resolve(new Response(null, { status: 403 }));
      }
      return Promise.resolve(
        url.includes("/missing.jpg")
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array([1, 2, 3]), {
              status: 200,
              headers: { "content-type": "image/jpeg" },
            }),
      );
    };
    const storage = makeR2Storage(settings, fakeR2, () => signedAt);

    // #when
    const found = await Effect.runPromise(storage.get("org/1/receipts/2.jpg"));
    const missing = await Effect.runPromise(storage.get("org/1/missing.jpg"));

    // #then
    expect(found).toEqual({
      bytes: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(missing).toBeNull();
    expect(methods).toEqual(["GET", "GET"]);
  });

  it("fails a download R2 refuses", async () => {
    // #given
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const storage = makeR2Storage(
      settings,
      () => Promise.resolve(new Response(null, { status: 500 })),
      () => signedAt,
    );

    // #when
    const result = await Effect.runPromise(
      Effect.either(storage.get("org/1/receipts/2.jpg")),
    );

    // #then
    expect(result).toMatchObject({ left: { code: "UNAVAILABLE" } });
  });
});
