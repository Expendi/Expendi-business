"use client";

import type { JSX } from "react";
import { useState } from "react";

import { secondaryButton } from "~/components/styles";

type CopyState = "idle" | "copied" | "failed";

/** Copies `value`, e.g. the deposit address, and says whether it worked. */
export function CopyButton({
  value,
  label = "Copy",
}: {
  value: string;
  label?: string;
}): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  function copy() {
    // Inside the promise, so a browser without the clipboard API (or an
    // insecure origin) shows the fallback instead of throwing.
    Promise.resolve()
      .then(() => navigator.clipboard.writeText(value))
      .then(
        () => setState("copied"),
        () => setState("failed"),
      );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={copy} className={secondaryButton}>
        {label}
      </button>
      <span role="status" className="text-sm text-stone-600">
        {state === "copied"
          ? "Copied"
          : state === "failed"
            ? "Couldn't copy. Select it and copy it instead."
            : null}
      </span>
    </span>
  );
}
