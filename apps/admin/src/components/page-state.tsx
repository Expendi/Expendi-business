import type { ReactNode } from "react";

import { Alert, AlertDescription } from "~/components/ui/alert";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "~/components/ui/empty";
import { Skeleton } from "~/components/ui/skeleton";

export function PageLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-label={label} className="mt-6 space-y-4">
      <span className="sr-only">{label}</span>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-32 w-full rounded-xl" />
      <Skeleton className="h-12 w-full rounded-lg" />
    </div>
  );
}

export function PageError({ children }: { children: ReactNode }) {
  return (
    <Alert variant="destructive" className="mt-4">
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

export function PageEmpty({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
}) {
  return (
    <Empty className="mt-4 rounded-xl border border-border bg-card">
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {children ? <EmptyDescription>{children}</EmptyDescription> : null}
      </EmptyHeader>
    </Empty>
  );
}
