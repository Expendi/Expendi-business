import type * as React from "react";
import { cn } from "cn";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "min-h-18 w-full min-w-0 max-w-full resize-y rounded-control border border-control-border bg-surface px-3 py-2.5 text-base text-foreground transition-colors outline-none placeholder:text-gray-500 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 aria-invalid:border-error-700 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
