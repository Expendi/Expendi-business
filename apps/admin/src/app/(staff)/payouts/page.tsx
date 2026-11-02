import { Suspense } from "react";

import { PayoutQueueView } from "./_components/payout-queue-view";

/** The filters live in the URL, which the view reads on the client. */
export default function PayoutsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-stone-500">Loading…</p>}>
      <PayoutQueueView />
    </Suspense>
  );
}
