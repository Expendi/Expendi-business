import type { ComponentType, JSX } from "react";

import { AlertsView } from "~/app/(staff)/alerts/_components/alerts-view";
import { AuditLogView } from "~/app/(staff)/audit-log/_components/audit-log-view";
import { CompaniesView } from "~/app/(staff)/companies/_components/companies-view";
import { CompanyView } from "~/app/(staff)/companies/[id]/_components/company-view";
import { ImportView } from "~/app/(staff)/companies/[id]/imports/view";
import { ZohoBooksView } from "~/app/(staff)/companies/[id]/zoho/_components/zoho-books-view";
import { ControlsView } from "~/app/(staff)/controls/_components/controls-view";
import { HealthView } from "~/app/(staff)/health/_components/health-view";
import { PayoutQueueView } from "~/app/(staff)/payouts/_components/payout-queue-view";
import { PayoutView } from "~/app/(staff)/payouts/[id]/_components/payout-view";
import ZohoBooksPage from "~/app/(staff)/zoho-books/page";
import { COMPANY_ID } from "./fixtures/companies";
import { PAYOUT_ID } from "./fixtures/payouts";

export interface PagePreview {
  /** The real route, so the sidebar marks it current. */
  readonly path: string;
  readonly View: ComponentType;
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

function PayoutPreview(): JSX.Element {
  return <PayoutView payoutId={PAYOUT_ID} />;
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
  health: { path: "/health", View: HealthView },
  payout: { path: `/payouts/${PAYOUT_ID}`, View: PayoutPreview },
  payouts: { path: "/payouts", View: PayoutQueueView },
  "zoho-books": { path: "/zoho-books", View: ZohoBooksPage },
};
