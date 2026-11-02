import type { JSX } from "react";

import { secondaryButton } from "~/components/styles";
import { describeApiError } from "~/lib/api";

/** A read that failed, with a way to ask again. */
export function QueryError({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}): JSX.Element {
  return (
    <div className="text-sm text-error-700" role="alert">
      <p>{describeApiError(error)}</p>
      <button
        type="button"
        onClick={onRetry}
        className={`mt-2 ${secondaryButton}`}
      >
        Try again
      </button>
    </div>
  );
}
