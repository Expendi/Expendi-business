import type { QueryClient } from "@tanstack/react-query";
import type { ComponentType, JSX } from "react";

import { AlertsView } from "~/app/(staff)/alerts/_components/alerts-view";
import { AuditLogView } from "~/app/(staff)/audit-log/_components/audit-log-view";
import { CompaniesView } from "~/app/(staff)/companies/_components/companies-view";
import { CompanyView } from "~/app/(staff)/companies/[id]/_components/company-view";
import { ImportView } from "~/app/(staff)/companies/[id]/imports/view";
import { ZohoBooksView } from "~/app/(staff)/companies/[id]/zoho/_components/zoho-books-view";
import { ControlsView } from "~/app/(staff)/controls/_components/controls-view";
import { HealthView } from "~/app/(staff)/health/_components/health-view";
import { IntentQuoteQueueView } from "~/app/(staff)/intent-quotes/_components/intent-quote-queue-view";
import { IntentQuoteView } from "~/app/(staff)/intent-quotes/[id]/_components/intent-quote-view";
import { PayoutQueueView } from "~/app/(staff)/payouts/_components/payout-queue-view";
import { PayoutView } from "~/app/(staff)/payouts/[id]/_components/payout-view";
import { SettingsView } from "~/app/(staff)/settings/_components/settings-view";
import ZohoBooksPage from "~/app/(staff)/zoho-books/page";
import { queryKeys } from "~/lib/query-keys";
import { COMPANY_ID } from "./fixtures/companies";
import {
  CASH_OUT_PROVIDER_PRETIUM_ACTIVE,
  CASH_OUT_PROVIDER_PRETIUM_NOT_READY,
} from "./fixtures/controls";
import { INTENT_QUOTE_ID } from "./fixtures/intent-quotes";
import { PAYOUT_ID, PRETIUM_PAYOUT_ID } from "./fixtures/payouts";

export interface PagePreview {
  /** The real route, so the sidebar marks it current. */
  readonly path: string;
  readonly View: ComponentType;
  /** Replaces some of `seed.ts`'s data, for another state of the same page. */
  readonly seed?: (client: QueryClient) => void;
}

function CompanyPreview(): JSX.Element {
  return <CompanyView companyId={COMPANY_ID} />;
}

function CompanyImportsPreview(): JSX.Element {
  return <ImportView companyId={COMPANY_ID} />;
}

function CompanyZohoPreview(): JSX.Element {
  return <ZohoBooksView companyId={COMPANY_ID} />;
}

function IntentQuotePreview(): JSX.Element {
  return <IntentQuoteView quoteId={INTENT_QUOTE_ID} />;
}

function PayoutPreview(): JSX.Element {
  return <PayoutView payoutId={PAYOUT_ID} />;
}

function PretiumPayoutPreview(): JSX.Element {
  return <PayoutView payoutId={PRETIUM_PAYOUT_ID} />;
}

/**
 * The pages `/dev/preview/[page]` can show. To add one, import its view
 * here and seed what it reads in `seed.ts` (or answer it in
 * `preview-api.ts`).
 */
export const PAGE_PREVIEWS: Readonly<Record<string, PagePreview>> = {
  alerts: { path: "/alerts", View: AlertsView },
  "audit-log": { path: "/audit-log", View: AuditLogView },
  companies: { path: "/companies", View: CompaniesView },
  company: { path: `/companies/${COMPANY_ID}`, View: CompanyPreview },
  "company-imports": {
    path: `/companies/${COMPANY_ID}/imports`,
    View: CompanyImportsPreview,
  },
  "company-zoho": {
    path: `/companies/${COMPANY_ID}/zoho`,
    View: CompanyZohoPreview,
  },
  controls: { path: "/controls", View: ControlsView },
  "controls-pretium-active": {
    path: "/controls",
    View: ControlsView,
    seed: (client) =>
      client.setQueryData(
        queryKeys.cashOutProvider(),
        CASH_OUT_PROVIDER_PRETIUM_ACTIVE,
      ),
  },
  "controls-pretium-not-ready": {
    path: "/controls",
    View: ControlsView,
    seed: (client) =>
      client.setQueryData(
        queryKeys.cashOutProvider(),
        CASH_OUT_PROVIDER_PRETIUM_NOT_READY,
      ),
  },
  health: { path: "/health", View: HealthView },
  "intent-quote": {
    path: `/intent-quotes/${INTENT_QUOTE_ID}`,
    View: IntentQuotePreview,
  },
  "intent-quotes": { path: "/intent-quotes", View: IntentQuoteQueueView },
  payout: { path: `/payouts/${PAYOUT_ID}`, View: PayoutPreview },
  "payout-pretium": {
    path: `/payouts/${PRETIUM_PAYOUT_ID}`,
    View: PretiumPayoutPreview,
  },
  payouts: { path: "/payouts", View: PayoutQueueView },
  settings: { path: "/settings", View: SettingsView },
  "zoho-books": { path: "/zoho-books", View: ZohoBooksPage },
};
