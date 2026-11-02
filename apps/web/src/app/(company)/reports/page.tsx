import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Reports" };

export default function ReportsPage(): JSX.Element {
  return <PlaceholderPage title="Reports" task="T51" />;
}
