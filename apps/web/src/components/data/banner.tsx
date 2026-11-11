import type { LucideIcon } from "lucide-react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { cn } from "cn";
import { CircleCheckIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";

export type BannerTone = "neutral" | "success" | "warn";

const ICONS: Record<BannerTone, LucideIcon> = {
  neutral: InfoIcon,
  success: CircleCheckIcon,
  warn: TriangleAlertIcon,
};

const ICON_TONES: Record<BannerTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-success-700",
  warn: "text-warn-600",
};

/** Banners stacked under the page header; renders nothing when empty. */
export function Banners({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="mt-4 flex flex-col gap-3 empty:hidden">{children}</div>
  );
}

/**
 * A page-level message on a white panel: a payment's result, or a step to
 * take first (e.g. setting up the approval passkey). Pass `role` ("status"
 * or "note") and an `aria-label` as the message needs.
 */
export function Banner({
  tone = "neutral",
  icon,
  title,
  children,
  actions,
  className,
  ...props
}: Omit<ComponentProps<"div">, "title"> & {
  tone?: BannerTone;
  icon?: LucideIcon;
  title: ReactNode;
  /** Body paragraphs, in the secondary text colour. */
  children?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  const Icon = icon ?? ICONS[tone];
  return (
    <div
      className={cn(
        "flex flex-wrap items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-sm",
        className,
      )}
      {...props}
    >
      <Icon
        aria-hidden="true"
        className={cn("mt-px size-5 shrink-0", ICON_TONES[tone])}
      />
      <div className="min-w-0 flex-[1_1_280px] [&>p+p]:mt-0.5 [&>p+p]:text-muted-foreground">
        <p className="font-(--w-title)">{title}</p>
        {typeof children === "string" ? <p>{children}</p> : children}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}
