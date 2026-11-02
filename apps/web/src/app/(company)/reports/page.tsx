import type { Metadata } from "next";
import type { JSX } from "react";

import { ReportsView } from "./_components/reports-view";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage(): JSX.Element {
  return <ReportsView />;
}
