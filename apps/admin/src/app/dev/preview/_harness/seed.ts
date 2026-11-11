import type { QueryClient } from "@tanstack/react-query";

import { queryKeys } from "~/lib/query-keys";
import { OPS_ALERTS, SYSTEM_HEALTH } from "./fixtures/alerts";
import { AUDIT_ENTRIES } from "./fixtures/audit";
import {
  COMPANIES,
  COMPANY_ID,
  companyDetail,
  CONTROLS,
} from "./fixtures/companies";
import {
  INTENT_QUOTE_DETAIL,
  INTENT_QUOTE_EVIDENCE,
  INTENT_QUOTE_ID,
  INTENT_QUOTES,
} from "./fixtures/intent-quotes";
import { PAYOUT_DETAIL, PAYOUT_ID, PAYOUTS } from "./fixtures/payouts";
import {
  ZOHO_ACCOUNTS,
  ZOHO_ORGANIZATIONS,
  ZOHO_STATUS,
  zohoSyncs,
} from "./fixtures/zoho";

const PAGE_SIZE = 50;

/**
 * Every query the previewed pages read first, under the keys their hooks
 * use, so they render without a request. Anything else (a filter, another
 * sync tab) is answered by `preview-api.ts`.
 */
export function seedSampleData(client: QueryClient): void {
  client.setQueryData(
    queryKeys.companies({ search: "", cursor: undefined, limit: PAGE_SIZE }),
    { companies: COMPANIES, nextCursor: null },
  );
  client.setQueryData(
    queryKeys.company(COMPANY_ID),
    companyDetail(COMPANY_ID, PAYOUTS),
  );
  client.setQueryData(
    queryKeys.payoutQueue({
      status: undefined,
      companyId: undefined,
      cursor: undefined,
      limit: PAGE_SIZE,
    }),
    {
      payouts: PAYOUTS.filter(
        (payout) =>
          payout.status === "needs_review" || payout.status === "failed",
      ),
      nextCursor: null,
    },
  );
  client.setQueryData(queryKeys.payout(PAYOUT_ID), PAYOUT_DETAIL);
  client.setQueryData(
    queryKeys.intentQuoteQueue({
      companyId: undefined,
      cursor: undefined,
      limit: PAGE_SIZE,
    }),
    { quotes: INTENT_QUOTES, nextCursor: null },
  );
  client.setQueryData(
    queryKeys.intentQuote(INTENT_QUOTE_ID),
    INTENT_QUOTE_DETAIL,
  );
  client.setQueryData(
    queryKeys.intentQuoteEvidence(INTENT_QUOTE_ID),
    INTENT_QUOTE_EVIDENCE,
  );
  client.setQueryData(queryKeys.opsAlerts(), OPS_ALERTS);
  client.setQueryData(queryKeys.systemHealth(), SYSTEM_HEALTH);
  client.setQueryData(queryKeys.controls(), CONTROLS);
  client.setQueryData(
    queryKeys.auditSearch({ cursor: undefined, limit: PAGE_SIZE }),
    { entries: AUDIT_ENTRIES, nextCursor: null },
  );
  client.setQueryData(queryKeys.zoho(COMPANY_ID), ZOHO_STATUS);
  client.setQueryData(
    queryKeys.zohoOrganizations(COMPANY_ID),
    ZOHO_ORGANIZATIONS,
  );
  client.setQueryData(queryKeys.zohoAccounts(COMPANY_ID), ZOHO_ACCOUNTS);
  client.setQueryData(
    queryKeys.zohoSyncs(COMPANY_ID, { status: "failed" }),
    zohoSyncs("failed"),
  );
}
