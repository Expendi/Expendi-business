import type { JSX, ReactNode } from "react";

/**
 * The bar stuck to the bottom of the results while rows can be selected,
 * e.g. "3 selected · ≈ KES 92,400" with "Select all payable" and "Pay all 3".
 */
export function SelectionBar({
  summary,
  links,
  action,
}: {
  summary: ReactNode;
  /** `TextLinkButton`s, e.g. "Select all payable" and "Clear selection". */
  links?: ReactNode;
  action: ReactNode;
}): JSX.Element {
  return (
    <div
      aria-live="polite"
      className="sticky bottom-0 z-5 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-gray-200 bg-surface px-4 py-3 text-sm shadow-selection-bar"
    >
      <div className="min-w-0 flex-[1_1_220px] [&_strong]:font-(--w-name)">
        <p>{summary}</p>
        {links ? (
          <p className="mt-0.5 flex flex-wrap gap-x-3.5 gap-y-1 text-xs leading-4">
            {links}
          </p>
        ) : null}
      </div>
      {action}
    </div>
  );
}
