/** DEV PREVIEW — Mawingu Labs on Wed 11 Nov 2026 (docs/mocks/mobile/DIRECTION.md). */
import type { CashObligation, SpendingOverview } from "@expendi-business/shared";

const FIBRE: CashObligation = {
  id: "b1",
  kind: "bill",
  name: "Safaricom Fibre",
  dueOn: "2026-11-09",
  amountKes: "899900",
  status: "overdue",
  payVia: "expendi",
  needsAmount: false,
  heading: "subscriptions",
};
const RENT: CashObligation = {
  id: "b2",
  kind: "bill",
  name: "Office rent",
  dueOn: "2026-11-11",
  amountKes: "8500000",
  status: "due",
  payVia: "expendi",
  needsAmount: false,
  heading: "transactions",
};

export const PREVIEW_OVERVIEW: SpendingOverview = {
  month: "2026-11",
  previousMonth: "2026-10",
  currentKes: "13083550",
  previousKes: "73508400",
  headings: [
    { id: "transactions", name: "Transactions", currentKes: "9620750", previousKes: "41200000" },
    { id: "subscriptions", name: "Subscriptions", currentKes: "1814000", previousKes: "1790000" },
    { id: "petty_cash", name: "Petty cash", currentKes: "1648800", previousKes: "2086300" },
    { id: "salaries", name: "Salaries & personnel", currentKes: "0", previousKes: "21432100" },
  ],
  categories: [
    { id: "c-meals", name: "Meals & entertainment", currentKes: "1458000", previousKes: "980000" },
    { id: "c-travel", name: "Travel", currentKes: "1067000", previousKes: "1324000" },
    { id: "c-software", name: "Software", currentKes: "1814000", previousKes: "1790000" },
  ],
  recentPayments: [
    { id: "p1", subjectId: "s1", kind: "float", name: "Fuel, Total Ngong Rd", date: "2026-11-10", amountKes: "450000", heading: "petty_cash", categoryId: "c-travel", categoryName: "Travel", personId: "u-joseph", channel: "float" },
    { id: "p2", subjectId: "s2", kind: "claim", name: "Naivas Westlands", date: "2026-11-06", amountKes: "218000", heading: "transactions", categoryId: "c-meals", categoryName: "Meals & entertainment", personId: "u-brian", channel: "expendi" },
    { id: "p3", subjectId: "s3", kind: "company", name: "Google Workspace", date: "2026-11-05", amountKes: "602000", heading: "subscriptions", categoryId: "c-software", categoryName: "Software", personId: null, channel: "outside" },
    { id: "p4", subjectId: "s4", kind: "bill", name: "Rhapta Road Properties", date: "2026-11-02", amountKes: "8500000", heading: "transactions", categoryId: "c-rent", categoryName: "Rent", personId: null, channel: "expendi" },
  ],
  people: [
    { id: "u-brian", name: "Brian Otieno" },
    { id: "u-joseph", name: "Joseph Kariuki" },
  ],
  outstanding: {
    overdue: [FIBRE],
    dueToday: [RENT],
    claims: [
      { id: "c1", name: "Brian Otieno", amountKes: "124000", floatId: null },
      { id: "c2", name: "Achieng' Odhiambo", amountKes: "325000", floatId: null },
      { id: "c3", name: "Kevin Mwangi", amountKes: "687000", floatId: null },
    ],
    noReceipt: [
      { id: "n1", name: "Fuel, Total Ngong Rd", amountKes: "450000", floatId: "fl1" },
    ],
  },
  cash: {
    today: "2026-11-11",
    through: "2026-12-10",
    totalKes: "31894000",
    unknownAmounts: 1,
    obligations: [
      FIBRE,
      RENT,
      { id: "f1", kind: "forecast", name: "Zoho Books", dueOn: "2026-11-15", amountKes: "312000", status: "scheduled", payVia: "expendi", needsAmount: false, heading: "subscriptions" },
      { id: "b3", kind: "bill", name: "KPLC postpaid", dueOn: "2026-11-20", amountKes: null, status: "awaiting_amount", payVia: "expendi", needsAmount: true, heading: "transactions" },
      { id: "p1", kind: "payroll", name: "Payroll", dueOn: "2026-11-28", amountKes: "21432100", status: "scheduled", payVia: "expendi", needsAmount: false, heading: "salaries" },
      { id: "f2", kind: "forecast", name: "AWS", dueOn: "2026-12-01", amountKes: "750000", status: "scheduled", payVia: "expendi", needsAmount: false, heading: "subscriptions" },
    ],
    balanceUsdc: "3412580000",
    reservedUsdc: "0",
    balanceKes: "44022282",
    availableKes: "12128282",
    rate: "129.00",
    status: "covered",
    shortKes: null,
    outsideKes: "0",
  },
};
