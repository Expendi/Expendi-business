import type { JSX } from "react";

import { RequireAdmin } from "~/features/company/require-admin";
import { ApprovalsScreen } from "~/features/review/approvals-screen";

export default function ApprovalsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <ApprovalsScreen company={company} />}
    </RequireAdmin>
  );
}
