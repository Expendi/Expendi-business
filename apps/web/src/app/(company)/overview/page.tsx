import type { Metadata } from "next";
import type { JSX } from "react";

import { OverviewView } from "./_components/overview-view";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage(): JSX.Element {
  return <OverviewView />;
}
