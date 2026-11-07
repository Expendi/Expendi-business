import type { LucideIcon } from "lucide-react";
import type { JSX, ReactNode } from "react";
import { InfoIcon } from "lucide-react";

/** A quiet line of help in a sheet, after a muted icon. */
export function Note({
  icon: Icon = InfoIcon,
  children,
}: {
  icon?: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <p className="flex items-start gap-2 text-gray-600">
      <Icon
        aria-hidden="true"
        className="mt-0.5 size-4 shrink-0 text-gray-500"
      />
      <span>{children}</span>
    </p>
  );
}
