import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { BillsView } from "./_components/bills-view";

export const metadata: Metadata = { title: "Bills" };

export default function BillsPage(): JSX.Element {
  return (
    <Suspense>
      <BillsView />
    </Suspense>
  );
}
