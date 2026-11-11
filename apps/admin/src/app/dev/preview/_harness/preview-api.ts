import type { z } from "zod";

import type { AccountingSyncStatus } from "@expendi-business/shared";
import { accountingSyncStatusSchema } from "@expendi-business/shared";

import type { ApiClient } from "~/lib/api";
import { ApiError } from "~/lib/api";
import { OPS_ALERTS, SYSTEM_HEALTH } from "./fixtures/alerts";
import { AUDIT_ENTRIES } from "./fixtures/audit";
import { COMPANIES, companyDetail, CONTROLS } from "./fixtures/companies";
import {
  INTENT_QUOTE_EVIDENCE,
  INTENT_QUOTES,
  intentQuoteDetail,
} from "./fixtures/intent-quotes";
import { payoutDetail, PAYOUTS } from "./fixtures/payouts";
import {
  ZOHO_ACCOUNTS,
  ZOHO_ORGANIZATIONS,
  ZOHO_STATUS,
  zohoSyncs,
} from "./fixtures/zoho";

interface Route {
  readonly pattern: RegExp;
  readonly respond: (
    match: RegExpMatchArray,
    query: URLSearchParams,
  ) => unknown;
}

function syncStatus(query: URLSearchParams): AccountingSyncStatus {
  const parsed = accountingSyncStatusSchema.safeParse(query.get("status"));
  return parsed.success ? parsed.data : "failed";
}

const ROUTES: readonly Route[] = [
  {
    pattern: /^\/internal\/audit$/,
    respond: () => ({ entries: AUDIT_ENTRIES, nextCursor: null }),
  },
  { pattern: /^\/internal\/alerts$/, respond: () => OPS_ALERTS },
  { pattern: /^\/internal\/health$/, respond: () => SYSTEM_HEALTH },
  { pattern: /^\/internal\/controls$/, respond: () => CONTROLS },
  {
    pattern: /^\/internal\/companies$/,
    respond: (_match, query) => {
      const search = (query.get("search") ?? "").toLowerCase();
      return {
        companies: COMPANIES.filter(
          (company) =>
            company.name.toLowerCase().includes(search) ||
            company.kraPin?.toLowerCase() === search,
        ),
        nextCursor: null,
      };
    },
  },
  {
    pattern: /^\/internal\/companies\/([^/]+)\/zoho\/organizations$/,
    respond: () => ZOHO_ORGANIZATIONS,
  },
  {
    pattern: /^\/internal\/companies\/([^/]+)\/zoho\/accounts$/,
    respond: () => ZOHO_ACCOUNTS,
  },
  {
    pattern: /^\/internal\/companies\/([^/]+)\/zoho\/syncs$/,
    respond: (_match, query) => zohoSyncs(syncStatus(query)),
  },
  {
    pattern: /^\/internal\/companies\/([^/]+)\/zoho$/,
    respond: () => ZOHO_STATUS,
  },
  {
    pattern: /^\/internal\/companies\/([^/]+)$/,
    respond: (match) => companyDetail(match[1] ?? "", PAYOUTS),
  },
  {
    pattern: /^\/internal\/payouts$/,
    respond: (_match, query) => {
      const status = query.get("status");
      const companyId = query.get("companyId");
      return {
        payouts: PAYOUTS.filter((payout) =>
          status
            ? payout.status === status
            : payout.status === "needs_review" || payout.status === "failed",
        ).filter(
          (payout) => !companyId || payout.organization.id === companyId,
        ),
        nextCursor: null,
      };
    },
  },
  {
    pattern: /^\/internal\/intent-quotes$/,
    respond: (_match, query) => {
      const companyId = query.get("companyId");
      return {
        quotes: INTENT_QUOTES.filter(
          (quote) => !companyId || quote.organization.id === companyId,
        ),
        nextCursor: null,
      };
    },
  },
  {
    pattern: /^\/internal\/intent-quotes\/([^/]+)\/evidence$/,
    respond: () => INTENT_QUOTE_EVIDENCE,
  },
  {
    pattern: /^\/internal\/intent-quotes\/([^/]+)$/,
    respond: (match) => intentQuoteDetail(match[1] ?? ""),
  },
  {
    pattern: /^\/internal\/payouts\/([^/]+)$/,
    respond: (match) => payoutDetail(match[1] ?? ""),
  },
];

/**
 * The preview's API: nothing leaves the browser. Reads are answered from the
 * sample data (and checked against the shared schemas, so a stale fixture
 * shows up as an error); a read with no sample data stays loading and is
 * named in the console; a write fails with a clear error, so forms show
 * their error state.
 */
export function createPreviewApi(): ApiClient {
  const read = <T>(path: string, schema: z.ZodType<T>): Promise<T> => {
    const url = new URL(path, "http://preview.invalid");
    for (const route of ROUTES) {
      const match = url.pathname.match(route.pattern);
      if (match) {
        return Promise.resolve(
          schema.parse(route.respond(match, url.searchParams)),
        );
      }
    }
    console.info(
      `[preview] GET ${path} has no sample data. Add it in app/dev/preview/_harness/preview-api.ts.`,
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
    get: read,
    post: (path) => write("POST", path),
    put: (path) => write("PUT", path),
    patch: (path) => write("PATCH", path),
    delete: (path) => write("DELETE", path),
  };
}
