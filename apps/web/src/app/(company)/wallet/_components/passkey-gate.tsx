import type { ReactNode } from "react";

import type { useApprovalPasskeyStatus } from "~/lib/use-approval";
import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";

/** What the approval passkey check shows instead of the form, if anything. */
export function passkeyGate(
  status: ReturnType<typeof useApprovalPasskeyStatus>,
): ReactNode {
  if (status.isPending) {
    return (
      <p className="text-sm text-muted-foreground">
        Checking your approval passkey…
      </p>
    );
  }
  if (status.isError) {
    return (
      <Callout
        tone="error"
        action={
          <Button
            variant="outline"
            size="md"
            onClick={() => void status.refetch()}
          >
            Try again
          </Button>
        }
      >
        {describeApiError(status.error)}
      </Callout>
    );
  }
  if (!status.data.enrolled) {
    return (
      <Callout tone="neutral" title="Set up your approval passkey first">
        Paying needs your approval passkey. Set it up in the Expendi Business
        app; then confirm here with “use a phone or tablet” in your
        browser&apos;s passkey prompt.
      </Callout>
    );
  }
  return null;
}
