import { z } from "zod";

import { expenseKindSchema } from "./claims.js";
import { paidFromAccountKindSchema } from "./company-spending.js";

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

/** A company spending source account and the Paid Through account it posts through. */
export const zohoPaidFromAccountSchema = z.object({
  paidFromAccountId: z.uuid(),
  name: z.string(),
  kind: paidFromAccountKindSchema,
  /** Null: its spending waits in the queue until it's mapped. */
  accountId: z.string().nullable(),
});

export type ZohoPaidFromAccount = z.infer<typeof zohoPaidFromAccountSchema>;

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
  /** Paid Through for petty cash spending (T44). */
  pettyCashAccountId: z.string().nullable(),
  /** The expense account each payroll run posts to (T44). */
  salariesAccountId: z.string().nullable(),
  /** The company's categories that aren't archived, by name. */
  categoryAccounts: z.array(zohoCategoryAccountSchema),
  /** The company's paid-from accounts that aren't archived, by name (T44). */
  paidFromAccounts: z.array(zohoPaidFromAccountSchema),
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
 *
 * The T44 fields may be left out, which keeps what's saved, so a client
 * that predates them can't clear them. Null clears one; spending that needs
 * it then waits in the queue. Given `paidFromAccounts` is the whole list: an
 * account left out of it is unmapped.
 */
export const zohoMappingSchema = z.object({
  categoryAccounts: z.record(
    z.uuid({ error: "Unknown category." }),
    zohoAccountId("Pick an account for every category.").nullable(),
  ),
  paidThroughAccountId: zohoAccountId("Pick the Paid Through account."),
  defaultAccountId: zohoAccountId("Pick the default expense account."),
  pettyCashAccountId: zohoAccountId("Pick the petty cash account.")
    .nullable()
    .optional(),
  salariesAccountId: zohoAccountId("Pick the salaries account.")
    .nullable()
    .optional(),
  paidFromAccounts: z
    .record(
      z.uuid({ error: "Unknown paid-from account." }),
      zohoAccountId("Pick an account for every paid-from account.").nullable(),
    )
    .optional(),
});

export type ZohoMapping = z.infer<typeof zohoMappingSchema>;

const kesCents = z.string().regex(/^\d+$/);

/** What a sync posts, so staff can recognise it. */
export const accountingSyncSubjectSchema = z.object({
  /** A claim, petty cash spending or company spending. */
  expenseKind: expenseKindSchema,
  /** e.g. the claim's merchant. */
  label: z.string(),
  /** The date the expense is posted with. */
  date: z.iso.date(),
  amountKesCents: kesCents,
});

export type AccountingSyncSubject = z.infer<typeof accountingSyncSubjectSchema>;

/** One paid item's push to Zoho Books, as staff see it (spec §6.15, §6.17). */
export const accountingSyncSchema = z.object({
  id: z.uuid(),
  subjectType: accountingSyncSubjectTypeSchema,
  subjectId: z.uuid(),
  /**
   * Null if the item can't be read any more, and always for bills and
   * payroll runs, which only the company's admins and accountants see.
   */
  subject: accountingSyncSubjectSchema.nullable(),
  status: accountingSyncStatusSchema,
  /** Attempts since it was queued or staff last retried it. */
  attempts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** Zoho's expense ID once it's created. */
  externalId: z.string().nullable(),
  receiptAttached: z.boolean(),
  /** When a pending sync is next tried. */
  nextAttemptAt: z.iso.datetime(),
  syncedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  /** For a failed sync, when it failed. */
  updatedAt: z.iso.datetime(),
});

export type AccountingSync = z.infer<typeof accountingSyncSchema>;

/** `GET /internal/companies/:id/zoho/syncs`. */
export const accountingSyncsQuerySchema = z.object({
  status: accountingSyncStatusSchema.default("failed"),
});

export type AccountingSyncsQuery = z.infer<typeof accountingSyncsQuerySchema>;

export const ACCOUNTING_SYNCS_PAGE_SIZE = 100;

export const accountingSyncsResponseSchema = z.object({
  counts: z.object({
    pending: z.number().int().nonnegative(),
    synced: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  }),
  /** The most recently changed syncs with the status asked for. */
  syncs: z.array(accountingSyncSchema).max(ACCOUNTING_SYNCS_PAGE_SIZE),
});

export type AccountingSyncsResponse = z.infer<
  typeof accountingSyncsResponseSchema
>;

export const COMPANY_ZOHO_FAILED_SYNCS_SHOWN = 20;

/**
 * - `not_connected`: there's no connection, or staff disconnected it.
 * - `pending`, `active`, `needs_reconnect`: as `accountingConnectionStatusSchema`.
 */
export const COMPANY_ZOHO_STATUSES = [
  "not_connected",
  "pending",
  "active",
  "needs_reconnect",
] as const;
export const companyZohoStatusSchema = z.enum(COMPANY_ZOHO_STATUSES);
export type CompanyZohoStatus = z.infer<typeof companyZohoStatusSchema>;

/** A paid item that didn't reach Zoho Books, as the company sees it. */
export const companyFailedSyncSchema = z.object({
  id: z.uuid(),
  subjectType: accountingSyncSubjectTypeSchema,
  subjectId: z.uuid(),
  /** e.g. the reimbursement's merchant or the bill's payee; null if it can't be read. */
  label: z.string().nullable(),
  /** Why the last try failed, for people to read. */
  reason: z.string().nullable(),
  failedAt: z.iso.datetime(),
});
export type CompanyFailedSync = z.infer<typeof companyFailedSyncSchema>;

/**
 * `GET /organizations/:id/settings/zoho`: the company's Zoho Books
 * connection, for its admins and accountants. Only Expendi staff connect,
 * reconnect, disconnect or retry, so this is read-only.
 */
export const companyZohoResponseSchema = z.object({
  status: companyZohoStatusSchema,
  /** The Zoho organization the company books to; null until staff choose it. */
  organizationName: z.string().nullable(),
  /** When someone last finished the Zoho sign-in. */
  connectedAt: z.iso.datetime().nullable(),
  /** When an item last reached Zoho. */
  lastSyncedAt: z.iso.datetime().nullable(),
  counts: z.object({
    pending: z.int().nonnegative(),
    synced: z.int().nonnegative(),
    failed: z.int().nonnegative(),
  }),
  /** The most recent failures, newest first. */
  failed: z.array(companyFailedSyncSchema).max(COMPANY_ZOHO_FAILED_SYNCS_SHOWN),
});
export type CompanyZohoResponse = z.infer<typeof companyZohoResponseSchema>;
