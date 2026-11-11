import type { JSX } from "react";

import { RequireCompany } from "~/features/claims/require-company";
import { MyPayScreen } from "~/features/payroll/my-pay-screen";

export default function SalaryPaymentsRoute(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <MyPayScreen company={company} layout="stack" />}
    </RequireCompany>
  );
}
