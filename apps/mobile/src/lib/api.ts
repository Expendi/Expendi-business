import { z } from "zod";

const REQUEST_TIMEOUT_MS = 20_000;

/** Mirrors `clientErrorResponse` / `internalErrorResponse` in `apps/api/src/http/respond.ts`. */
const errorBodySchema = z.object({
  success: z.literal(false),
  error: z.object({ _tag: z.string(), message: z.string() }),
});

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly tag: string,
    message: string,
  ) {
    super(message);
  }
}

type ApiPath = `/${string}`;
type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export interface ApiClient {
  get<T>(path: ApiPath, schema: z.ZodType<T>): Promise<T>;
  post<T>(path: ApiPath, body: unknown, schema: z.ZodType<T>): Promise<T>;
  patch<T>(path: ApiPath, body: unknown, schema: z.ZodType<T>): Promise<T>;
  delete<T>(path: ApiPath, schema: z.ZodType<T>): Promise<T>;
}

export interface ApiClientOptions {
  baseUrl: string;
  getAccessToken: () => Promise<string | null>;
}

export function createApiClient({
  baseUrl,
  getAccessToken,
}: ApiClientOptions): ApiClient {
  const origin = baseUrl.replace(/\/+$/, "");

  async function request<T>(
    method: HttpMethod,
    path: ApiPath,
    schema: z.ZodType<T>,
    body?: unknown,
  ): Promise<T> {
    const token = await getAccessToken();
    if (!token) {
      throw new ApiError(
        401,
        "Unauthorized",
        "Your session ended. Sign in again.",
      );
    }

    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchWithTimeout(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await readJson(response);

    if (!response.ok) throw toApiError(response.status, payload);

    const parsed = z
      .object({ success: z.literal(true), data: schema })
      .safeParse(payload);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        "InvalidResponse",
        "The server sent a response this version of the app can't read.",
      );
    }
    return parsed.data.data;
  }

  return {
    get: (path, schema) => request("GET", path, schema),
    post: (path, body, schema) => request("POST", path, schema, body),
    patch: (path, body, schema) => request("PATCH", path, schema, body),
    delete: (path, schema) => request("DELETE", path, schema),
  };
}

export function describeApiError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return "Couldn't reach Expendi Business. Check your connection and try again.";
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    return null;
  }
}

function toApiError(status: number, payload: unknown): ApiError {
  const parsed = errorBodySchema.safeParse(payload);
  if (parsed.success) {
    return new ApiError(
      status,
      parsed.data.error._tag,
      parsed.data.error.message,
    );
  }
  return new ApiError(
    status,
    "HttpError",
    `The server returned an unexpected error (${status}).`,
  );
}
