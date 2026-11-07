import type { JSX, ReactNode } from "react";

/** The page title (24/32 at 400), a muted subtitle, and actions on the right. */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4 motion-safe:animate-rise">
      <div className="min-w-0">
        <h1 className="text-2xl leading-8 font-(--w-heading) tracking-[-0.02em] text-gray-900">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-1 max-w-[70ch] text-sm text-gray-600">{subtitle}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap gap-2 max-[600px]:w-full max-[600px]:*:flex-1">
          {actions}
        </div>
      ) : null}
    </div>
  );
}
