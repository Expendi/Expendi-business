import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Overview" };

export default function OverviewPage(): JSX.Element {
  return <PlaceholderPage title="Overview" task="T50" />;
}
