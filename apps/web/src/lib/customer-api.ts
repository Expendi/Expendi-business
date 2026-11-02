import type {
  MeResponse,
  UpdateMeRequest,
  UpdateMeResponse,
} from "@expendi-business/shared";
import {
  meResponseSchema,
  updateMeResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "./api";

/**
 * The API's customer routes (`/me`, `/organizations/*`), the same ones the
 * app calls. The API allows this site's origin through `DASHBOARD_ORIGINS`
 * and keeps every role rule itself.
 */
export interface CustomerApi {
  /** Also activates invites sent to someone who already had a login. */
  getMe: () => Promise<MeResponse>;
  updateMe: (body: UpdateMeRequest) => Promise<UpdateMeResponse>;
}

export function createCustomerApi(client: ApiClient): CustomerApi {
  return {
    getMe: () => client.get("/me", meResponseSchema),
    updateMe: (body) => client.patch("/me", body, updateMeResponseSchema),
  };
}
