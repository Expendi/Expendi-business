import type { Metadata } from "next";
import type { JSX } from "react";

import { PlaceholderPage } from "~/components/placeholder-page";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage(): JSX.Element {
  return <PlaceholderPage title="Approvals" task="T47" />;
}
