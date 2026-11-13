import type { JSX } from "react";

import { Callout } from "~/components/data/detail-sheet";
import { Button } from "~/components/ui/button";
import { describeApiError } from "~/lib/api";

/** A form's choices that didn't load, with a way to load them again. */
export function LoadAgain({
  error,
  label,
  onRetry,
}: {
  error: unknown;
  label: string;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div role="alert">
      <Callout
        tone="error"
        action={
          <Button type="button" variant="outline" size="md" onClick={onRetry}>
            {label}
          </Button>
        }
      >
        <p>{describeApiError(error)}</p>
      </Callout>
    </div>
  );
}
