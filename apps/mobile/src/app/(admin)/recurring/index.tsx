import type { JSX } from "react";

import { RequireAdmin } from "~/features/company/require-admin";
import { RecurringScreen } from "~/features/recurring/recurring-screen";

export default function RecurringItemsRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <RecurringScreen company={company} />}
    </RequireAdmin>
  );
}
