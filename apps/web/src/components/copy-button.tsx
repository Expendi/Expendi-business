"use client";

import type { JSX, Ref } from "react";
import { cn } from "cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "~/components/ui/button";

type CopyState = "idle" | "copied" | "failed";

/** Copies `value`, e.g. the deposit address, and says whether it worked. */
export function CopyButton({
  value,
  label = "Copy",
  what,
  wide = true,
  ref,
}: {
  value: string;
  label?: string;
  /** Finishes the button's name for screen readers when `label` is short. */
  what?: string;
  /** Fills its column; false sits beside the value it copies. */
  wide?: boolean;
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
    <div className={cn("flex flex-col gap-1.5", !wide && "items-end")}>
      <Button
        ref={ref}
        type="button"
        variant="outline"
        size="md"
        onClick={copy}
        className={wide ? "w-full" : undefined}
      >
        {state === "copied" ? (
          <CheckIcon aria-hidden="true" />
        ) : (
          <CopyIcon aria-hidden="true" />
        )}
        {state === "copied" ? "Copied" : label}
        {what && state !== "copied" ? (
          <span className="sr-only"> {what}</span>
        ) : null}
      </Button>
      <span
        role="status"
        className="text-xs leading-4 text-muted-foreground empty:hidden"
      >
        {state === "failed"
          ? "Couldn't copy. Select it and copy it instead."
          : ""}
      </span>
    </div>
  );
}
