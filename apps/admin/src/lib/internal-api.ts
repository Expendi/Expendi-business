import type {
  AccountingSync,
  AccountingSyncsQuery,
  AccountingSyncsResponse,
  AuditSearchQuery,
  AuditSearchResponse,
  ChooseZohoOrganization,
  CompanyDetail,
  CompanySearchQuery,
  CompanySearchResponse,
  ControlsResponse,
  ImportReport,
  ImportRequest,
  IntentQuoteEvidence,
  IntentQuoteQueueQuery,
  IntentQuoteQueueResponse,
  IntentQuoteResolveConfirmed,
  IntentQuoteResolvePrepared,
  IntentQuoteResolvePrepareRequest,
  OpsAlertsResponse,
  PauseConfirmed,
  PausePrepared,
  PausePrepareRequest,
  PayoutQueueQuery,
  PayoutQueueResponse,
  PayoutRefetchResponse,
  ResolveConfirmed,
  ResolvePrepared,
  ResolvePrepareRequest,
  StaffIntentQuoteDetail,
  StaffMeResponse,
  StaffPayoutDetail,
  SystemHealth,
  ZohoAccountsResponse,
  ZohoConnectLinkResponse,
  ZohoMapping,
  ZohoOrganization,
  ZohoStatusResponse,
} from "@expendi-business/shared";
import {
  accountingSyncSchema,
  accountingSyncsResponseSchema,
  auditSearchResponseSchema,
  companyDetailSchema,
  companySearchResponseSchema,
  controlsResponseSchema,
  importReportSchema,
  importResultSchema,
  intentQuoteEvidenceSchema,
  intentQuoteQueueResponseSchema,
  intentQuoteResolveConfirmedSchema,
  intentQuoteResolvePreparedSchema,
  opsAlertsResponseSchema,
  pauseConfirmedSchema,
  pausePreparedSchema,
  payoutQueueResponseSchema,
  payoutRefetchResponseSchema,
  resolveConfirmedSchema,
  resolvePreparedSchema,
  staffIntentQuoteDetailSchema,
  staffMeResponseSchema,
  staffPayoutDetailSchema,
  systemHealthSchema,
  zohoAccountsResponseSchema,
  zohoConnectLinkResponseSchema,
  zohoOrganizationsResponseSchema,
  zohoStatusResponseSchema,
} from "@expendi-business/shared";

import type { ApiClient } from "./api";

/** The API's `/internal/*` routes (spec §6.15). */
export interface InternalApi {
  imports: {
    preview: (companyId: string, input: ImportRequest) => Promise<ImportReport>;
    commit: (
      companyId: string,
      input: ImportRequest,
      previewToken: string,
    ) => Promise<{ runId: string; imported: number; skipped: number }>;
  };
  /** Audits this sign-in; called once per sign-in, before anything else. */
  startSession: () => Promise<StaffMeResponse>;
  getMe: () => Promise<StaffMeResponse>;
  /** Read-only, for every staff role (T27). */
  searchAudit: (query: AuditSearchQuery) => Promise<AuditSearchResponse>;
  /** Read-only, for every staff role (T26): alerts open and resolve on their own. */
  alerts: {
    list: () => Promise<OpsAlertsResponse>;
    health: () => Promise<SystemHealth>;
  };
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
  /**
   * NEAR Intents quotes that need a person: every staff role can look;
   * resolving needs `ops_admin` and a second confirmation.
   */
  intentQuotes: {
    queue: (query: IntentQuoteQueueQuery) => Promise<IntentQuoteQueueResponse>;
    quote: (quoteId: string) => Promise<StaffIntentQuoteDetail>;
    evidence: (quoteId: string) => Promise<IntentQuoteEvidence>;
    prepareResolution: (
      quoteId: string,
      body: IntentQuoteResolvePrepareRequest,
    ) => Promise<IntentQuoteResolvePrepared>;
    confirmResolution: (
      quoteId: string,
      token: string,
    ) => Promise<IntentQuoteResolveConfirmed>;
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
    /** Paid spending pushed to Zoho (T31): counts, and the latest of a status. */
    syncs: (
      companyId: string,
      query: AccountingSyncsQuery,
    ) => Promise<AccountingSyncsResponse>;
    /** Puts a failed sync back in the queue; the API's job retries it. */
    requeueSync: (companyId: string, syncId: string) => Promise<AccountingSync>;
  };
}

export type PauseAction = "pause" | "unpause";

const payoutPath = (payoutId: string, suffix = "") =>
  `/internal/payouts/${encodeURIComponent(payoutId)}${suffix}` as const;

const intentQuotePath = (quoteId: string, suffix = "") =>
  `/internal/intent-quotes/${encodeURIComponent(quoteId)}${suffix}` as const;

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
    imports: {
      preview: (id, input) =>
        client.post(
          `/internal/companies/${encodeURIComponent(id)}/imports/preview`,
          input,
          importReportSchema,
        ),
      commit: (id, input, previewToken) =>
        client.post(
          `/internal/companies/${encodeURIComponent(id)}/imports/commit`,
          { ...input, previewToken },
          importResultSchema,
        ),
    },
    startSession: () =>
      client.post("/internal/session", {}, staffMeResponseSchema),
    getMe: () => client.get("/internal/me", staffMeResponseSchema),
    searchAudit: (query) =>
      client.get(
        `/internal/audit${toQueryString(query)}`,
        auditSearchResponseSchema,
      ),
    alerts: {
      list: () => client.get("/internal/alerts", opsAlertsResponseSchema),
      health: () => client.get("/internal/health", systemHealthSchema),
    },
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
    intentQuotes: {
      queue: (query) =>
        client.get(
          `/internal/intent-quotes${toQueryString(query)}`,
          intentQuoteQueueResponseSchema,
        ),
      quote: (quoteId) =>
        client.get(intentQuotePath(quoteId), staffIntentQuoteDetailSchema),
      evidence: (quoteId) =>
        client.get(
          intentQuotePath(quoteId, "/evidence"),
          intentQuoteEvidenceSchema,
        ),
      prepareResolution: (quoteId, body) =>
        client.post(
          intentQuotePath(quoteId, "/resolve/prepare"),
          body,
          intentQuoteResolvePreparedSchema,
        ),
      confirmResolution: (quoteId, token) =>
        client.post(
          intentQuotePath(quoteId, "/resolve/confirm"),
          { token },
          intentQuoteResolveConfirmedSchema,
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
      syncs: (companyId, query) =>
        client.get(
          zohoPath(companyId, `/syncs${toQueryString(query)}`),
          accountingSyncsResponseSchema,
        ),
      requeueSync: (companyId, syncId) =>
        client.post(
          zohoPath(companyId, `/syncs/${encodeURIComponent(syncId)}/requeue`),
          {},
          accountingSyncSchema,
        ),
    },
  };
}
