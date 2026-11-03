import Link from "next/link";

import type { StaffPayoutSummary } from "@expendi-business/shared";

import { formatKesCents, formatNairobiTime, formatUsdc } from "~/lib/format";
import { PayoutStatusBadge } from "./payout-status";
import { linkClass } from "./styles";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./ui/table";

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
    <div className="overflow-hidden rounded-xl border border-border bg-card">
      <Table aria-label="Payouts">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Created</TableHead>
            {showCompany ? <TableHead scope="col">Company</TableHead> : null}
            <TableHead scope="col">For</TableHead>
            <TableHead scope="col">Amount</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Paycrest order / reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {payouts.map((payout) => (
            <TableRow key={payout.id}>
              <TableCell>
                <Link href={`/payouts/${payout.id}`} className={linkClass}>
                  {formatNairobiTime(payout.createdAt)}
                </Link>
              </TableCell>
              {showCompany ? (
                <TableCell className="min-w-40 max-w-64 break-words whitespace-normal">
                  <Link
                    href={`/companies/${payout.organization.id}`}
                    className="underline-offset-4 hover:underline"
                  >
                    {payout.organization.name}
                  </Link>
                </TableCell>
              ) : null}
              <TableCell>
                {subjectLabel(payout)}
                <span className="block text-xs text-stone-500">
                  {payout.method.replace("_", " ")} via {payout.provider}
                </span>
              </TableCell>
              <TableCell className="tabular-nums">
                {payout.method === "usdc" && payout.amountToTransferUsdc
                  ? formatUsdc(payout.amountToTransferUsdc)
                  : formatKesCents(payout.amountKesCents)}
              </TableCell>
              <TableCell>
                <PayoutStatusBadge status={payout.status} />
              </TableCell>
              <TableCell className="min-w-56 max-w-sm break-words whitespace-normal">
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
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
