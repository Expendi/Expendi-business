import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { ApprovalsView } from "./_components/approvals-view";

export const metadata: Metadata = { title: "Approvals" };

/** The open reimbursement lives in the URL (`?claimId=`), which the view reads on the client. */
export default function ApprovalsPage(): JSX.Element {
  return (
    <Suspense>
      <ApprovalsView />
    </Suspense>
  );
}
