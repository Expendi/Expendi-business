import type {
  AuditSearchQuery,
  AuditSearchResponse,
  ChooseZohoOrganization,
  CompanyDetail,
  CompanySearchQuery,
  CompanySearchResponse,
  ControlsResponse,
  PauseConfirmed,
  PausePrepared,
  PausePrepareRequest,
  PayoutQueueQuery,
  PayoutQueueResponse,
  PayoutRefetchResponse,
  ResolveConfirmed,
  ResolvePrepared,
  ResolvePrepareRequest,
  StaffMeResponse,
  StaffPayoutDetail,
  ZohoAccountsResponse,
  ZohoConnectLinkResponse,
  ZohoMapping,
  ZohoOrganization,
  ZohoStatusResponse,
} from "@expendi-business/shared";
import {
  auditSearchResponseSchema,
  companyDetailSchema,
  companySearchResponseSchema,
  controlsResponseSchema,
  pauseConfirmedSchema,
  pausePreparedSchema,
  payoutQueueResponseSchema,
  payoutRefetchResponseSchema,
  resolveConfirmedSchema,
  resolvePreparedSchema,
  staffMeResponseSchema,
  staffPayoutDetailSchema,
  zohoAccountsResponseSchema,
  zohoConnectLinkResponseSchema,
  zohoOrganizationsResponseSchema,
  zohoStatusResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "./api";

/** The API's `/internal/*` routes (spec §6.15). */
export interface InternalApi {
  /** Audits this sign-in; called once per sign-in, before anything else. */
  startSession: () => Promise<StaffMeResponse>;
  getMe: () => Promise<StaffMeResponse>;
  /** Read-only, for every staff role (T27). */
  searchAudit: (query: AuditSearchQuery) => Promise<AuditSearchResponse>;
  /** Companies, the payout queue and the pause (T24); actions need `ops_admin`. */
  ops: {
    searchCompanies: (
      query: CompanySearchQuery,
    ) => Promise<CompanySearchResponse>;
    company: (companyId: string) => Promise<CompanyDetail>;
    payoutQueue: (query: PayoutQueueQuery) => Promise<PayoutQueueResponse>;
    payout: (payoutId: string) => Promise<StaffPayoutDetail>;
    refetchPayout: (payoutId: string) => Promise<PayoutRefetchResponse>;
    prepareResolution: (
      payoutId: string,
      body: ResolvePrepareRequest,
    ) => Promise<ResolvePrepared>;
    confirmResolution: (
      payoutId: string,
      token: string,
    ) => Promise<ResolveConfirmed>;
    controls: () => Promise<ControlsResponse>;
    preparePause: (
      action: PauseAction,
      body: PausePrepareRequest,
    ) => Promise<PausePrepared>;
    confirmPause: (
      action: PauseAction,
      token: string,
    ) => Promise<PauseConfirmed>;
  };
  /** A company's Zoho Books connection (T30); changes need `ops_admin`. */
  zoho: {
    status: (companyId: string) => Promise<ZohoStatusResponse>;
    createConnectLink: (companyId: string) => Promise<ZohoConnectLinkResponse>;
    organizations: (companyId: string) => Promise<ZohoOrganization[]>;
    chooseOrganization: (
      companyId: string,
      body: ChooseZohoOrganization,
    ) => Promise<ZohoStatusResponse>;
    accounts: (companyId: string) => Promise<ZohoAccountsResponse>;
    saveMapping: (
      companyId: string,
      mapping: ZohoMapping,
    ) => Promise<ZohoStatusResponse>;
    disconnect: (companyId: string) => Promise<ZohoStatusResponse>;
  };
}

export type PauseAction = "pause" | "unpause";

const payoutPath = (payoutId: string, suffix = "") =>
  `/internal/payouts/${encodeURIComponent(payoutId)}${suffix}` as const;

const zohoPath = (companyId: string, suffix = "") =>
  `/internal/companies/${encodeURIComponent(companyId)}/zoho${suffix}` as const;

/** Leaves out empty values, so a blank filter isn't sent. */
export function toQueryString(params: object): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (
      (typeof value === "string" && value !== "") ||
      typeof value === "number"
    ) {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export function createInternalApi(client: ApiClient): InternalApi {
  return {
    startSession: () =>
      client.post("/internal/session", {}, staffMeResponseSchema),
    getMe: () => client.get("/internal/me", staffMeResponseSchema),
    searchAudit: (query) =>
      client.get(
        `/internal/audit${toQueryString(query)}`,
        auditSearchResponseSchema,
      ),
    ops: {
      searchCompanies: (query) =>
        client.get(
          `/internal/companies${toQueryString(query)}`,
          companySearchResponseSchema,
        ),
      company: (companyId) =>
        client.get(
          `/internal/companies/${encodeURIComponent(companyId)}`,
          companyDetailSchema,
        ),
      payoutQueue: (query) =>
        client.get(
          `/internal/payouts${toQueryString(query)}`,
          payoutQueueResponseSchema,
        ),
      payout: (payoutId) =>
        client.get(payoutPath(payoutId), staffPayoutDetailSchema),
      refetchPayout: (payoutId) =>
        client.post(
          payoutPath(payoutId, "/refetch"),
          {},
          payoutRefetchResponseSchema,
        ),
      prepareResolution: (payoutId, body) =>
        client.post(
          payoutPath(payoutId, "/resolve/prepare"),
          body,
          resolvePreparedSchema,
        ),
      confirmResolution: (payoutId, token) =>
        client.post(
          payoutPath(payoutId, "/resolve/confirm"),
          { token },
          resolveConfirmedSchema,
        ),
      controls: () => client.get("/internal/controls", controlsResponseSchema),
      preparePause: (action, body) =>
        client.post(
          `/internal/controls/${action}/prepare`,
          body,
          pausePreparedSchema,
        ),
      confirmPause: (action, token) =>
        client.post(
          `/internal/controls/${action}/confirm`,
          { token },
          pauseConfirmedSchema,
        ),
    },
    zoho: {
      status: (companyId) =>
        client.get(zohoPath(companyId), zohoStatusResponseSchema),
      createConnectLink: (companyId) =>
        client.post(
          zohoPath(companyId, "/connect-link"),
          {},
          zohoConnectLinkResponseSchema,
        ),
      organizations: (companyId) =>
        client.get(
          zohoPath(companyId, "/organizations"),
          zohoOrganizationsResponseSchema,
        ),
      chooseOrganization: (companyId, body) =>
        client.post(
          zohoPath(companyId, "/organization"),
          body,
          zohoStatusResponseSchema,
        ),
      accounts: (companyId) =>
        client.get(
          zohoPath(companyId, "/accounts"),
          zohoAccountsResponseSchema,
        ),
      saveMapping: (companyId, mapping) =>
        client.put(
          zohoPath(companyId, "/mapping"),
          mapping,
          zohoStatusResponseSchema,
        ),
      disconnect: (companyId) =>
        client.post(
          zohoPath(companyId, "/disconnect"),
          {},
          zohoStatusResponseSchema,
        ),
    },
  };
}
