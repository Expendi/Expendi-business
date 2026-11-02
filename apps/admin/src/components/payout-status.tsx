import type { PayoutStatus } from "@expendi-business/shared";

const STYLES: Partial<Record<PayoutStatus, string>> = {
  needs_review: "bg-amber-100 text-amber-900",
  failed: "bg-error-50 text-error-700",
  paid: "bg-emerald-50 text-emerald-800",
};

export function PayoutStatusBadge({ status }: { status: PayoutStatus }) {
  return (
    <span
      className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${STYLES[status] ?? "bg-stone-100 text-stone-700"}`}
    >
      {status.replace("_", " ")}
    </span>
  );
}
