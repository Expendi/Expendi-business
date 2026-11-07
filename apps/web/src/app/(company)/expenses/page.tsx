import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { ExpensesView } from "./_components/expenses-view";

export const metadata: Metadata = { title: "Expenses" };

/** The filters and the open expense live in the URL, which the view reads on the client. */
export default function ExpensesPage(): JSX.Element {
  return (
    <Suspense>
      <ExpensesView />
    </Suspense>
  );
}
