import type { StaffPayoutDetail } from "@expendi-business/shared";

import type { DataTableColumnDef } from "~/components/data/data-table";
import { plainColumn } from "~/components/plain-column";
import { formatNairobiTime, formatUsdc } from "~/lib/format";

export type LedgerRow = StaffPayoutDetail["ledger"][number];

export const ledgerColumns: DataTableColumnDef<LedgerRow>[] = [
  plainColumn<LedgerRow>({
    id: "when",
    title: "When",
    value: (row) => formatNairobiTime(row.createdAt),
  }),
  plainColumn<LedgerRow>({
    id: "type",
    title: "Type",
    value: (row) => row.type,
  }),
  plainColumn<LedgerRow>({
    id: "amount",
    title: "Amount",
    value: (row) => formatUsdc(row.usdcAmount),
    cell: (row) => (
      <span className="tabular-nums">{formatUsdc(row.usdcAmount)}</span>
    ),
  }),
  plainColumn<LedgerRow>({
    id: "transaction",
    title: "Transaction",
    value: (row) => row.txHash ?? "—",
    cell: (row) => (
      <span className="font-mono text-xs break-all">{row.txHash ?? "—"}</span>
    ),
    meta: { kind: "main", className: "min-w-48 max-w-80 whitespace-normal" },
  }),
];
