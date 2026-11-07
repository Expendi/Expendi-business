import type { QueryClient } from "@tanstack/react-query";

import type {
  CategoriesResponse,
  CompanyZohoResponse,
  OrganizationResponse,
  PaidFromAccount,
} from "@expendi-business/shared";

import { settingsKeys } from "~/app/(company)/settings/_components/settings-api";
import { billKeys } from "~/features/payment-keys";
import { queryKeys } from "~/lib/query-keys";
import { COMPANY_NAME, ORGANIZATION_ID, sampleId } from "./company";

/** `GET /organizations/:id`, as in docs/mocks/settings.html. */
export const COMPANY_DETAILS: OrganizationResponse = {
  id: ORGANIZATION_ID,
  name: COMPANY_NAME,
  kraPin: "P051234567X",
  role: "admin",
};

const category = (n: number, name: string, etimsNotRequired = false) => ({
  id: sampleId(n),
  name,
  etimsNotRequired,
});

/** The mock's categories in use; Expenses' own list wins when it seeds first. */
export const SETTINGS_CATEGORIES: CategoriesResponse = [
  category(9201, "Air travel", true),
  category(9202, "Airtime & internet"),
  category(9203, "Bank charges", true),
  category(9204, "Equipment"),
  category(9205, "Fuel & transport"),
  category(9206, "Insurance"),
  category(9207, "Meals & entertainment"),
  category(9208, "Office & supplies"),
  category(9209, "Rent & utilities"),
  category(9210, "Repairs & maintenance"),
  category(9211, "Salaries", true),
  category(9212, "Security"),
  category(9213, "Software"),
  category(9214, "Suppliers"),
  category(9215, "Taxes", true),
];

export const ARCHIVED_CATEGORIES: CategoriesResponse = [
  category(9216, "Conference travel"),
  category(9217, "Printing"),
];

function account(
  n: number,
  name: string,
  kind: PaidFromAccount["kind"],
  archived = false,
): PaidFromAccount {
  return {
    id: sampleId(n),
    name,
    kind,
    archived,
    createdAt: "2026-10-01T07:00:00.000Z",
    updatedAt: "2026-10-01T07:00:00.000Z",
  };
}

/** The mock's accounts; Accounts' own list wins when it seeds first. */
export const SETTINGS_ACCOUNTS: PaidFromAccount[] = [
  account(9221, "Company M-Pesa till", "mobile_money"),
  account(9222, "Equity Bank ••4521", "bank"),
  account(9223, "KCB current account ••7781", "bank"),
];

export const ARCHIVED_ACCOUNTS: PaidFromAccount[] = [
  account(9224, "Co-op Bank ••0932", "bank", true),
];

/** `GET …/settings/zoho`: connected, with one item that didn't sync. */
export const ZOHO_STATUS: CompanyZohoResponse = {
  status: "active",
  organizationName: "Mwangaza Logistics Ltd",
  connectedAt: "2026-10-12T12:40:00.000Z",
  lastSyncedAt: "2026-11-06T06:20:00.000Z",
  counts: { pending: 3, synced: 212, failed: 1 },
  failed: [
    {
      id: sampleId(9231),
      subjectType: "bill",
      subjectId: sampleId(9232),
      label: "Zuku, 118-2219",
      reason: "Zoho Books refused the bill: the expense account was deleted.",
      failedAt: "2026-11-04T07:40:00.000Z",
    },
  ],
};

export function seedSettings(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(settingsKeys.company(org), COMPANY_DETAILS);
  client.setQueryData(
    settingsKeys.archivedCategories(org),
    ARCHIVED_CATEGORIES,
  );
  client.setQueryData(
    settingsKeys.archivedPaidFromAccounts(org),
    ARCHIVED_ACCOUNTS,
  );
  client.setQueryData(settingsKeys.zoho(org), ZOHO_STATUS);
  if (client.getQueryData(queryKeys.categories(org)) === undefined) {
    client.setQueryData(queryKeys.categories(org), SETTINGS_CATEGORIES);
  }
  if (client.getQueryData(billKeys.paidFromAccounts(org)) === undefined) {
    client.setQueryData(billKeys.paidFromAccounts(org), SETTINGS_ACCOUNTS);
  }
}
