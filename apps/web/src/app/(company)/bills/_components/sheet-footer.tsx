"use client";

import type { JSX, ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A form's buttons, rendered into the side sheet's footer (`slot`) so they
 * stay at the bottom while the form scrolls. Without a slot (a form shown
 * on its own) they follow the form.
 */
export function SheetFooterPortal({
  slot,
  children,
}: {
  slot: HTMLElement | null;
  children: ReactNode;
}): JSX.Element {
  if (slot) return createPortal(children, slot);
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}
