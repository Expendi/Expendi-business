import { cn } from "cn";

import { buttonVariants } from "~/components/ui/button";

export const inputClass =
  "mt-2 min-h-11 w-full min-w-0 max-w-full rounded-lg border border-input bg-card px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm";

const actionLayout =
  "h-auto min-h-11 min-w-0 max-w-full py-2.5 text-center whitespace-normal wrap-anywhere";

export const primaryButton = cn(buttonVariants(), actionLayout);

export const secondaryButton = cn(
  buttonVariants({ variant: "outline" }),
  actionLayout,
);

/** For the last step of something that changes a company's payouts. */
export const dangerButton = cn(
  buttonVariants({ variant: "destructive" }),
  actionLayout,
);

export const linkClass =
  "font-medium wrap-anywhere text-accent-foreground underline-offset-4 hover:underline";

export const tableClass = "w-full text-left text-sm";
export const headCellClass =
  "h-11 px-4 py-3 text-xs font-medium whitespace-nowrap text-muted-foreground";
export const cellClass = "px-4 py-3 align-middle";
