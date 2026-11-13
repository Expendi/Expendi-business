import type {
  AccountingSyncsQuery,
  AuditSearchQuery,
  CompanySearchQuery,
  IntentQuoteQueueQuery,
  PayoutQueueQuery,
} from "@expendi-business/shared";

export const queryKeys = {
  staffMe: (privyUserId: string) => ["internal", "me", privyUserId] as const,
  auditSearch: (query: AuditSearchQuery) =>
    ["internal", "audit", query] as const,
  opsAlerts: () => ["internal", "alerts"] as const,
  systemHealth: () => ["internal", "health"] as const,
  companies: (query: CompanySearchQuery) =>
    ["internal", "companies", query] as const,
  company: (companyId: string) => ["internal", "company", companyId] as const,
  companyTreasury: (companyId: string) =>
    ["internal", "company", companyId, "treasury"] as const,
  payoutQueue: (query: PayoutQueueQuery) =>
    ["internal", "payouts", query] as const,
  payout: (payoutId: string) => ["internal", "payout", payoutId] as const,
  intentQuoteQueue: (query: IntentQuoteQueueQuery) =>
    ["internal", "intent-quotes", query] as const,
  intentQuote: (quoteId: string) =>
    ["internal", "intent-quote", quoteId] as const,
  intentQuoteEvidence: (quoteId: string) =>
    ["internal", "intent-quote", quoteId, "evidence"] as const,
  controls: () => ["internal", "controls"] as const,
  cashOutProvider: () => ["internal", "controls", "cash-out-provider"] as const,
  zoho: (companyId: string) => ["internal", "zoho", companyId] as const,
  zohoOrganizations: (companyId: string) =>
    ["internal", "zoho", companyId, "organizations"] as const,
  zohoAccounts: (companyId: string) =>
    ["internal", "zoho", companyId, "accounts"] as const,
  zohoSyncs: (companyId: string, query?: AccountingSyncsQuery) =>
    query
      ? (["internal", "zoho", companyId, "syncs", query] as const)
      : (["internal", "zoho", companyId, "syncs"] as const),
};
