import type { TreasuryMoveRequest } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import { previewFor } from "./fixtures/treasury";

/**
 * The preview's API: nothing leaves the browser. A read that wasn't seeded
 * stays loading and is named in the console; a write fails with a clear
 * error, so forms show their error state.
 */
export function createPreviewApi(): ApiClient {
  const read = (path: string): Promise<never> => {
    console.info(
      `[preview] GET ${path} has no sample data. Seed it in app/dev/preview/_harness/seed.ts.`,
    );
    return new Promise<never>(() => undefined);
  };
  const write = (method: string, path: string): Promise<never> =>
    Promise.reject(
      new ApiError(
        503,
        "Preview",
        `The preview doesn't send changes (${method} ${path}).`,
      ),
    );
  return {
    get: (path) => read(path),
    post: (path, body, schema) =>
      path.endsWith("/treasury/moves/preview")
        ? Promise.resolve(schema.parse(previewFor(body as TreasuryMoveRequest)))
        : write("POST", path),
    put: (path) => write("PUT", path),
    patch: (path) => write("PATCH", path),
    delete: (path) => write("DELETE", path),
  };
}
