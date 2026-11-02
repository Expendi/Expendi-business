import type { JSX, ReactNode } from "react";

import { cardClass } from "./styles";

/** Every step before the dashboard: sign-in, the company picker, notices. */
export function CenteredCard({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className={cardClass}>{children}</div>
    </main>
  );
}
