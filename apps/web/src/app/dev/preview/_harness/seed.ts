import type { QueryClient } from "@tanstack/react-query";

import { billKeys, payrollKeys } from "~/features/payment-keys";
import { navCountKeys } from "~/hooks/use-nav-counts";
import { queryKeys } from "~/lib/query-keys";
import { seedActivity } from "./fixtures/activity";
import {
  BILLS_SUMMARY,
  OPEN_BILLS,
  seedBills,
  SETTLED_BILLS,
  WALLET,
} from "./fixtures/bills";
import { seedCards } from "./fixtures/cards";
import { CLAIMS_SUMMARY } from "./fixtures/claims";
import { ORGANIZATION_ID } from "./fixtures/company";
import { seedExpensesAndApprovals } from "./fixtures/expenses";
import { seedInvoices } from "./fixtures/invoices";
import { seedOverview } from "./fixtures/overview";
import { seedPayees } from "./fixtures/payees";
import { PAYROLL_RUNS, seedPayroll } from "./fixtures/payroll";
import { seedReports } from "./fixtures/reports";
import { seedSettings } from "./fixtures/settings";
import { seedTeam } from "./fixtures/team";
import { seedWallet } from "./fixtures/wallet";

/**
 * Every query the shell and the previewed pages read, under the keys their
 * hooks use. A query left out stays loading (the console names it).
 */
export function seedSampleData(client: QueryClient): void {
  const org = ORGANIZATION_ID;
  client.setQueryData(billKeys.list(org, "open"), OPEN_BILLS);
  client.setQueryData(billKeys.list(org, "history"), SETTLED_BILLS);
  client.setQueryData(billKeys.kesRate(org), WALLET);
  client.setQueryData(navCountKeys.billsSummary(org), BILLS_SUMMARY);
  client.setQueryData(navCountKeys.claimsSummary(org), CLAIMS_SUMMARY);
  client.setQueryData(payrollKeys.runs(org), PAYROLL_RUNS);
  client.setQueryData(queryKeys.approvalPasskey, {
    enrolled: true,
    enrolledAt: "2026-10-01T09:00:00.000Z",
  });
  seedBills(client);
  seedInvoices(client);
  seedCards(client);
  seedTeam(client);
  seedExpensesAndApprovals(client);
  seedOverview(client);
  seedPayroll(client);
  seedPayees(client);
  seedReports(client);
  seedWallet(client);
  seedSettings(client);
  seedActivity(client);
}
