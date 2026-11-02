import { Suspense } from "react";

import { CompaniesView } from "./_components/companies-view";

/** The search lives in the URL, which the view reads on the client. */
export default function CompaniesPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <CompaniesView />
    </Suspense>
  );
}
