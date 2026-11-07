"use client";

import type { JSX, Ref } from "react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

/** Copies `value`, e.g. the deposit address, and says whether it worked. */
export function CopyButton({
  value,
  label = "Copy",
  ref,
}: {
  value: string;
  label?: string;
  ref?: Ref<HTMLButtonElement>;
}): JSX.Element {
  const [state, setState] = useState<CopyState>("idle");

  useEffect(() => {
    if (state !== "copied") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);

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
    <div className="flex flex-col gap-1.5">
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="md"
        onClick={copy}
        className="w-full"
      >
        {state === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : label}
      </Button>
      <span
        role="status"
        className="text-xs leading-4 text-gray-600 empty:hidden"
      >
        {state === "failed"
          ? "Couldn't copy. Select it and copy it instead."
          : ""}
      </span>
    </div>
  );
}
