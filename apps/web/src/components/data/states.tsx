import type { LucideIcon } from "lucide-react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { cn } from "cn";
import { CircleAlertIcon, CircleCheckIcon } from "lucide-react";

import { Button } from "~/components/ui/button";

export const NETWORK_ERROR =
  "Couldn't reach Expendi Business. Check your connection and try again.";

/** A gray loading bar; it pulses unless motion is reduced. */
export function Skel({
  width,
  height,
  className,
  style,
}: {
  width: CSSProperties["width"];
  height: CSSProperties["height"];
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "rounded-control bg-muted motion-safe:animate-skeleton",
        className,
      )}
      style={{ width, height, ...style }}
    />
  );
}

/** Nothing to show: an icon, a title at 600, a line of help and an optional action. */
export function EmptyState({
  icon: Icon = CircleCheckIcon,
  title,
  children,
  action,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground">
      <Icon aria-hidden="true" className="size-7 text-muted-foreground" />
      <strong className="text-base leading-6 font-(--w-title) text-foreground">
        {title}
      </strong>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

/** A list or page that didn't load, announced, with "Try again". */
export function ErrorState({
  title,
  children = NETWORK_ERROR,
  onRetry,
  retryLabel = "Try again",
}: {
  title: ReactNode;
  children?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="flex flex-col items-center gap-2 px-6 py-14 text-center text-sm text-muted-foreground"
    >
      <CircleAlertIcon aria-hidden="true" className="size-7 text-error-700" />
      <strong className="text-base leading-6 font-(--w-title) text-foreground">
        {title}
      </strong>
      {children ? <p>{children}</p> : null}
      {onRetry ? (
        <Button variant="outline" size="md" onClick={onRetry}>
          {retryLabel}
        </Button>
      ) : null}
    </div>
  );
}
