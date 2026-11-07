import type { ComponentProps, JSX, ReactNode } from "react";
import { cn } from "cn";

import { Button } from "~/components/ui/button";

/** The brand-800 underlined link style, for buttons and `next/link` alike. */
export const textLinkClass =
  "rounded-[4px] p-0 font-(--w-ui) text-brand-800 underline decoration-brand-100 underline-offset-3 hover:decoration-current";

export function TextLinkButton({
  className,
  type = "button",
  ...props
}: ComponentProps<"button">): JSX.Element {
  return (
    <button
      type={type}
      className={cn("border-0 bg-transparent", textLinkClass, className)}
      {...props}
    />
  );
}

/** A 36px square icon button with a required accessible name. */
export function IconButton({
  label,
  children,
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "size" | "aria-label"> & {
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button variant="quiet" size="icon-md" aria-label={label} {...props}>
      {children}
    </Button>
  );
}
