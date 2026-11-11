import { Suspense } from "react";

import { AuditLogView } from "./_components/audit-log-view";

/** The search lives in the URL, which the view reads on the client. */
export default function AuditLogPage() {
  return (
    <Suspense
      fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
    >
      <AuditLogView />
    </Suspense>
  );
}
