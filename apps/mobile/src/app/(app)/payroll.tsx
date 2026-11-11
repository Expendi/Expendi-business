import type { JSX } from "react";

import { RequireAdmin } from "~/features/company/require-admin";
import { PayrollScreen } from "~/features/payroll/payroll-screen";

export default function PayrollRoute(): JSX.Element {
  return (
    <RequireAdmin>
      {(company) => <PayrollScreen company={company} />}
    </RequireAdmin>
  );
}
