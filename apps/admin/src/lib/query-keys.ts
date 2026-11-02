import type {
  AuditSearchQuery,
  CompanySearchQuery,
  PayoutQueueQuery,
} from "@expendi-business/shared";

export const queryKeys = {
  staffMe: (privyUserId: string) => ["internal", "me", privyUserId] as const,
  auditSearch: (query: AuditSearchQuery) =>
    ["internal", "audit", query] as const,
  companies: (query: CompanySearchQuery) =>
    ["internal", "companies", query] as const,
  company: (companyId: string) => ["internal", "company", companyId] as const,
  payoutQueue: (query: PayoutQueueQuery) =>
    ["internal", "payouts", query] as const,
  payout: (payoutId: string) => ["internal", "payout", payoutId] as const,
  controls: () => ["internal", "controls"] as const,
  zoho: (companyId: string) => ["internal", "zoho", companyId] as const,
  zohoOrganizations: (companyId: string) =>
    ["internal", "zoho", companyId, "organizations"] as const,
  zohoAccounts: (companyId: string) =>
    ["internal", "zoho", companyId, "accounts"] as const,
};
