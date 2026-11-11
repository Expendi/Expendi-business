import type { JSX } from "react";

import { Button } from "~/components/ui/button";

export function CursorPager({
  page,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  previousLabel,
  nextLabel,
}: {
  page: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  previousLabel: string;
  nextLabel: string;
}): JSX.Element {
  return (
    <nav
      aria-label="Pages"
      className="flex flex-wrap items-center gap-4 px-4 py-3 text-sm"
    >
      <Button
        type="button"
        variant="outline"
        disabled={!hasPrevious}
        onClick={onPrevious}
      >
        {previousLabel}
      </Button>
      <span className="text-muted-foreground">Page {page}</span>
      <Button
        type="button"
        variant="outline"
        disabled={!hasNext}
        onClick={onNext}
      >
        {nextLabel}
      </Button>
    </nav>
  );
}
