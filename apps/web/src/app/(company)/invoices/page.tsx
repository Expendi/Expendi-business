import type { Metadata } from "next";
import type { JSX } from "react";
import { Suspense } from "react";

import { InvoicesView } from "./_components/invoices-view";

export const metadata: Metadata = { title: "Invoices" };

export default function InvoicesPage(): JSX.Element {
  return (
    <Suspense>
      <InvoicesView />
    </Suspense>
  );
}
