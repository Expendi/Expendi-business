import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { ExpensesView } from "./_components/expenses-view";

export const metadata: Metadata = { title: "Expenses" };

/** The filters live in the URL, which the view reads on the client. */
export default function ExpensesPage(): JSX.Element {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <ExpensesView />
    </Suspense>
  );
}
