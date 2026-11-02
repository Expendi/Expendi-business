import type { Metadata } from "next";
import type { JSX } from "react";

import { ApprovalsView } from "./_components/approvals-view";

export const metadata: Metadata = { title: "Approvals" };

export default function ApprovalsPage(): JSX.Element {
  return <ApprovalsView />;
}
