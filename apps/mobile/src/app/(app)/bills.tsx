import type { JSX } from "react";

import { RequireAdmin } from "~/features/company/require-admin";
import { BillsScreen } from "~/features/bills/bills-screen";

export default function BillsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <BillsScreen company={company} />}
    </RequireAdmin>
  );
}
