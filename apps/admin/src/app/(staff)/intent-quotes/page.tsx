import { Suspense } from "react";

import { IntentQuoteQueueView } from "./_components/intent-quote-queue-view";

/** The company filter lives in the URL, which the view reads on the client. */
export default function IntentQuotesPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <IntentQuoteQueueView />
    </Suspense>
  );
}
