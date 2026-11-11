"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import type { StaffPayoutSummary } from "@expendi-business/shared";

import { DataTable, useDataTable } from "~/components/data/data-table";
import { payoutColumns } from "./payout-columns";

export { subjectLabel } from "./payout-columns";

export function PayoutsTable({
  payouts,
  showCompany,
}: {
  payouts: readonly StaffPayoutSummary[];
  showCompany: boolean;
}) {
  const router = useRouter();
  const columns = useMemo(() => payoutColumns(showCompany), [showCompany]);
  const table = useDataTable({
    data: payouts,
    columns,
    getRowId: (payout) => payout.id,
    manual: true,
    paginate: false,
  });
  return (
    <DataTable
      table={table}
      caption="Payouts"
      onRowOpen={(payout) => router.push(`/payouts/${payout.id}`)}
    />
  );
}
