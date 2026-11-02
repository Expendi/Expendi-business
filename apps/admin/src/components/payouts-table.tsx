import Link from "next/link";

import type { StaffPayoutSummary } from "@expendi-business/shared";

import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";
import { PayoutStatusBadge } from "./payout-status";
import { cellClass, headCellClass, linkClass, tableClass } from "./styles";

/** What a payout pays: a claim, bill, float or withdrawal, or pay in a payroll run. */
export function subjectLabel(payout: StaffPayoutSummary): string {
  return payout.payrollRunId ? "payroll run" : payout.subjectType;
}

export function PayoutsTable({
  payouts,
  showCompany,
}: {
  payouts: readonly StaffPayoutSummary[];
  showCompany: boolean;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
      <table className={tableClass}>
        <thead className="bg-stone-100 text-stone-600">
          <tr>
            <th scope="col" className={headCellClass}>
              Created
            </th>
            {showCompany ? (
              <th scope="col" className={headCellClass}>
                Company
              </th>
            ) : null}
            <th scope="col" className={headCellClass}>
              For
            </th>
            <th scope="col" className={headCellClass}>
              Amount
            </th>
            <th scope="col" className={headCellClass}>
              Status
            </th>
            <th scope="col" className={headCellClass}>
              Paycrest order / reason
            </th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((payout) => (
            <tr key={payout.id} className="border-t border-stone-200 align-top">
              <td className={`${cellClass} whitespace-nowrap`}>
                <Link href={`/payouts/${payout.id}`} className={linkClass}>
                  {formatNairobiTime(payout.createdAt)}
                </Link>
              </td>
              {showCompany ? (
                <td className={cellClass}>
                  <Link
                    href={`/companies/${payout.organization.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {payout.organization.name}
                  </Link>
                </td>
              ) : null}
              <td className={cellClass}>
                {subjectLabel(payout)}
                <span className="block text-xs text-stone-500">
                  {payout.method.replace("_", " ")} via {payout.provider}
                </span>
              </td>
              <td className={`${cellClass} whitespace-nowrap`}>
                {payout.method === "usdc" && payout.amountToTransferUsdc
                  ? formatUsdc(payout.amountToTransferUsdc)
                  : formatKesCents(payout.amountKesCents)}
              </td>
              <td className={cellClass}>
                <PayoutStatusBadge status={payout.status} />
              </td>
              <td className={`${cellClass} max-w-sm`}>
                {payout.providerOrderId ? (
                  <span className="block font-mono text-xs break-all">
                    {payout.providerOrderId}
                  </span>
                ) : null}
                {payout.failureReason ? (
                  <span className="block text-xs text-stone-600">
                    {payout.failureReason}
                  </span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
