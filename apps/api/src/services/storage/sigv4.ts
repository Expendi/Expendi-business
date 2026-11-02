import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4 presigned URLs (query-string auth), which R2
 * accepts as an S3-compatible store:
 * https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
 * The payload is `UNSIGNED-PAYLOAD`, so headers listed in `headers` are what
 * pins down an upload, e.g. its type and size.
 */

const ALGORITHM = "AWS4-HMAC-SHA256";

export interface PresignInput {
  readonly method: "GET" | "HEAD" | "PUT";
  readonly host: string;
  /** Unencoded, starting with `/`, e.g. `/bucket/org/1/receipts/2.jpg`. */
  readonly path: string;
  readonly region: string;
  readonly service: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly signedAt: Date;
  readonly expiresInSeconds: number;
  /** Headers the request must send with exactly these values; `host` is always signed. */
  readonly headers?: Readonly<Record<string, string>>;
}

/** RFC 3986 encoding of everything but unreserved characters, as SigV4 requires. */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

/** `20130524T000000Z` */
function amzDate(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

export function presignUrl(input: PresignInput): string {
  const timestamp = amzDate(input.signedAt);
  const day = timestamp.slice(0, 8);
  const scope = `${day}/${input.region}/${input.service}/aws4_request`;

  const headers = new Map<string, string>([["host", input.host]]);
  for (const [name, value] of Object.entries(input.headers ?? {})) {
    headers.set(name.toLowerCase(), value.trim());
  }
  const headerNames = [...headers.keys()].sort();
  const signedHeaders = headerNames.join(";");

  const query: readonly (readonly [string, string])[] = [
    ["X-Amz-Algorithm", ALGORITHM],
    ["X-Amz-Credential", `${input.accessKeyId}/${scope}`],
    ["X-Amz-Date", timestamp],
    ["X-Amz-Expires", String(input.expiresInSeconds)],
    ["X-Amz-SignedHeaders", signedHeaders],
  ];
  const canonicalQuery = query
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .sort()
    .join("&");
  const canonicalPath = input.path.split("/").map(uriEncode).join("/");

  const canonicalRequest = [
    input.method,
    canonicalPath,
    canonicalQuery,
    headerNames.map((name) => `${name}:${headers.get(name)}\n`).join(""),
    signedHeaders,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    ALGORITHM,
    timestamp,
    scope,
    sha256Hex(canonicalRequest),
  ].join("\n");

  const signingKey = [input.region, input.service, "aws4_request"].reduce(
    hmac,
    hmac(`AWS4${input.secretAccessKey}`, day),
  );
  const signature = createHmac("sha256", signingKey)
    .update(stringToSign, "utf8")
    .digest("hex");

  return `https://${input.host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
