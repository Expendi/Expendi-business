import type { JSX } from "react";

import { RequireCompany } from "~/features/claims/require-company";
import { MyPettyCashScreen } from "~/features/petty-cash/my-petty-cash-screen";

export default function Route(): JSX.Element {
  return (
    <RequireCompany>
      {(company) => <MyPettyCashScreen company={company} layout="tab" />}
    </RequireCompany>
  );
}
