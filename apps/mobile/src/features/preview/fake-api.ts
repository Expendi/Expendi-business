/** DEV PREVIEW — a read-only ApiClient that answers GETs from fixtures. */
import type { ApiClient } from "~/lib/api";
import type { PreviewRoute } from "./types";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "./types";

export function createPreviewApi(routes: readonly PreviewRoute[]): ApiClient {
  const readOnly = () =>
    Promise.reject(new Error("The preview is read-only."));
  return {
    get: (path, schema) => {
      const route = routes.find((entry) => entry.path.test(path));
      if (!route) {
        console.warn(`[preview] no fixture for GET ${path}`);
        return Promise.reject(new Error(`No preview fixture for ${path}`));
      }
      if (route.data === PREVIEW_PENDING) return new Promise(() => undefined);
      if (route.data === PREVIEW_FAIL) {
        return Promise.reject(new Error("Preview: offline"));
      }
      return Promise.resolve(schema.parse(route.data));
    },
    post: readOnly,
    patch: readOnly,
    delete: readOnly,
  };
}
