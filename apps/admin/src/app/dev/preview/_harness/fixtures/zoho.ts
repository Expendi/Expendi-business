import type {
  AccountingSync,
  AccountingSyncsResponse,
  AccountingSyncStatus,
  ZohoAccountsResponse,
  ZohoOrganization,
  ZohoStatusResponse,
} from "@expendi-business/shared";

import { minutesAgo, sampleId } from "./ids";

export const ZOHO_STATUS: ZohoStatusResponse = {
  configured: true,
  connection: {
    id: sampleId(950),
    status: "active",
    connectedAt: minutesAgo(60 * 24 * 12),
    connectLink: null,
    organization: { id: "20091826431", name: "Mwangaza Logistics Ltd" },
    apiDomain: "https://www.zohoapis.eu",
    paidThroughAccountId: "4600000000000411",
    defaultAccountId: "4600000000000367",
    pettyCashAccountId: "4600000000000433",
    salariesAccountId: null,
    categoryAccounts: [
      {
        categoryId: sampleId(961),
        categoryName: "Fuel",
        accountId: "4600000000000351",
      },
      {
        categoryId: sampleId(962),
        categoryName: "Vehicle repairs",
        accountId: "4600000000000359",
      },
      {
        categoryId: sampleId(963),
        categoryName: "Meals and travel",
        accountId: null,
      },
    ],
    paidFromAccounts: [
      {
        paidFromAccountId: sampleId(971),
        name: "KCB current account",
        kind: "bank",
        accountId: "4600000000000411",
      },
      {
        paidFromAccountId: sampleId(972),
        name: "Fleet fuel card",
        kind: "card",
        accountId: null,
      },
    ],
  },
};

export const ZOHO_ORGANIZATIONS: ZohoOrganization[] = [
  { id: "20091826431", name: "Mwangaza Logistics Ltd", currencyCode: "KES" },
  { id: "20091826877", name: "Mwangaza Holdings (UK)", currencyCode: "GBP" },
];

export const ZOHO_ACCOUNTS: ZohoAccountsResponse = {
  expenseAccounts: [
    {
      id: "4600000000000351",
      name: "Fuel and oil",
      code: "5010",
      type: "expense",
    },
    {
      id: "4600000000000359",
      name: "Repairs and maintenance",
      code: "5020",
      type: "expense",
    },
    {
      id: "4600000000000367",
      name: "Other expenses",
      code: "5990",
      type: "expense",
    },
  ],
  paidThroughAccounts: [
    {
      id: "4600000000000411",
      name: "KCB current account",
      code: null,
      type: "bank",
    },
    { id: "4600000000000433", name: "Petty cash", code: null, type: "cash" },
  ],
};

const SYNCS: AccountingSync[] = [
  {
    id: sampleId(981),
    subjectType: "expense",
    subjectId: sampleId(982),
    subject: {
      expenseKind: "claim",
      label: "Total Energies Westlands",
      date: "2026-11-08",
      amountKesCents: "850000",
    },
    status: "failed",
    attempts: 5,
    lastError: "Zoho rejected the account: it isn't an expense account.",
    externalId: null,
    receiptAttached: false,
    nextAttemptAt: minutesAgo(-30),
    syncedAt: null,
    createdAt: minutesAgo(1900),
    updatedAt: minutesAgo(75),
  },
  {
    id: sampleId(983),
    subjectType: "bill",
    subjectId: sampleId(984),
    subject: null,
    status: "failed",
    attempts: 3,
    lastError: "Zoho didn't answer in time.",
    externalId: null,
    receiptAttached: false,
    nextAttemptAt: minutesAgo(-30),
    syncedAt: null,
    createdAt: minutesAgo(2100),
    updatedAt: minutesAgo(130),
  },
  {
    id: sampleId(985),
    subjectType: "expense",
    subjectId: sampleId(986),
    subject: {
      expenseKind: "float",
      label: "Parking, Upper Hill",
      date: "2026-11-10",
      amountKesCents: "30000",
    },
    status: "pending",
    attempts: 0,
    lastError: null,
    externalId: null,
    receiptAttached: true,
    nextAttemptAt: minutesAgo(-4),
    syncedAt: null,
    createdAt: minutesAgo(25),
    updatedAt: minutesAgo(25),
  },
  {
    id: sampleId(987),
    subjectType: "payroll_run",
    subjectId: sampleId(988),
    subject: null,
    status: "synced",
    attempts: 1,
    lastError: null,
    externalId: "4600000000008812",
    receiptAttached: false,
    nextAttemptAt: minutesAgo(900),
    syncedAt: minutesAgo(880),
    createdAt: minutesAgo(900),
    updatedAt: minutesAgo(880),
  },
];

export function zohoSyncs(
  status: AccountingSyncStatus,
): AccountingSyncsResponse {
  const count = (wanted: AccountingSyncStatus) =>
    SYNCS.filter((sync) => sync.status === wanted).length;
  return {
    counts: {
      pending: count("pending"),
      synced: count("synced"),
      failed: count("failed"),
    },
    syncs: SYNCS.filter((sync) => sync.status === status),
  };
}
