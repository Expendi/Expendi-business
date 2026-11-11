/** DEV PREVIEW — admin Home and its cash states. */
import type { JSX } from "react";

import type { PreviewArea } from "../types";
import { AdminHome } from "~/features/overview/admin-home";
import { PREVIEW_OVERVIEW } from "../overview-fixture";
import { previewSession } from "../session";
import { PREVIEW_FAIL, PREVIEW_PENDING } from "../types";

const OVERVIEW = /\/overview(\?|$)/;

function Home(): JSX.Element {
  const { state } = previewSession("admin");
  if (state.status !== "ready") throw new Error("preview session");
  return <AdminHome me={state.me} company={state.company} canSwitchCompany={false} />;
}

export const HOME_AREA: PreviewArea = {
  routes: [{ path: OVERVIEW, data: PREVIEW_OVERVIEW }],
  screens: [
    { key: "home", name: "Home", role: "admin", tab: "index", render: Home },
    {
      key: "home-short",
      name: "Home · short",
      role: "admin",
      tab: "index",
      routes: [
        {
          path: OVERVIEW,
          data: {
            ...PREVIEW_OVERVIEW,
            cash: { ...PREVIEW_OVERVIEW.cash, status: "short", availableKes: "-1450000", shortKes: "1450000", balanceKes: "30444000", balanceUsdc: "2360000000" },
          },
        },
      ],
      render: Home,
    },
    {
      key: "home-norate",
      name: "Home · no rate",
      role: "admin",
      tab: "index",
      routes: [
        {
          path: OVERVIEW,
          data: {
            ...PREVIEW_OVERVIEW,
            cash: { ...PREVIEW_OVERVIEW.cash, status: "unknown", rate: null, availableKes: null, balanceKes: null, shortKes: null },
          },
        },
      ],
      render: Home,
    },
    {
      key: "home-empty",
      name: "Home · nothing due",
      role: "admin",
      tab: "index",
      routes: [
        {
          path: OVERVIEW,
          data: {
            ...PREVIEW_OVERVIEW,
            outstanding: { overdue: [], dueToday: [], claims: [], noReceipt: [] },
            cash: { ...PREVIEW_OVERVIEW.cash, obligations: [], totalKes: "0", unknownAmounts: 0, availableKes: "44022282" },
          },
        },
      ],
      render: Home,
    },
    { key: "home-loading", name: "Home · loading", role: "admin", tab: "index", routes: [{ path: OVERVIEW, data: PREVIEW_PENDING }], render: Home },
    { key: "home-error", name: "Home · error", role: "admin", tab: "index", routes: [{ path: OVERVIEW, data: PREVIEW_FAIL }], render: Home },
  ],
};
