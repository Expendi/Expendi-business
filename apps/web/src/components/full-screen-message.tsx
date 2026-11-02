import type { JSX, ReactNode } from "react";

export function FullScreenMessage({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="text-center text-sm text-stone-600">{children}</div>
    </main>
  );
}
