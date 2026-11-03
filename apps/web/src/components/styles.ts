import { buttonVariants } from "~/components/ui/button";

export const inputClass =
  "mt-2 min-h-11 w-full min-w-0 max-w-full rounded-lg border border-input bg-card px-3 py-2.5 text-base text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/20 focus-visible:outline-none disabled:cursor-not-allowed disabled:bg-muted disabled:opacity-60 md:text-sm";

export const primaryButton = buttonVariants();

export const secondaryButton = buttonVariants({ variant: "outline" });

export const textButton = buttonVariants({
  variant: "link",
  className: "h-auto p-0",
});

export const cardClass =
  "w-full min-w-0 max-w-sm rounded-xl border border-border bg-card p-6 sm:p-8";

export const alertClass =
  "mt-4 rounded-md bg-error-50 px-3 py-2 text-sm text-error-700";

export const linkClass =
  "font-medium text-accent-foreground underline-offset-4 hover:underline";

export const tableClass = "w-full text-left text-sm";
export const headCellClass =
  "h-11 px-4 py-3 text-xs font-medium whitespace-nowrap text-muted-foreground";
export const cellClass = "px-4 py-3 align-middle";
