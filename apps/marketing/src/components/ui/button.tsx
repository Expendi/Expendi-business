import type { JSX, ReactNode } from "react";

import { cn } from "~/lib/utils";

interface ButtonLinkProps {
  href: string;
  variant: "primary" | "secondary";
  children: ReactNode;
  className?: string;
}

/**
 * Qonto `.btn`: 8px radius, 12px/16px padding (11px block for the 1px-bordered
 * secondary), 16/26 type that becomes 18/28 from 768px. Colours flip when an
 * ancestor carries `.darkmode` (see `globals.css`).
 */
export function ButtonLink({
  href,
  variant,
  children,
  className,
}: ButtonLinkProps): JSX.Element {
  return (
    <a
      href={href}
      className={cn(
        "btn",
        variant === "primary" ? "btn-primary" : "btn-secondary",
        className,
      )}
    >
      <span>{children}</span>
    </a>
  );
}
