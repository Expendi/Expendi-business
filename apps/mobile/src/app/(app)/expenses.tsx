import type { JSX } from "react";

import { RequireAdmin } from "~/features/company/require-admin";
import { ExpensesScreen } from "~/features/spending/expenses-screen";

export default function ExpensesRoute(): JSX.Element {
  return (
    <RequireAdmin>{(company) => <ExpensesScreen company={company} />}</RequireAdmin>
  );
}
