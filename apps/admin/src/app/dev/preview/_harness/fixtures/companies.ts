import type {
  CompanyDetail,
  CompanySummary,
  ControlsResponse,
} from "@expendi-business/shared";

import { minutesAgo, sampleId } from "./ids";

export const COMPANY_ID = sampleId(1);
export const PAUSED_COMPANY_ID = sampleId(4);

export const COMPANIES: CompanySummary[] = [
  {
    id: COMPANY_ID,
    name: "Mwangaza Logistics",
    kraPin: "P051234567X",
    payoutsPaused: false,
    createdAt: "2026-03-04T07:10:00.000Z",
  },
  {
    id: sampleId(2),
    name: "Kilimo Fresh Produce Ltd",
    kraPin: "P052198304K",
    payoutsPaused: false,
    createdAt: "2026-04-18T11:42:00.000Z",
  },
  {
    id: sampleId(3),
    name: "Savannah Print Works",
    kraPin: "P051877102B",
    payoutsPaused: false,
    createdAt: "2026-06-02T09:05:00.000Z",
  },
  {
    id: PAUSED_COMPANY_ID,
    name: "Pwani Coastal Tours",
    kraPin: "P050663921M",
    payoutsPaused: true,
    createdAt: "2026-07-21T13:30:00.000Z",
  },
  {
    id: sampleId(5),
    name: "Nairobi Dental Care",
    kraPin: null,
    payoutsPaused: false,
    createdAt: "2026-09-29T06:55:00.000Z",
  },
];

const [MWANGAZA_LOGISTICS] = COMPANIES;

export function companySummary(id: string): CompanySummary {
  const found = COMPANIES.find((company) => company.id === id);
  if (found) return found;
  if (!MWANGAZA_LOGISTICS) throw new Error("The sample companies are empty");
  return MWANGAZA_LOGISTICS;
}

export const CONTROLS: ControlsResponse = {
  platformPayoutsPaused: false,
  platformUpdatedAt: "2026-10-27T05:12:00.000Z",
  pausedCompanies: COMPANIES.filter((company) => company.payoutsPaused),
};

export function companyDetail(
  id: string,
  recentPayouts: CompanyDetail["recentPayouts"],
): CompanyDetail {
  const summary = companySummary(id);
  return {
    id: summary.id,
    name: summary.name,
    kraPin: summary.kraPin,
    createdAt: summary.createdAt,
    payoutsPaused: summary.payoutsPaused,
    platformPayoutsPaused: false,
    dailyPayoutCapKesCents: "50000000",
    members: [
      {
        id: sampleId(101),
        name: "Wanjiru Kamau",
        email: "wanjiru@mwangaza.co.ke",
        role: "admin",
        status: "active",
      },
      {
        id: sampleId(102),
        name: "Otieno Barasa",
        email: "otieno@mwangaza.co.ke",
        role: "accountant",
        status: "active",
      },
      {
        id: sampleId(103),
        name: "Halima Yusuf",
        email: "halima@mwangaza.co.ke",
        role: "employee",
        status: "active",
      },
      {
        id: sampleId(104),
        name: null,
        email: "brian.mutua@mwangaza.co.ke",
        role: "employee",
        status: "invited",
      },
    ],
    wallet: {
      chain: "near",
      status: "active",
      address:
        "31b95d2eb4c4aaa56d63b85728c30cbd243b7850f04510624692af892d8026f8",
      usdcBalance: "1842500000",
      balanceHome: "confidential_account",
      confidentialUsdc: "1842500000",
      confidentialUsdcReadAt: minutesAgo(3),
      kesEquivalent: { kesCents: "23768250000", rate: "129" },
    },
    unpaidClaims: { count: 6, totalKesCents: "8745000" },
    recentPayouts: recentPayouts.filter(
      (payout) => payout.organization.id === summary.id,
    ),
  };
}
