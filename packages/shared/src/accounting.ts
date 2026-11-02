import { z } from "zod";

/** Accounting systems paid spending is pushed to (spec §6.17). */
export const ACCOUNTING_PROVIDERS = ["zoho_books"] as const;
export const accountingProviderSchema = z.enum(ACCOUNTING_PROVIDERS);
export type AccountingProvider = z.infer<typeof accountingProviderSchema>;

/**
 * - `pending`: waiting for the Zoho sign-in, or for staff to pick the Zoho
 *   organization.
 * - `active`: signed in, with a KES organization chosen.
 * - `needs_reconnect`: Zoho rejected the stored token; syncing pauses until
 *   someone signs in again through a new connect link.
 * - `disconnected`: staff disconnected it and the token is gone.
 */
export const ACCOUNTING_CONNECTION_STATUSES = [
  "pending",
  "active",
  "needs_reconnect",
  "disconnected",
] as const;
export const accountingConnectionStatusSchema = z.enum(
  ACCOUNTING_CONNECTION_STATUSES,
);
export type AccountingConnectionStatus = z.infer<
  typeof accountingConnectionStatusSchema
>;

export const ACCOUNTING_SYNC_SUBJECT_TYPES = [
  "expense",
  "bill",
  "payroll_run",
] as const;
export const accountingSyncSubjectTypeSchema = z.enum(
  ACCOUNTING_SYNC_SUBJECT_TYPES,
);
export type AccountingSyncSubjectType = z.infer<
  typeof accountingSyncSubjectTypeSchema
>;

export const ACCOUNTING_SYNC_STATUSES = [
  "pending",
  "synced",
  "failed",
] as const;
export const accountingSyncStatusSchema = z.enum(ACCOUNTING_SYNC_STATUSES);
export type AccountingSyncStatus = z.infer<typeof accountingSyncStatusSchema>;

/** Expendi only books in KES, so the Zoho organization must too (spec §6.17). */
export const ZOHO_REQUIRED_CURRENCY = "KES";

export const zohoCategoryAccountSchema = z.object({
  categoryId: z.uuid(),
  categoryName: z.string(),
  /** Null: the category posts to the default account. */
  accountId: z.string().nullable(),
});

export type ZohoCategoryAccount = z.infer<typeof zohoCategoryAccountSchema>;

/** A company's Zoho Books connection, as staff see it. Never carries a token. */
export const zohoConnectionSchema = z.object({
  id: z.uuid(),
  status: accountingConnectionStatusSchema,
  /** When someone last finished the Zoho sign-in; null until they do. */
  connectedAt: z.iso.datetime().nullable(),
  /** The latest connect link, until it's used. */
  connectLink: z
    .object({ expiresAt: z.iso.datetime(), expired: z.boolean() })
    .nullable(),
  organization: z.object({ id: z.string(), name: z.string() }).nullable(),
  /** The Zoho data centre's API domain, e.g. https://www.zohoapis.eu. */
  apiDomain: z.string().nullable(),
  paidThroughAccountId: z.string().nullable(),
  defaultAccountId: z.string().nullable(),
  /** The company's categories that aren't archived, by name. */
  categoryAccounts: z.array(zohoCategoryAccountSchema),
});

export type ZohoConnection = z.infer<typeof zohoConnectionSchema>;

/** `GET /internal/companies/:id/zoho`. */
export const zohoStatusResponseSchema = z.object({
  /** False until the API has its Zoho client and token key. */
  configured: z.boolean(),
  /** The company's connection that isn't disconnected, if any. */
  connection: zohoConnectionSchema.nullable(),
});

export type ZohoStatusResponse = z.infer<typeof zohoStatusResponseSchema>;

/** `POST /internal/companies/:id/zoho/connect-link`: the only time the URL is shown. */
export const zohoConnectLinkResponseSchema = z.object({
  url: z.url(),
  expiresAt: z.iso.datetime(),
});

export type ZohoConnectLinkResponse = z.infer<
  typeof zohoConnectLinkResponseSchema
>;

export const zohoOrganizationSchema = z.object({
  id: z.string(),
  name: z.string(),
  currencyCode: z.string(),
});

export type ZohoOrganization = z.infer<typeof zohoOrganizationSchema>;

/** `GET /internal/companies/:id/zoho/organizations`. */
export const zohoOrganizationsResponseSchema = z.array(zohoOrganizationSchema);

/** `POST /internal/companies/:id/zoho/organization`. */
export const chooseZohoOrganizationSchema = z.object({
  externalOrganizationId: z
    .string({ error: "Pick a Zoho organization." })
    .trim()
    .min(1, "Pick a Zoho organization."),
});

export type ChooseZohoOrganization = z.infer<
  typeof chooseZohoOrganizationSchema
>;

export const zohoAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string().nullable(),
  /** Zoho's account type, e.g. `expense` or `bank`. */
  type: z.string(),
});

export type ZohoAccount = z.infer<typeof zohoAccountSchema>;

/** `GET /internal/companies/:id/zoho/accounts`: active accounts only. */
export const zohoAccountsResponseSchema = z.object({
  expenseAccounts: z.array(zohoAccountSchema),
  paidThroughAccounts: z.array(zohoAccountSchema),
});

export type ZohoAccountsResponse = z.infer<typeof zohoAccountsResponseSchema>;

const zohoAccountId = (message: string) =>
  z.string({ error: message }).trim().min(1, message);

/**
 * `PUT /internal/companies/:id/zoho/mapping`: the whole mapping. A category
 * left out, or mapped to null, posts to the default account.
 */
export const zohoMappingSchema = z.object({
  categoryAccounts: z.record(
    z.uuid({ error: "Unknown category." }),
    zohoAccountId("Pick an account for every category.").nullable(),
  ),
  paidThroughAccountId: zohoAccountId("Pick the Paid Through account."),
  defaultAccountId: zohoAccountId("Pick the default expense account."),
});

export type ZohoMapping = z.infer<typeof zohoMappingSchema>;
